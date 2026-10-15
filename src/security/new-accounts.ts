import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { defaults, type Registry } from '../bot/registry.js';
import { AppError, logEvent } from '../errors.js';
import { embed } from '../ui/ui.js';
import { DAY, staffReason } from './raidmode.js';
import { RANKS, rankOf } from '../bot/ranks.js';

/**
 * New-account gate: Discord accounts younger than the server's minimum age (default 7 days) are
 * held when they join, because banned members often come straight back on a fresh account.
 * "hold" times them out until the account reaches the minimum age (they can read but not talk,
 * react or join voice; a timeout survives leaving and rejoining). Staff get an alert with
 * Let in / Kick / Ban buttons, and a warning when the name resembles someone on the ban list.
 */
export type NewAccountAction = 'hold' | 'kick' | 'alert';
export interface NewAccountConfig { enabled: boolean; minAgeDays: number; action: NewAccountAction }
const MAX_TIMEOUT = 28 * DAY - 60000;

export function newAccountConfig(store: Store, guild: string): NewAccountConfig {
    const row = store.get('SELECT enabled,min_age_days,action FROM newaccount_config WHERE guild_id=?', guild);
    return { enabled: row ? !!row.enabled : true, minAgeDays: Number(row?.min_age_days ?? 7), action: (row?.action ?? 'hold') as NewAccountAction };
}
export function setNewAccountConfig(store: Store, guild: string, by: string, change: Partial<NewAccountConfig>) {
    const next = { ...newAccountConfig(store, guild), ...change };
    store.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', guild);
    store.run(`INSERT INTO newaccount_config(guild_id,enabled,min_age_days,action,by_id) VALUES(?,?,?,?,?)
        ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,min_age_days=excluded.min_age_days,action=excluded.action,by_id=excluded.by_id`,
        guild, Number(next.enabled), next.minAgeDays, next.action, by);
    return next;
}

/** Lower-case letters and digits only, so "Gamer_123", "gamer.123" and "𝓰𝓪𝓶𝓮𝓻123" compare equal. */
export function normalizeName(name: string | null | undefined): string {
    return (name ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 2) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length]!;
}
/** True when two names match after normalizing; names of 6+ characters may also contain each other or differ by 1 (2 for 8+). */
export function similarName(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = normalizeName(a), y = normalizeName(b);
    if (x.length < 4 || y.length < 4) return false;
    if (x === y) return true;
    // Short names are too common to fuzzy-match; they must match exactly.
    const shortest = Math.min(x.length, y.length);
    if (shortest < 6) return false;
    return y.includes(x) || x.includes(y) || distance(x, y) <= (shortest >= 8 ? 2 : 1);
}

type BannedUser = { id: string; names: string[]; tag: string; reason: string | null };
const banCache = new Map<string, { at: number; users: BannedUser[] }>();
async function bannedUsers(guild: Guild): Promise<BannedUser[]> {
    const cached = banCache.get(guild.id);
    if (cached && Date.now() - cached.at < 10 * 60000) return cached.users;
    const bans = await guild.bans.fetch({ limit: 1000 }).catch(() => null);
    const users = bans ? [...bans.values()].map(b => ({ id: b.user.id, tag: b.user.tag, reason: b.reason ?? null, names: [b.user.username, b.user.globalName].filter(Boolean) as string[] })) : [];
    banCache.set(guild.id, { at: Date.now(), users });
    return users;
}
export function clearBanCache(guild: string) { banCache.delete(guild); }

/** Banned accounts whose name looks like the new member's. */
export async function evasionMatches(member: GuildMember, banned?: BannedUser[]): Promise<BannedUser[]> {
    const list = banned ?? await bannedUsers(member.guild);
    const names = [member.user.username, member.user.globalName, member.nickname].filter(Boolean) as string[];
    return list.filter(b => b.id !== member.id && b.names.some(n => names.some(m => similarName(n, m)))).slice(0, 5);
}

