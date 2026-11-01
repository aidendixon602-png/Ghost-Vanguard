import { ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder } from 'discord.js';
import { defaults } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { developers } from '../bot/developers.js';
import { RULES } from '../core.js';
import { antinukeStatus } from './antinuke-status.js';
import { embed } from './ui.js';
export function statusPanel(ctx, guild, user) {
    return { embeds: [antinukeStatus(ctx.store, guild)], components: [new ActionRowBuilder().addComponents(...[['refresh', 'Refresh'], ['incidents', 'View Incidents'], ['whitelist', 'Manage Whitelist']].map(([action, label]) => new ButtonBuilder().setCustomId(`anpanel:${guild}:${user}:${action}`).setLabel(label).setStyle(ButtonStyle.Secondary)))], allowedMentions: { parse: [] } };
}
/** Bot owner, configured developers and the server owner may grant bypasses to themselves or roles they hold. */
/** Human label for a grant kind: full bypass, one rule, or verification-bot only. */
/**
 * Whitelist presets: named bundles of rules for common staff jobs. Granting one stores a
 * per-rule bypass for each rule, so every other rule still applies to that person.
 * The highest-risk rules (bot add, permission grant, member prune) are never in a preset;
 * use "all rules" or pick them one by one.
 */
export const TRUST_PRESETS = {
    moderation: { title: 'Basic moderation', description: 'bans, unbans, kicks and timeouts', rules: ['mass_ban', 'mass_unban', 'mass_kick', 'timeout'] },
    roles: { title: 'Role manager', description: 'give ordinary roles, create, edit and delete roles (protected permissions need the permission-grant whitelist)', rules: ['role_grant', 'role_create', 'role_update', 'role_delete'] },
    channels: { title: 'Channel manager', description: 'create, edit and delete channels and webhooks', rules: ['channel_create', 'channel_update', 'channel_delete', 'webhook_change'] },
    administrator: { title: 'Administrator', description: 'everything incl. promoting mods; not Administrator grants, bots or prunes',
        rules: ['mass_ban', 'mass_unban', 'mass_kick', 'timeout', 'role_grant', 'role_create', 'role_update', 'role_delete', 'channel_create', 'channel_update', 'channel_delete', 'webhook_change', 'guild_update', 'automod_tamper', 'emoji_delete'] },
};
/** Single rules, grouped by area and ordered from everyday to dangerous. Join flood is not a person's action, so it is not listed. */
export const RULE_LABELS = [
    ['mass_ban', 'Moderation · Ban members'], ['mass_unban', 'Moderation · Unban members'], ['mass_kick', 'Moderation · Kick members'], ['timeout', 'Moderation · Time out members'],
    ['role_grant', 'Roles · Give roles to people'], ['role_create', 'Roles · Create roles'], ['role_update', 'Roles · Edit roles'], ['role_delete', 'Roles · Delete roles'],
    ['channel_create', 'Channels · Create channels'], ['channel_update', 'Channels · Edit channels and permissions'], ['channel_delete', 'Channels · Delete channels'], ['webhook_change', 'Channels · Webhooks'],
    ['guild_update', 'Server · Edit server settings'], ['automod_tamper', 'Server · Turn off or delete AutoMod'], ['emoji_delete', 'Server · Delete emojis and stickers'],
    ['bot_add', '⚠ Danger · Add bots'], ['dangerous_grant', '⚠ Danger · Grant protected permissions'], ['member_prune', '⚠ Danger · Prune members'],
];
const friendly = (key) => key === 'dangerous_grant' ? 'Permission grants' : RULE_LABELS.find(([k]) => k === key)?.[1].replace(/^.*· /, '') ?? RULES.find(r => r.key === key)?.title ?? key;
/** "preset:moderation" → its rule keys; a rule key → [key]; empty → [] (all rules). */
export function rulesFor(choice) {
    if (!choice)
        return [];
    if (choice.startsWith('preset:')) {
        const preset = TRUST_PRESETS[choice.slice(7)];
        if (!preset)
            throw new AppError('VALIDATION_ERROR', 'Unknown whitelist preset.');
        return preset.rules;
    }
    return [choice];
}
export function grantScope(kind) {
    if (kind === 'bot')
        return 'verification bot only';
    const rule = kind.includes(':') ? kind.split(':')[1] : null;
    return rule ? `${friendly(rule)} only` : 'all rules';
}
/** Name a set of per-rule bypasses: a preset name when they match one exactly, else the rule titles. */
export function scopeName(rules) {
    if (!rules.length)
        return 'all rules';
    const set = [...new Set(rules)].sort().join(',');
    const preset = Object.values(TRUST_PRESETS).find(p => [...p.rules].sort().join(',') === set);
    if (preset)
        return `${preset.title} (${preset.description})`;
    // Otherwise name the biggest presets fully included, plus any single extras: "Basic moderation + Delete channels".
    const have = new Set(rules);
    const fits = Object.values(TRUST_PRESETS).filter(p => p.rules.every(r => have.has(r)));
    const kept = fits.filter(p => !fits.some(o => o !== p && o.rules.length > p.rules.length && p.rules.every(r => o.rules.includes(r))));
    for (const p of kept)
        for (const r of p.rules)
            have.delete(r);
    return [...kept.map(p => p.title), ...[...have].map(friendly)].join(' + ') + (kept.length ? '' : ' only');
}
export function canManageOwnTrust(actorId, guildOwnerId) {
    return actorId === config.ownerId || developers.has(actorId) || !!guildOwnerId && actorId === guildOwnerId;
}
export const DURATIONS = [
    { hours: 24, label: '24 hours' }, { hours: 168, label: '7 days' }, { hours: 720, label: '30 days' }, { hours: 0, label: 'Permanent (until removed)' },
];
const durationLabel = (hours) => DURATIONS.find(d => d.hours === hours)?.label ?? `${hours} hours`;
export function changeTrust(ctx, guild, target, role, add, hours, choice) {
    // Granting yourself a bypass is what a hijacked admin account would do before a nuke, so it needs someone else.
    // Removing a bypass only reduces access and is always allowed.
    if (add && !canManageOwnTrust(ctx.actor.id, ctx.actor.guild?.ownerId) && (target === ctx.actor.id || role && ctx.actor.roles.cache.has(target)))
        throw new AppError('PERMISSION_ERROR', 'Another security administrator (or the server owner) must grant a bypass to you or to a role you hold. You can still remove it yourself.');
    const rules = rulesFor(choice);
    if (rules.some(rule => !RULES.some(r => r.key === rule)))
        throw new AppError('VALIDATION_ERROR', 'Unknown anti-nuke rule.');
    const base = role ? 'trust_role' : 'trust';
    // Removing with no rule picked clears every bypass this user/role has (all-rules, presets and single rules).
    if (!add && !rules.length) {
        const kinds = ctx.store.all('SELECT kind FROM grants WHERE guild_id=? AND user_id=? AND (kind=? OR kind LIKE ?)', guild, target, base, `${base}:%`).map(r => String(r.kind));
        if (!kinds.length)
            throw new AppError('VALIDATION_ERROR', `<@${role ? '&' : ''}${target}> has no anti-nuke bypass to remove.`);
        for (const kind of kinds)
            ctx.store.revokeGrant(guild, target, kind, ctx.actor.id);
        ctx.logs.push(guild, embed('Whitelist changed', `By <@${ctx.actor.id}> · removed **every** bypass for <@${role ? '&' : ''}${target}> (${kinds.length})`));
        return 'every anti-nuke bypass';
    }
    for (const kind of rules.length ? rules.map(r => `${base}:${r}`) : [base]) {
        if (add)
            ctx.store.grant(guild, target, kind, ctx.actor.id, hours);
        else
            ctx.store.revokeGrant(guild, target, kind, ctx.actor.id);
    }
    const scope = rules.length ? `**${scopeName(rules)}**` : 'all anti-nuke rules';
    ctx.logs.push(guild, embed('Whitelist changed', `By <@${ctx.actor.id}> · ${add ? 'granted' : 'removed'} bypass for <@${role ? '&' : ''}${target}> · ${scope}${add ? ` · ${hours ? durationLabel(hours).toLowerCase() : 'until removed'}` : ''}`));
    return scope;
}
function whitelistPanel(ctx, guild, user, remove = false, hours = 24) {
    const rows = ctx.store.all("SELECT * FROM grants WHERE guild_id=? AND (kind IN ('trust','trust_role','bot') OR kind LIKE 'trust:%' OR kind LIKE 'trust_role:%') AND (expires IS NULL OR expires>?)", guild, Date.now());
    const lines = rows.slice(0, 20).map(r => `<@${String(r.kind).startsWith('trust_role') ? '&' : ''}${r.user_id}> · ${grantScope(r.kind)} · ${r.expires ? `expires <t:${Math.floor(r.expires / 1000)}:R>` : 'until removed'}`).join('\n') || 'No explicit exemptions.';
    const prefix = `anpanel:${guild}:${user}:`;
    const instruction = remove ? 'Select a user or role to **remove its bypass**.' : `Select a user or role to **grant a bypass for ${durationLabel(hours).toLowerCase()}**. Choosing someone already listed changes their duration.`;
    const rowsOut = [];
    if (!remove)
        rowsOut.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(prefix + 'duration').setPlaceholder('Bypass duration').addOptions(...DURATIONS.map(d => ({ label: d.label, value: String(d.hours), default: d.hours === hours })))));
    rowsOut.push(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(prefix + (remove ? 'removeuser' : `adduser:${hours}`)).setPlaceholder(remove ? 'Remove a user' : 'Add or update a user').setMaxValues(1)), new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(prefix + (remove ? 'removerole' : `addrole:${hours}`)).setPlaceholder(remove ? 'Remove a role' : 'Add or update a role').setMaxValues(1)), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(prefix + (remove ? 'whitelist' : 'remove')).setLabel(remove ? 'Add bypass' : 'Remove bypass').setStyle(remove ? ButtonStyle.Secondary : ButtonStyle.Danger), new ButtonBuilder().setCustomId(prefix + 'refresh').setLabel('Back to Status').setStyle(ButtonStyle.Secondary)));
    return { embeds: [embed('Manage Whitelist', `${lines}\n\n${instruction} Use /antinuke whitelist for verification-only exemptions.`)], components: rowsOut, allowedMentions: { parse: [] } };
}
/**
 * One page of the whitelist with Prev / Refresh / Next buttons. One line per user or role:
 * their per-rule bypasses are grouped and named after a preset when they match one.
 * Roles that no longer exist are marked so they can be cleaned up.
 */
