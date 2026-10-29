import { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, Colors, PermissionFlagsBits, PermissionsBitField, type Guild, type GuildAuditLogsEntry, type GuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { DANGEROUS, dangerous } from '../core.js';
import { embed } from '../ui/ui.js';
import { defaults, type Registry } from '../bot/registry.js';
import { AppError, logEvent } from '../errors.js';
import { RANKS, rankOf, isSupreme } from '../bot/ranks.js';
import { developers } from '../bot/developers.js';
import { isTrustedBot } from '../bot/trusted-bots.js';
import { raidState, setRaidMode } from '../security/raidmode.js';
import { getFeature } from './settings.js';

/**
 * Extra anti-nuke layers on top of the 17-rule preset:
 *  - Raid auto-trigger: a join flood switches raid mode on by itself (for an hour by default).
 *  - Server settings lock: changes to the server name, icon, banner, verification level, content
 *    filter, notification default and system/rules channels by anyone who is not whitelisted are
 *    put back straight away (the anti-nuke rule still punishes the person).
 *  - Bot quarantine: a new bot with powerful permissions, added by anyone other than the server
 *    owner or a Supreme Leader/Developer, has those permissions removed until a Head Admin approves.
 *  - Permission audit: who can do damage, at a glance.
 */
export interface PlusConfig { raidAuto: boolean; raidAutoHours: number; settingsLock: boolean; botQuarantine: boolean }
export const PLUS_DEFAULTS: PlusConfig = { raidAuto: true, raidAutoHours: 1, settingsLock: true, botQuarantine: true };
export const plusConfig = (store: Store, guild: string) => getFeature(store, guild, 'antinukeplus', PLUS_DEFAULTS);
const DANGEROUS_MASK = DANGEROUS.reduce((all, bit) => all | BigInt(bit), 0n);

// ---- Raid auto-trigger ----
/** Called when anti-nuke records a join-flood incident. Returns a line for the alert. */
export function autoRaid(store: Store, guild: string, now = Date.now()): string {
    const c = plusConfig(store, guild);
    if (!c.raidAuto) return 'Raid auto-trigger is off; turn on raid mode yourself with `/raid mode on` if this is a raid.';
    const current = raidState(store, guild, now);
    if (current.enabled) return 'Raid mode was already on.';
    if (store.settings(guild).mode !== 'enforce') return 'Anti-nuke is in observe mode, so raid mode was **not** switched on. Turn it on with `/raid mode on` if this is a raid.';
    // Keep the server's own raid settings (minimum account age, kick or timeout).
    setRaidMode(store, guild, true, 'auto', { hours: c.raidAutoHours, minAgeDays: current.minAgeDays, action: current.action });
    return `🛑 **Raid mode switched on automatically for ${c.raidAutoHours} hour${c.raidAutoHours === 1 ? '' : 's'}**: new accounts that join are removed. Turn it off early with \`/raid mode off\`.`;
}

// ---- Server settings lock ----
type SettingKind = 'plain' | 'image' | 'channel';
const cdn = (path: string, hash: string, size: number, animated: boolean) => `https://cdn.discordapp.com/${path}/${hash}.${animated && hash.startsWith('a_') ? 'gif' : 'png'}?size=${size}`;
const SETTINGS: Record<string, { label: string; kind: SettingKind; edit: (v: any, guild: Guild) => Record<string, unknown> | null }> = {
    name: { label: 'name', kind: 'plain', edit: v => typeof v === 'string' && v ? { name: v } : null },
    icon_hash: { label: 'icon', kind: 'image', edit: (v, g) => ({ icon: v ? cdn(`icons/${g.id}`, String(v), 1024, true) : null }) },
    banner_hash: { label: 'banner', kind: 'image', edit: (v, g) => ({ banner: v ? cdn(`banners/${g.id}`, String(v), 2048, true) : null }) },
    splash_hash: { label: 'invite background', kind: 'image', edit: (v, g) => ({ splash: v ? cdn(`splashes/${g.id}`, String(v), 2048, false) : null }) },
    verification_level: { label: 'verification level', kind: 'plain', edit: v => v === undefined || v === null ? null : { verificationLevel: Number(v) } },
    explicit_content_filter: { label: 'content filter', kind: 'plain', edit: v => v === undefined || v === null ? null : { explicitContentFilter: Number(v) } },
    default_message_notifications: { label: 'notification default', kind: 'plain', edit: v => v === undefined || v === null ? null : { defaultMessageNotifications: Number(v) } },
    system_channel_id: { label: 'system channel', kind: 'channel', edit: v => ({ systemChannel: v ?? null }) },
    rules_channel_id: { label: 'rules channel', kind: 'channel', edit: v => ({ rulesChannel: v ?? null }) },
    public_updates_channel_id: { label: 'updates channel', kind: 'channel', edit: v => ({ publicUpdatesChannel: v ?? null }) },
    afk_channel_id: { label: 'AFK channel', kind: 'channel', edit: v => ({ afkChannel: v ?? null }) },
};

export interface SettingsPart { label: string; kind: SettingKind; edit: Record<string, unknown> }
/** Which settings an audit entry changed, and the edit that puts them back. Pure, for tests. */
export function settingsRevert(entry: Pick<GuildAuditLogsEntry, 'changes'>, guild: Guild): { labels: string[]; edit: Record<string, unknown>; parts: SettingsPart[] } {
    const parts: SettingsPart[] = [];
    for (const change of entry.changes ?? []) {
        const s = SETTINGS[change.key as string];
        const part = s?.edit(change.old, guild);
        if (s && part) parts.push({ label: s.label, kind: s.kind, edit: part });
    }
    return { labels: parts.map(p => p.label), edit: Object.assign({}, ...parts.map(p => p.edit)), parts };
}

/** Download an old image ourselves so a deleted one fails cleanly instead of breaking the whole edit. */
async function fetchImage(url: string): Promise<Buffer | null> {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        return buf.length && buf.length <= 10 * 1024 * 1024 ? buf : null;
    } catch { return null; }
}