/** At most 5 individual alerts per minute per server; the rest are summarized so a raid cannot flood the log. */
const alertWindow = new Map<string, { start: number; sent: number; extra: string[]; timer?: NodeJS.Timeout }>();
function pushAlert(logs: LogQueue, guildId: string, e: ReturnType<typeof embed>, rows: ActionRowBuilder<ButtonBuilder>[], line: string) {
    const now = Date.now();
    let w = alertWindow.get(guildId);
    if (!w || now - w.start > 60000) { w = { start: now, sent: 0, extra: [] }; alertWindow.set(guildId, w); }
    if (w.sent < 5) { w.sent++; logs.push(guildId, e, rows); return; }
    w.extra.push(line);
    w.timer ??= setTimeout(() => {
        const done = alertWindow.get(guildId); alertWindow.delete(guildId);
        if (done?.extra.length) logs.push(guildId, embed('New accounts · more joins held', `${done.extra.length} more new account(s) in the last minute:\n${done.extra.slice(0, 20).join('\n')}${done.extra.length > 20 ? `\n…and ${done.extra.length - 20} more` : ''}\n\nIf this is a raid, use \`/security raidmode on\`.`, Colors.Orange));
    }, 60000);
    w.timer.unref?.();
}

export async function handleNewAccountJoin(store: Store, logs: LogQueue, member: GuildMember, trusted: (id: string) => boolean, now = Date.now(), banned?: BannedUser[]): Promise<'ignored' | 'held' | 'kicked' | 'alerted' | 'failed'> {
    const config = newAccountConfig(store, member.guild.id);
    if (!config.enabled || member.user.bot || trusted(member.id)) return 'ignored';
    const ageMs = now - member.user.createdTimestamp;
    if (ageMs >= config.minAgeDays * DAY) return 'ignored';
    const ageDays = Math.floor(ageMs / DAY), releaseAt = member.user.createdTimestamp + config.minAgeDays * DAY;
    const matches = await evasionMatches(member, banned).catch(() => []);
    let result: 'held' | 'kicked' | 'alerted' | 'failed' = 'alerted', detail = 'Staff alerted; no action taken.';
    const reason = `Ghost Vanguard new-account gate: account ${ageDays} day(s) old (minimum ${config.minAgeDays})`;
    try {
        if (config.action === 'hold') {
            if (!member.moderatable) { result = 'failed'; detail = 'Could not hold: Vanguard needs Timeout Members and a role above theirs.'; }
            else { await member.timeout(Math.min(releaseAt - now, MAX_TIMEOUT), reason); result = 'held'; detail = `Held (timed out) until <t:${Math.floor(Math.min(releaseAt, now + MAX_TIMEOUT) / 1000)}:R>, when the account is ${config.minAgeDays} days old.`; }
        } else if (config.action === 'kick') {
            if (!member.kickable) { result = 'failed'; detail = 'Could not kick: Vanguard needs Kick Members and a role above theirs.'; }
            else { await member.kick(reason); result = 'kicked'; detail = 'Kicked. They can rejoin once the account is old enough.'; }
        }
    } catch { result = 'failed'; detail = 'The action failed; check Vanguard\'s permissions and role position.'; }
    if (result === 'held' || result === 'kicked')
        store.recordCase(member.guild.id, member.id, member.client.user?.id ?? 'system', result === 'held' ? 'new-account hold' : 'new-account kick', reason);
    const evasion = matches.length ? `\n\n⚠ **Possible ban evasion.** Name resembles banned account${matches.length > 1 ? 's' : ''}: ${matches.map(m => `**${m.tag}** (${m.id})${m.reason ? ` — ${m.reason.slice(0, 80)}` : ''}`).join(', ')}` : '';
    const description = `**Member:** <@${member.id}> (${member.user.tag}) · \`${member.id}\`\n**Account created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R> (${ageDays} day(s) old)\n**Result:** ${detail}${evasion}`;
    const rows = result === 'kicked' ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...(result === 'held' ? [new ButtonBuilder().setCustomId(`newacct:release:${member.id}`).setLabel('Let in').setStyle(ButtonStyle.Success)] : []),
        new ButtonBuilder().setCustomId(`newacct:kick:${member.id}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`newacct:ban:${member.id}`).setLabel(matches.length ? 'Ban (evasion)' : 'Ban').setStyle(ButtonStyle.Danger))];
    pushAlert(logs, member.guild.id, embed(matches.length ? 'New account · possible ban evasion' : 'New account joined', description, matches.length ? Colors.Red : Colors.Orange), rows,
        `<@${member.id}> · ${ageDays}d old · ${result}${matches.length ? ' · ⚠ resembles a banned account' : ''}`);
    logEvent('new_account_join', { guildId: member.guild.id, userId: member.id, ageDays, result, evasion: matches.length });
    return result;
}

/** Let in / Kick / Ban buttons on new-account alerts. Each needs the matching Discord permission. */
export function registerNewAccountControls(registry: Registry) {
    registry.component({ prefix: 'newacct:', kinds: ['button'], metadata: { ...defaults, category: 'moderation', access: 'member', requiredPermissions: [PermissionFlagsBits.ModerateMembers], cooldown: 0 }, execute: async (ctx, i) => {
        const match = /^newacct:(release|kick|ban):(\d{17,20})$/.exec(i.customId);
        if (!match) throw new AppError('VALIDATION_ERROR', 'Unknown control.');
        const [, action, userId] = match as unknown as [string, 'release' | 'kick' | 'ban', string];
        const actor = ctx.actor!;
        const need = action === 'ban' ? PermissionFlagsBits.BanMembers : action === 'kick' ? PermissionFlagsBits.KickMembers : PermissionFlagsBits.ModerateMembers;
        if (rankOf(ctx.store, i.guildId, actor.id, actor) < (action === 'ban' ? RANKS.moderator : action === 'kick' ? RANKS.moderator : RANKS.helper) && !actor.permissions.has(need)) throw new AppError('PERMISSION_ERROR', `You need ${action === 'ban' ? 'Ban Members' : action === 'kick' ? 'Kick Members' : 'Timeout Members'} for this.`);
        const member = await i.guild.members.fetch(userId).catch(() => null);
        let done: string;
        if (action === 'release') {
            if (!member) throw new AppError('VALIDATION_ERROR', 'They are no longer in the server.');
            await member.timeout(null, staffReason(actor.id, 'new account let in'));
            done = `let in by <@${actor.id}>`;
        } else if (action === 'kick') {
            if (!member) throw new AppError('VALIDATION_ERROR', 'They are no longer in the server.');
            if (!member.kickable) throw new AppError('PERMISSION_ERROR', 'Vanguard cannot kick this member.');
            await member.kick(staffReason(actor.id, 'new account kicked'));
            ctx.store.recordCase(i.guildId, userId, actor.id, 'kick', 'New account kicked from the new-account alert');
            done = `kicked by <@${actor.id}>`;
        } else {
            if (member && !member.bannable) throw new AppError('PERMISSION_ERROR', 'Vanguard cannot ban this member.');
            await i.guild.members.ban(userId, { reason: staffReason(actor.id, 'ban evasion (new account)'), deleteMessageSeconds: 86400 });
            ctx.store.recordCase(i.guildId, userId, actor.id, 'ban', 'Ban evasion / new account (from the new-account alert)');
            clearBanCache(i.guildId);
            done = `banned by <@${actor.id}>`;
        }
        const original = i.message?.embeds?.[0];
        await i.message?.edit({ embeds: original ? [embed(original.title ?? 'New account', `${original.description ?? ''}\n\n✅ **${done[0]!.toUpperCase()}${done.slice(1)}**`, Colors.Grey)] : [], components: [] }).catch(() => null);
        await i.editReply({ content: `<@${userId}> ${done}.`, allowedMentions: { parse: [] } });
    } });
}
