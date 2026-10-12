import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, RoleSelectMenuBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder } from 'discord.js';
import { defaults, type CommandContext, type Registry } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { RULES } from '../core.js';
import { embed } from './ui.js';
import { canManageOwnTrust, RULE_LABELS, scopeName, TRUST_PRESETS, trustListPage } from './antinuke-panel.js';

/**
 * The /antinuke trust manage panel: pick a user or role, tick what anti-nuke should let them do, pick how
 * long, press Save. Saving replaces everything that user or role had before, so what you see is
 * exactly what they get. The whole panel state lives in the component IDs, so nothing is lost
 * between clicks and old panels can never act for someone else.
 */

/** Everything selectable, in display order. Index = bit in the saved mask. */
export const ALLOW_OPTIONS: { value: string; label: string; description?: string }[] = [
    { value: 'all', label: '✅ Everything (full bypass)', description: 'Anti-nuke ignores them completely. Only for people you fully trust.' },
    ...Object.entries(TRUST_PRESETS).map(([key, p]) => ({ value: `preset:${key}`, label: `★ ${p.title}`, description: p.description.slice(0, 100) })),
    ...RULE_LABELS.filter(([key]) => RULES.some(r => r.key === key)).map(([value, label]) => ({ value, label })),
];

export const PANEL_DURATIONS: { hours: number; label: string }[] = [
    { hours: 0, label: 'Permanent (until removed)' }, { hours: 1, label: '1 hour' }, { hours: 24, label: '24 hours' }, { hours: 168, label: '7 days' }, { hours: 720, label: '30 days' },
];

export interface PanelState { target: string | null; role: boolean; mask: number; hours: number }

const toMask = (values: string[]) => values.reduce((m, v) => { const i = ALLOW_OPTIONS.findIndex(o => o.value === v); return i < 0 ? m : m | (1 << i); }, 0);
const fromMask = (mask: number) => ALLOW_OPTIONS.filter((_, i) => mask & (1 << i)).map(o => o.value);

/** The grant kinds a selection stands for: "Everything" wins; presets expand into their rules. */
export function kindsFor(values: string[], role: boolean): string[] {
    const base = role ? 'trust_role' : 'trust';
    if (values.includes('all')) return [base];
    const rules = new Set<string>();
    for (const v of values) for (const r of v.startsWith('preset:') ? TRUST_PRESETS[v.slice(7)]?.rules ?? [] : [v]) rules.add(r);
    return [...rules].map(r => `${base}:${r}`);
}

/** What this user/role has saved right now, expressed as panel selections. */
function currentSelection(ctx: CommandContext, guild: string, target: string, role: boolean): { mask: number; hours: number; kinds: string[] } {
    const base = role ? 'trust_role' : 'trust';
    const rows = ctx.store.all('SELECT kind,expires FROM grants WHERE guild_id=? AND user_id=? AND (kind=? OR kind LIKE ?) AND (expires IS NULL OR expires>?)', guild, target, base, `${base}:%`, Date.now());
    const kinds = rows.map(r => String(r.kind));
    if (!kinds.length) return { mask: 0, hours: 0, kinds };
    const left = Math.max(...rows.map(r => r.expires ? Number(r.expires) - Date.now() : Infinity));
    const hours = Number.isFinite(left) ? PANEL_DURATIONS.reduce((best, d) => d.hours && Math.abs(d.hours * 3600000 - left) < Math.abs(best * 3600000 - left) ? d.hours : best, 24) : 0;
    if (kinds.includes(base)) return { mask: toMask(['all']), hours, kinds };
    const rules = kinds.map(k => k.split(':')[1]!);
    const values: string[] = [];
    const left2 = new Set(rules);
    for (const [key, p] of Object.entries(TRUST_PRESETS)) if (p.rules.every(r => rules.includes(r)) && p.rules.length > 1) { values.push(`preset:${key}`); }
    // Keep only the biggest presets that fit, then list leftover rules on their own.
    const chosen = values.filter(v => !values.some(o => o !== v && TRUST_PRESETS[v.slice(7)]!.rules.every(r => TRUST_PRESETS[o.slice(7)]!.rules.includes(r))));
    for (const v of chosen) for (const r of TRUST_PRESETS[v.slice(7)]!.rules) left2.delete(r);
    return { mask: toMask([...chosen, ...left2]), hours, kinds };
}

const id = (guild: string, user: string, action: string, s: PanelState) =>
    `tp:${guild}:${user}:${action}:${s.target ? `${s.role ? 'r' : 'u'}${s.target}` : '-'}:${s.hours}:${s.mask.toString(36)}`;