export async function lockServerSettings(store: Store, logs: LogQueue, entry: GuildAuditLogsEntry, guild: Guild, trusted: (id: string) => boolean, trustedFor: (id: string, rule: string) => boolean = (id, rule) => store.hasGrant(guild.id, id, `trust:${rule}`)) {
    if (entry.action !== AuditLogEvent.GuildUpdate || !plusConfig(store, guild.id).settingsLock) return;
    const s = store.settings(guild.id);
    if (!s.enabled || s.mode !== 'enforce') return;
    const actor = entry.executorId;
    if (!actor || actor === guild.client.user?.id || trusted(actor) || trustedFor(actor, 'guild_update')) return;
    const { labels, parts } = settingsRevert(entry, guild);
    if (!labels.length) return;
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) {
        logs.push(guild.id, embed('Server settings changed', `<@${actor}> changed the server ${labels.join(', ')}. Vanguard needs **Manage Server** to put it back.`, Colors.Orange));
        return;
    }
    // Build one edit for everything that can still be restored; anything that cannot is reported, not fatal.
    const edit: Record<string, unknown> = {}, restored: string[] = [], failed: string[] = [];
    for (const p of parts) {
        if (p.kind === 'channel') {
            const id = Object.values(p.edit)[0] as string | null;
            if (id && !guild.channels?.cache?.has(id) && !(await guild.channels?.fetch(id).catch(() => null))) { failed.push(`${p.label} (channel was deleted)`); continue; }
        } else if (p.kind === 'image') {
            const [field, url] = Object.entries(p.edit)[0] as [string, string | null];
            if (url) {
                const buf = await fetchImage(url);
                if (!buf) { failed.push(`${p.label} (old image is gone)`); continue; }
                edit[field] = buf; restored.push(p.label); continue;
            }
        }
        Object.assign(edit, p.edit); restored.push(p.label);
    }
    let ok = restored.length > 0 && await guild.edit({ ...edit, reason: 'Ghost Vanguard: server settings lock' }).then(() => true, () => false);
    // If the combined edit was refused (e.g. a banner needs boosts), try each part on its own.
    if (!ok && restored.length > 1) {
        const single = [...restored]; restored.length = 0;
        for (const p of parts.filter(p => single.includes(p.label))) {
            const fields = Object.fromEntries(Object.keys(p.edit).map(k => [k, edit[k]]));
            if (await guild.edit({ ...fields, reason: 'Ghost Vanguard: server settings lock' }).then(() => true, () => false)) restored.push(p.label); else failed.push(p.label);
        }
        ok = restored.length > 0;
    } else if (!ok) failed.push(...restored.splice(0));
    logs.push(guild.id, embed(ok ? '🔒 Server settings restored' : 'Server settings changed', [
        `<@${actor}> (not whitelisted) changed the server **${labels.join(', ')}**.`,
        restored.length ? `✅ Put back: ${restored.join(', ')}` : '',
        failed.length ? `⚠ Could not put back: ${failed.join(', ')}` : '',
        '-# Allow someone to change server settings with `/antinuke whitelist add` → "Server · Edit server settings".',
    ].filter(Boolean).join('\n'), ok && !failed.length ? Colors.Green : Colors.Orange));
    logEvent('settings_lock', { guildId: guild.id, actor, restored, failed });
}