export function trustListPage(ctx, guildId, user, requested = 1, expired = false) {
    const now = Date.now();
    const rows = ctx.store.all("SELECT * FROM grants WHERE guild_id=? AND (kind IN ('trust','trust_role','bot') OR kind LIKE 'trust:%' OR kind LIKE 'trust_role:%') ORDER BY kind LIKE 'trust_role%' DESC,user_id,kind", guildId)
        .filter(r => expired || !r.expires || r.expires > now);
    const groups = new Map();
    for (const r of rows) {
        const kind = String(r.kind), role = kind.startsWith('trust_role'), bot = kind === 'bot';
        // Grants made together (a preset) expire within the same minute.
        const key = `${bot ? 'bot' : role ? 'r' : 'u'}:${r.user_id}:${kind.includes(':') ? 'rule' : kind}:${r.expires ? Math.round(Number(r.expires) / 60000) : ''}`;
        const g = groups.get(key) ?? { id: String(r.user_id), role, kinds: [], expires: r.expires ? Number(r.expires) : null, by: String(r.by_id), bot };
        g.kinds.push(kind);
        groups.set(key, g);
    }
    const all = [...groups.values()], guild = ctx.client?.guilds?.cache?.get(guildId);
    const pages = Math.max(1, Math.ceil(all.length / 10)), page = Math.min(Math.max(1, requested), pages);
    const lines = all.slice((page - 1) * 10, page * 10).map(g => {
        const scope = g.bot ? 'verification bot only' : scopeName(g.kinds.filter(k => k.includes(':')).map(k => k.split(':')[1]));
        const gone = g.role && guild && !guild.roles.cache.has(g.id) ? ` *(role deleted · ID ${g.id} · remove with \`/antinuke whitelist add\`)*` : '';
        return `${g.role ? '🛡️' : '👤'} <@${g.role ? '&' : ''}${g.id}>${gone} · **${scope}** · ${g.expires ? `${g.expires > now ? 'expires' : 'EXPIRED'} <t:${Math.floor(g.expires / 1000)}:R>` : 'until removed'} · set by <@${g.by}>`;
    });
    const body = `${lines.join('\n') || 'Nobody is whitelisted.'}\n\n**All rules** = never punished (you are still alerted), except for granting Administrator and other protected permissions. A **preset** or **<Rule> only** = not punished for those rules only.\n**Permission grants** = the separate whitelist for handing out those permissions (\`/antinuke whitelist admin\`).\n-# Page ${page}/${pages} · ${all.length} entr${all.length === 1 ? 'y' : 'ies'} · updated <t:${Math.floor(now / 1000)}:T>`;
    const id = (p) => `trustlist:${guildId}:${user}:${p}:${expired ? 1 : 0}`;
    return { embeds: [embed('Anti-nuke whitelist', body)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id(page - 1)).setLabel('< Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1), new ButtonBuilder().setCustomId(id(page) + ':r').setLabel('Refresh').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(id(page + 1)).setLabel('Next >').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages))], allowedMentions: { parse: [] } };
}
export function registerAntinukePanel(registry) {
    registry.component({ prefix: 'anpanel:', kinds: ['button', 'select'], metadata: { ...defaults, category: 'antinuke', access: 'security', cooldown: 0 }, execute: async (ctx, i) => {
            const match = /^anpanel:(\d{17,20}):(\d{17,20}):([a-z]+)(?::(\d{1,4}))?$/.exec(i.customId);
            if (!match || match[1] !== i.guildId || match[2] !== i.user.id)
                throw new AppError('PERMISSION_ERROR', 'This panel belongs to another user or server. Run /antinuke status.');
            const action = match[3];
            if (action === 'refresh')
                return void await i.editReply(statusPanel(ctx, i.guildId, i.user.id));
            if (action === 'whitelist' || action === 'remove') {
                const { trustPanel, panelFor } = await import('./trust-panel.js');
                return void await i.editReply(trustPanel(ctx, i.guildId, i.user.id, panelFor(ctx, i.guildId, null, false)));
            }
            if (action === 'duration') {
                const hours = Number(i.values?.[0]);
                if (!DURATIONS.some(d => d.hours === hours))
                    throw new AppError('VALIDATION_ERROR', 'Choose one of the listed durations.');
                return void await i.editReply(whitelistPanel(ctx, i.guildId, i.user.id, false, hours));
            }
            if (['adduser', 'addrole', 'removeuser', 'removerole'].includes(action)) {
                const target = i.values[0];
                if (!/^\d{17,20}$/.test(target) || i.values.length !== 1)
                    throw new AppError('VALIDATION_ERROR', 'Select one valid target.');
                const add = action.startsWith('add'), hours = add ? Number(match[4] ?? 24) : 0;
                if (add && !DURATIONS.some(d => d.hours === hours))
                    throw new AppError('VALIDATION_ERROR', 'Choose one of the listed durations.');
                // Bot (managed) roles may be whitelisted or removed; only @everyone is refused.
                if (action.endsWith('role') && add) {
                    const role = await i.guild.roles.fetch(target);
                    if (!role || role.id === i.guildId)
                        throw new AppError('VALIDATION_ERROR', 'Select a role other than @everyone.');
                }
                changeTrust(ctx, i.guildId, target, action.endsWith('role'), add, add && hours ? hours : undefined);
                return void await i.editReply(whitelistPanel(ctx, i.guildId, i.user.id, !add, add ? hours : 24));
            }
            if (action === 'incidents') {
                const rows = ctx.store.all('SELECT * FROM incidents WHERE guild_id=? ORDER BY id DESC LIMIT 5', i.guildId);
                return void await i.editReply({ embeds: [embed('Recent Anti-nuke Incidents', rows.map(r => `**#${r.id} · ${r.rule}** · <@${r.actor_id}>\n${String(r.result).slice(0, 500)}`).join('\n\n') || 'No incidents recorded.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`anpanel:${i.guildId}:${i.user.id}:refresh`).setLabel('Back to Status').setStyle(ButtonStyle.Secondary))], allowedMentions: { parse: [] } });
            }
            throw new AppError('VALIDATION_ERROR', 'Unknown panel control.');
        } });
    registry.component({ prefix: 'trustlist:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security', cooldown: 0 }, execute: async (ctx, i) => {
            const match = /^trustlist:(\d{17,20}):(\d{17,20}):(-?\d{1,6}):([01])(?::r)?$/.exec(i.customId);
            if (!match || match[1] !== i.guildId || match[2] !== i.user.id)
                throw new AppError('PERMISSION_ERROR', 'This list belongs to another user. Run /antinuke whitelist list yourself.');
            await i.editReply(trustListPage(ctx, i.guildId, i.user.id, Number(match[3]), match[4] === '1'));
        } });
}