export function trustPanel(ctx: CommandContext, guild: string, user: string, s: PanelState, notice = '') {
    const who = s.target ? `<@${s.role ? '&' : ''}${s.target}>` : '*nobody picked yet*';
    const selected = fromMask(s.mask);
    const saved = s.target ? currentSelection(ctx, guild, s.target, s.role) : null;
    const savedText = !saved ? '' : !saved.kinds.length ? 'nothing (anti-nuke watches them like anyone else)'
        : saved.kinds.some(k => !k.includes(':')) ? '**Everything** (full bypass)' : `**${scopeName(saved.kinds.map(k => k.split(':')[1]!))}**`;
    const pending = !selected.length ? '*nothing ticked*' : selected.includes('all') ? '**Everything** (full bypass)' : selected.map(v => ALLOW_OPTIONS.find(o => o.value === v)!.label).join(', ');
    const lines = [
        `**1. Who:** ${who}`,
        `**2. Allowed:** ${pending}`,
        `**3. How long:** ${PANEL_DURATIONS.find(d => d.hours === s.hours)?.label ?? `${s.hours} hours`}`,
        saved ? `\n**Saved right now:** ${savedText}` : '',
        '',
        '-# **Save** replaces what they had with what is ticked. **Remove all** clears every bypass they have. This never gives command permissions; use `/setup staff role` for that.',
        notice ? `\n${notice}` : '',
    ].filter(l => l !== null);
    const danger = selected.some(v => ['all', 'bot_add', 'dangerous_grant', 'member_prune'].includes(v));
    return {
        embeds: [embed('Anti-nuke whitelist', lines.join('\n'), danger ? Colors.Orange : Colors.Blurple)],
        components: [
            new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(id(guild, user, 'user', s)).setPlaceholder(s.target && !s.role ? 'Change user' : 'Pick a user').setMaxValues(1)),
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(id(guild, user, 'role', s)).setPlaceholder(s.target && s.role ? 'Change role' : 'Or pick a role').setMaxValues(1)),
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id(guild, user, 'allow', s)).setPlaceholder('Tick what anti-nuke should let them do').setMinValues(0).setMaxValues(ALLOW_OPTIONS.length)
                .addOptions(...ALLOW_OPTIONS.map(o => ({ label: o.label, value: o.value, ...(o.description ? { description: o.description } : {}), default: selected.includes(o.value) })))),
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id(guild, user, 'time', s)).setPlaceholder('How long')
                .addOptions(...PANEL_DURATIONS.map(d => ({ label: d.label, value: String(d.hours), default: d.hours === s.hours })))),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(id(guild, user, 'save', s)).setLabel('Save').setStyle(ButtonStyle.Success).setDisabled(!s.target || !selected.length),
                new ButtonBuilder().setCustomId(id(guild, user, 'clear', s)).setLabel('Remove all').setStyle(ButtonStyle.Danger).setDisabled(!saved?.kinds.length),
                new ButtonBuilder().setCustomId(id(guild, user, 'list', s)).setLabel('View whitelist').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] as never[] },
    };
}

/** Load a target into the panel with whatever they have saved already ticked. */
export function panelFor(ctx: CommandContext, guild: string, target: string | null, role: boolean): PanelState {
    if (!target) return { target: null, role: false, mask: 0, hours: 0 };
    const now = currentSelection(ctx, guild, target, role);
    return { target, role, mask: now.mask, hours: now.hours };
}

/** Replace a user's/role's bypasses with exactly these selections. */
export function saveTrust(ctx: CommandContext, guild: string, target: string, role: boolean, values: string[], hours: number): string {
    const actor = ctx.actor!;
    // Giving yourself a bypass is what a hijacked admin account would do before a nuke, so someone else must do it.
    if (!canManageOwnTrust(actor.id, actor.guild?.ownerId) && (target === actor.id || role && actor.roles.cache.has(target)))
        throw new AppError('PERMISSION_ERROR', 'Another security administrator (or the server owner) must whitelist you or a role you hold. You can still remove it yourself.');
    if (role && target === guild) throw new AppError('VALIDATION_ERROR', 'You cannot whitelist @everyone.');
    const kinds = kindsFor(values, role);
    if (!kinds.length) throw new AppError('VALIDATION_ERROR', 'Tick at least one thing they are allowed to do.');
    const before = currentSelection(ctx, guild, target, role).kinds;
    ctx.store.transaction(() => {
        for (const k of before) ctx.store.revokeGrant(guild, target, k, actor.id);
        for (const k of kinds) ctx.store.grant(guild, target, k, actor.id, hours || undefined);
    });
    const scope = kinds.some(k => !k.includes(':')) ? 'everything (full bypass)' : scopeName(kinds.map(k => k.split(':')[1]!));
    const time = hours ? PANEL_DURATIONS.find(d => d.hours === hours)?.label ?? `${hours} hours` : 'until removed';
    ctx.logs.push(guild, embed('Whitelist changed', `By <@${actor.id}> · <@${role ? '&' : ''}${target}> may now: **${scope}** · ${time.toLowerCase()}${before.length ? ' (replaced their previous bypass)' : ''}`));
    return `Saved: <@${role ? '&' : ''}${target}> may now do **${scope}** (${time.toLowerCase()}).`;
}