// ---- Bot quarantine ----
const metaKey = (guild: string, bot: string) => `botq:${guild}:${bot}`;
interface HeldBot { perms: string; adder: string | null }
function readHeld(value: unknown): HeldBot {
    const text = String(value);
    if (/^\d+$/.test(text)) return { perms: text, adder: null }; // older format: just the permissions
    try { const v = JSON.parse(text); return { perms: String(v.perms ?? '0'), adder: v.adder ?? null }; } catch { return { perms: '0', adder: null }; }
}
const permNames = (bits: bigint) => new PermissionsBitField(bits).toArray().join(', ') || 'none';

export async function quarantineNewBot(store: Store, logs: LogQueue, member: GuildMember) {
    if (!member.user.bot || isTrustedBot(member.id) || !plusConfig(store, member.guild.id).botQuarantine) return;
    const s = store.settings(member.guild.id);
    if (!s.enabled || s.mode !== 'enforce') return;
    // The bot's own role is sometimes created a moment after it joins.
    let role = member.roles.botRole;
    if (!role) { await new Promise(r => setTimeout(r, 3000)); role = (await member.guild.members.fetch({ user: member.id, force: true }).catch(() => null))?.roles.botRole ?? null; }
    if (!role || !dangerous(role.permissions.bitfield)) return;
    const before = role.permissions.bitfield, held = before & DANGEROUS_MASK;
    if (!role.editable) {
        logs.push(member.guild.id, embed('⚠ Powerful bot added', `<@${member.id}> was added with **${permNames(held)}**, but its role is above Vanguard so it could not be limited. Check it now.`, Colors.Red));
        return;
    }
    // Strip first (seconds matter during a nuke), then check who added it.
    const ok = await role.setPermissions(before & ~DANGEROUS_MASK, 'Ghost Vanguard: new bot held for approval').then(() => true, () => false);
    if (!ok) return;
    const entry = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).then(l => l.entries.find(e => e.targetId === member.id), () => undefined);
    const adder = entry?.executorId ?? null;
    // The server owner, Supreme Leaders and Developers may add powerful bots: give the permissions straight back.
    if (adder && (adder === member.guild.ownerId || isSupreme(adder) || developers.has(adder))) {
        await role.setPermissions(role.permissions.bitfield | held, 'Ghost Vanguard: bot added by a trusted person').catch(() => { });
        return;
    }
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', metaKey(member.guild.id, member.id), JSON.stringify({ perms: String(held), adder }));
    logs.push(member.guild.id, embed('🤖 New bot held for approval', `<@${member.id}> was added${adder ? ` by <@${adder}>` : ''} asking for powerful permissions. Vanguard removed them until it is approved.\n**Asked for:** ${permNames(held)}\n-# Approve: the server owner, a Supreme Leader, or a Head Admin who has those permissions (not the person who added it).`, Colors.Orange),
        [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`botq:approve:${member.id}`).setLabel('Approve (give permissions back)').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`botq:kick:${member.id}`).setLabel('Kick bot').setStyle(ButtonStyle.Danger))]);
}

/** A held bot that left or was banned: forget it. */
export function forgetHeldBot(store: Store, guild: string, bot: string) {
    store.run('DELETE FROM runtime_meta WHERE key=?', metaKey(guild, bot));
}

/** Who may approve a held bot. Pure, for tests. */
export function canApproveBot(opts: { user: string; ownerId: string; adder: string | null; supreme: boolean; rank: number; userPerms: bigint; held: bigint }): string | null {
    if (opts.user === opts.ownerId || opts.supreme) return null;
    if (opts.adder && opts.user === opts.adder) return 'The person who added a bot cannot approve it themselves.';
    if (opts.rank < RANKS.headadmin) return 'Only Head Admins and above can approve bots.';
    const admin = (opts.userPerms & BigInt(PermissionFlagsBits.Administrator)) !== 0n;
    if (!admin && (opts.held & ~opts.userPerms) !== 0n) return 'You can only approve permissions you have yourself. Ask the server owner or a Supreme Leader.';
    return null;
}