export function clearTrust(ctx: CommandContext, guild: string, target: string, role: boolean): string {
    const kinds = currentSelection(ctx, guild, target, role).kinds;
    if (!kinds.length) throw new AppError('VALIDATION_ERROR', 'They have no anti-nuke bypass to remove.');
    ctx.store.transaction(() => { for (const k of kinds) ctx.store.revokeGrant(guild, target, k, ctx.actor!.id); });
    ctx.logs.push(guild, embed('Whitelist changed', `By <@${ctx.actor!.id}> · removed **every** bypass for <@${role ? '&' : ''}${target}>`, Colors.Orange));
    return `Removed every bypass from <@${role ? '&' : ''}${target}>. Anti-nuke now watches them like anyone else.`;
}

export function registerTrustPanel(registry: Registry) {
    registry.component({ prefix: 'tp:', kinds: ['button', 'select'], metadata: { ...defaults, category: 'security', access: 'security', cooldown: 0 }, execute: async (ctx, i) => {
        const m = /^tp:(\d{17,20}):(\d{17,20}):([a-z]+):(-|[ur]\d{17,20}):(\d{1,4}):([0-9a-z]{1,8})$/.exec(i.customId);
        if (!m || m[1] !== i.guildId || m[2] !== i.user.id) throw new AppError('PERMISSION_ERROR', 'This panel belongs to someone else. Run /antinuke trust manage yourself.');
        const guild = i.guildId, user = i.user.id, action = m[3]!;
        const s: PanelState = { target: m[4] === '-' ? null : m[4]!.slice(1), role: m[4]!.startsWith('r'), hours: Number(m[5]), mask: parseInt(m[6]!, 36) };
        if (action === 'user' || action === 'role') {
            const target = i.values?.[0];
            if (!target || !/^\d{17,20}$/.test(target)) throw new AppError('VALIDATION_ERROR', 'Pick one user or role.');
            if (action === 'role' && target === guild) throw new AppError('VALIDATION_ERROR', 'You cannot whitelist @everyone.');
            return void await i.editReply(trustPanel(ctx, guild, user, panelFor(ctx, guild, target, action === 'role')));
        }
        if (action === 'allow') {
            let values = (i.values ?? []).filter((v: string) => ALLOW_OPTIONS.some(o => o.value === v));
            // "Everything" already covers the rest, so keep the panel honest.
            if (values.includes('all')) values = ['all'];
            return void await i.editReply(trustPanel(ctx, guild, user, { ...s, mask: toMask(values) }));
        }
        if (action === 'time') {
            const hours = Number(i.values?.[0]);
            if (!PANEL_DURATIONS.some(d => d.hours === hours)) throw new AppError('VALIDATION_ERROR', 'Choose one of the listed durations.');
            return void await i.editReply(trustPanel(ctx, guild, user, { ...s, hours }));
        }
        if (action === 'list') return void await i.editReply(trustListPage(ctx, guild, user, 1));
        if (!s.target) throw new AppError('VALIDATION_ERROR', 'Pick a user or role first.');
        if (action === 'save') {
            const done = saveTrust(ctx, guild, s.target, s.role, fromMask(s.mask), s.hours);
            return void await i.editReply(trustPanel(ctx, guild, user, panelFor(ctx, guild, s.target, s.role), `✅ ${done}`));
        }
        if (action === 'clear') {
            const done = clearTrust(ctx, guild, s.target, s.role);
            return void await i.editReply(trustPanel(ctx, guild, user, { ...s, mask: 0 }, `🗑 ${done}`));
        }
        throw new AppError('VALIDATION_ERROR', 'Unknown panel control.');
    } });
}