export function registerBotQuarantineControls(registry: Registry) {
    registry.component({ prefix: 'botq:', kinds: ['button'], metadata: { ...defaults, category: 'antinuke', access: 'member', cooldown: 1000 }, execute: async (ctx, i) => {
        const [, action, botId] = i.customId.split(':');
        const key = metaKey(i.guildId, botId!), saved = ctx.store.get('SELECT value FROM runtime_meta WHERE key=?', key);
        const held = saved ? readHeld(saved.value) : { perms: '0', adder: null };
        const rank = rankOf(ctx.store, i.guildId, i.user.id, ctx.actor, 'botq');
        if (action === 'kick') {
            if (rank < RANKS.headadmin && i.user.id !== i.guild.ownerId) throw new AppError('PERMISSION_ERROR', 'Only Head Admins and above can reject bots.');
            const bot = await i.guild.members.fetch(botId!).catch(() => null);
            // No staff ID in the reason: Vanguard did it, so anti-nuke must not count it against the clicker.
            if (bot) await bot.kick('Ghost Vanguard: held bot rejected');
            forgetHeldBot(ctx.store, i.guildId, botId!);
            await i.message?.edit({ components: [] }).catch(() => { });
            ctx.logs.push(i.guildId, embed('Bot rejected', `<@${botId}> was kicked by <@${i.user.id}>.`, Colors.Red));
            return 'Bot kicked.';
        }
        if (!saved) { await i.message?.edit({ components: [] }).catch(() => { }); return 'This bot was already decided.'; }
        const bot = await i.guild.members.fetch(botId!).catch(() => null);
        if (!bot?.roles.botRole) { forgetHeldBot(ctx.store, i.guildId, botId!); await i.message?.edit({ components: [] }).catch(() => { }); return 'That bot is no longer in the server.'; }
        const heldBits = BigInt(held.perms) & DANGEROUS_MASK;
        const denied = canApproveBot({ user: i.user.id, ownerId: i.guild.ownerId, adder: held.adder, supreme: isSupreme(i.user.id) || rank >= RANKS.supreme, rank, userPerms: i.memberPermissions?.bitfield ?? 0n, held: heldBits });
        if (denied) throw new AppError('PERMISSION_ERROR', denied);
        // Only give back the powerful bits that were removed, on top of whatever the role has now.
        const role = bot.roles.botRole;
        await role.setPermissions(role.permissions.bitfield | heldBits, 'Ghost Vanguard: held bot approved');
        forgetHeldBot(ctx.store, i.guildId, botId!);
        await i.message?.edit({ components: [] }).catch(() => { });
        ctx.logs.push(i.guildId, embed('Bot approved', `<@${botId}> got back **${permNames(heldBits)}**. Approved by <@${i.user.id}>.`, Colors.Green));
        return 'Bot approved: its permissions are back.';
    } });
}

// ---- Permission audit ----
export async function permissionAudit(guild: Guild): Promise<string> {
    await guild.roles.fetch();
    const me = guild.members.me!, myTop = me.roles.highest.position;
    const everyone = guild.roles.everyone;
    const risky = [...guild.roles.cache.values()].filter(r => r.id !== guild.id && dangerous(r.permissions.bitfield)).sort((a, b) => b.position - a.position);
    const admins = risky.filter(r => r.permissions.has(PermissionFlagsBits.Administrator));
    const above = risky.filter(r => r.position >= myTop && r.id !== me.roles.highest.id);
    const botsWithAdmin = guild.members.cache.filter(m => m.user.bot && m.id !== me.id && m.permissions.has(PermissionFlagsBits.Administrator));
    const hooks = await guild.fetchWebhooks().then(h => h.size, () => null);
    const score = Math.max(0, 100 - admins.length * 5 - above.length * 10 - botsWithAdmin.size * 10 - (dangerous(everyone.permissions.bitfield) ? 40 : 0));
    const line = (r: any) => `<@&${r.id}> · ${r.members.size} member${r.members.size === 1 ? '' : 's'}${r.permissions.has(PermissionFlagsBits.Administrator) ? ' · **Administrator**' : ''}${r.position >= myTop ? ' · ⚠ above Vanguard' : ''}`;
    return [
        `**Safety score: ${score}/100** ${score >= 80 ? '🟢' : score >= 50 ? '🟡' : '🔴'}`,
        dangerous(everyone.permissions.bitfield) ? '🔴 **@everyone has powerful permissions.** Remove them in Server Settings → Roles → @everyone.' : '✅ @everyone has no powerful permissions.',
        above.length ? `⚠ **${above.length} powerful role(s) sit above Vanguard**, so it cannot stop people with them. Drag Vanguard's role higher.` : '✅ Vanguard is above every powerful role.',
        botsWithAdmin.size ? `⚠ **Bots with Administrator:** ${[...botsWithAdmin.values()].map(m => `<@${m.id}>`).join(', ')}. A hacked bot can nuke the server; give bots only what they need.` : '✅ No other bot has Administrator.',
        hooks !== null ? `**Webhooks:** ${hooks} · review with \`/raid webhooks\`` : '',
        '', `**Powerful roles (${risky.length})**`, ...risky.slice(0, 15).map(line), risky.length > 15 ? `…and ${risky.length - 15} more` : '',
        '', '-# Powerful = Administrator, Manage Server/Roles/Channels/Webhooks/Messages, Ban, Kick, Timeout or @everyone mentions.',
    ].filter(l => l !== '').join('\n');
}
