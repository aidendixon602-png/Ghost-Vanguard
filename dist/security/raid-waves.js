import { Colors, GuildVerificationLevel, PermissionFlagsBits } from 'discord.js';
import { clip } from '../core.js';
import { logEvent } from '../errors.js';
import { embed } from '../ui/ui.js';
import { DAY, raidState, setRaidMode } from './raidmode.js';
/**
 * Raid protection beyond "new accounts during raid mode":
 *
 *  - Lookalike waves: raids with older (bought) accounts get past an account-age check, but they join in a burst
 *    with names made from one pattern (raider_01, raider_02…). While raid mode is on, a joiner whose name matches
 *    LOOKALIKE_MATCHES or more other accounts that joined in the last LOOKALIKE_WINDOW_MS is handled whatever its age.
 *  - The wave that triggered raid mode: a join flood switches raid mode on after the flood has already joined, so
 *    those accounts are swept straight away too.
 *  - Message waves: the same message from WAVE_ACCOUNTS or more accounts that joined in the last
 *    NEW_MEMBER_MS, within WAVE_WINDOW_MS. Each account posting once never trips a per-person spam limit. The
 *    messages are deleted, the accounts handled like raid mode would, and raid mode switched on.
 *  - Join gate: while raid mode is on because of an automatic trigger, the server's verification level is raised
 *    to High (new members wait 10 minutes before they can talk) and put back when raid mode ends.
 */
export { LOOKALIKE_MATCHES, LOOKALIKE_WINDOW_MS } from './raidmode.js';
export const WAVE_ACCOUNTS = 4;
export const WAVE_WINDOW_MS = 30 * 1000;
export const NEW_MEMBER_MS = 30 * 60 * 1000;
export { forgetJoins, lookalikes, nameKey, rememberJoin } from './raidmode.js';
import { forgetJoins } from './raidmode.js';
export function forgetGuild(guildId) {
    forgetJoins(guildId);
    waves.delete(guildId);
}
// ---- message waves ----
/** What counts as "the same message": lower case, mentions and links reduced to placeholders, spacing collapsed. */
export function messageKey(content) {
    const key = content.toLowerCase()
        .replace(/<a?:\w+:\d+>/g, ':e:')
        .replace(/<[@#][!&]?\d+>/g, '@x')
        .replace(/https?:\/\/\S+/g, 'link')
        .replace(/\s+/g, ' ').trim();
    return key.length >= 4 ? key : null;
}
const waves = new Map();
/**
 * Look at one message. Returns the accounts handled when it completes (or continues) a message wave, else [].
 * Only enforces in enforce mode on an authorized server with anti-nuke on; in observe mode it reports instead.
 */
export async function processMessageWave(deps, message) {
    const { store, logs, trusted } = deps;
    const now = deps.now ?? Date.now();
    const member = message.member;
    if (message.author.bot || message.webhookId || !member || trusted(message.author.id))
        return [];
    if (!member.joinedTimestamp || now - member.joinedTimestamp > NEW_MEMBER_MS)
        return [];
    const s = store.settings(message.guildId);
    if (!s.authorized || !s.enabled)
        return [];
    const key = messageKey(message.content ?? '');
    if (!key)
        return [];
    const guildWaves = waves.get(message.guildId) ?? new Map();
    waves.set(message.guildId, guildWaves);
    for (const [k, w] of guildWaves)
        if (w.posts.every(p => now - p.at > WAVE_WINDOW_MS))
            guildWaves.delete(k);
    const wave = guildWaves.get(key) ?? { posts: [], hit: false };
    guildWaves.set(key, wave);
    wave.posts = wave.posts.filter(p => now - p.at <= WAVE_WINDOW_MS);
    wave.posts.push({ user: message.author.id, message: message.id, channel: message.channelId, at: now });
    const accounts = [...new Set(wave.posts.map(p => p.user))];
    if (accounts.length < WAVE_ACCOUNTS && !wave.hit)
        return [];
    const fresh = !wave.hit;
    wave.hit = true;
    const posts = fresh ? wave.posts : wave.posts.slice(-1);
    const targets = fresh ? accounts : [message.author.id];
    if (s.mode !== 'enforce') {
        if (fresh)
            logs.push(message.guildId, embed('Message wave (observe mode)', `${accounts.length} new accounts sent the same message within ${WAVE_WINDOW_MS / 1000}s:\n> ${clip(message.content, 300)}\n${accounts.slice(0, 15).map(a => `<@${a}>`).join(' ')}\n\nAnti-nuke is in observe mode, so nothing was removed.`, Colors.Orange));
        return [];
    }
    // Delete what they sent, channel by channel.
    const byChannel = new Map();
    for (const p of posts)
        byChannel.set(p.channel, [...(byChannel.get(p.channel) ?? []), p.message]);
    let deleted = 0;
    for (const [channelId, ids] of byChannel) {
        const channel = message.guild.channels.cache.get(channelId);
        if (!channel?.isTextBased?.())
            continue;
        try {
            if (ids.length === 1) {
                await channel.messages.delete(ids[0]);
                deleted++;
            }
            else {
                const done = await channel.bulkDelete(ids, true);
                deleted += done?.size ?? ids.length;
            }
        }
        catch { /* already gone, or no Manage Messages */ }
    }
    const state = raidState(store, message.guildId, now);
    const handled = [];
    for (const id of targets) {
        const target = await message.guild.members.fetch(id).catch(() => null);
        if (!target || trusted(id))
            continue;
        const reason = 'Ghost Vanguard: message wave (the same message from several new accounts)';
        try {
            if (state.action === 'kick' && target.kickable) {
                await target.kick(reason);
                handled.push(id);
            }
            else if (target.moderatable) {
                await target.timeout(DAY, reason);
                handled.push(id);
            }
        }
        catch { /* hierarchy or permissions: reported below */ }
    }
    let raid = '';
    if (fresh) {
        raid = await switchOnRaid(store, logs, message.guild, now, 'message wave');
        logs.push(message.guildId, embed('🌊 Message wave stopped', [
            `**${accounts.length}** accounts that joined in the last ${NEW_MEMBER_MS / 60000} minutes sent the same message within ${WAVE_WINDOW_MS / 1000}s:`,
            `> ${clip(message.content, 300)}`,
            `**Deleted:** ${deleted} message(s) · **${state.action === 'kick' ? 'Kicked' : 'Timed out'}:** ${handled.length} of ${accounts.length}`,
            handled.length < accounts.length ? '-# Some couldn\'t be handled (role above Vanguard, or missing Kick/Timeout permissions).' : '',
            raid,
        ].filter(Boolean).join('\n'), Colors.Red));
    }
    logEvent('message_wave', { guildId: message.guildId, accounts: accounts.length, handled: handled.length, deleted, fresh });
    return handled;
}
// ---- switching raid mode on, sweeping the wave, the join gate ----
const gateKey = (guild) => `raidgate:${guild}`;
const LEVEL_NAMES = { 0: 'None', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Highest' };
/** Raise verification to High for the raid; remembers the old level so it can be put back. */
export async function raiseGate(store, logs, guild) {
    const me = guild.members.me;
    const current = Number(guild.verificationLevel ?? 0);
    if (current >= GuildVerificationLevel.High)
        return '';
    if (!me?.permissions.has(PermissionFlagsBits.ManageGuild))
        return '-# Join gate skipped: Vanguard needs **Manage Server** to raise the verification level.';
    if (store.get('SELECT 1 FROM runtime_meta WHERE key=?', gateKey(guild.id)))
        return '';
    try {
        await guild.setVerificationLevel(GuildVerificationLevel.High, 'Ghost Vanguard: raid mode join gate');
    }
    catch {
        return '-# Join gate: Discord refused to raise the verification level.';
    }
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', gateKey(guild.id), JSON.stringify({ level: current, at: Date.now() }));
    return `🚧 **Join gate:** verification level raised from ${LEVEL_NAMES[current] ?? current} to High (new members wait 10 minutes before they can talk). It goes back when raid mode ends.`;
}
/** Put verification levels back where raid mode has ended. Runs every minute. */
export async function restoreGates(store, logs, client, ready, now = Date.now()) {
    const rows = store.all("SELECT key,value FROM runtime_meta WHERE key LIKE 'raidgate:%'");
    for (const row of rows) {
        const guildId = row.key.slice('raidgate:'.length);
        if (raidState(store, guildId, now).enabled)
            continue;
        const guild = client.guilds.cache.get(guildId);
        if (!guild || !ready(guildId))
            continue;
        const { level } = JSON.parse(row.value);
        try {
            // Only put it back if nobody changed it since: a level staff set on purpose stays.
            if (Number(guild.verificationLevel) === GuildVerificationLevel.High)
                await guild.setVerificationLevel(level, 'Ghost Vanguard: raid mode ended, join gate lifted');
            store.run('DELETE FROM runtime_meta WHERE key=?', row.key);
            logs.push(guildId, embed('Join gate lifted', `Raid mode ended, so the verification level is back to **${LEVEL_NAMES[level] ?? level}**.`, Colors.Green));
        }
        catch { /* try again next minute */ }
    }
}
/**
 * Switch raid mode on because of a detected wave (if the server allows the automatic trigger), raise the join
 * gate and return a line for the alert. Does nothing (and says so) in observe mode or when the trigger is off.
 */
export async function switchOnRaid(store, logs, guild, now = Date.now(), why = 'join flood') {
    const { plusConfig } = await import('../features/antinuke-plus.js');
    const c = plusConfig(store, guild.id);
    const state = raidState(store, guild.id, now);
    if (state.enabled)
        return 'Raid mode was already on.';
    if (!c.raidAuto)
        return 'Raid auto-trigger is off; turn on raid mode yourself with `/raid mode on` if this is a raid.';
    if (store.settings(guild.id).mode !== 'enforce')
        return 'Anti-nuke is in observe mode, so raid mode was **not** switched on.';
    setRaidMode(store, guild.id, true, 'auto', { hours: c.raidAutoHours, minAgeDays: state.minAgeDays, action: state.action });
    const gate = c.joinGate === false ? '' : await raiseGate(store, logs, guild);
    logEvent('raidmode_auto', { guildId: guild.id, why });
    return [`🛑 **Raid mode switched on automatically for ${c.raidAutoHours} hour${c.raidAutoHours === 1 ? '' : 's'}** (${why}): new and lookalike accounts that join are removed. Turn it off early with \`/raid mode off\`.`, gate].filter(Boolean).join('\n');
}
/** The members who joined in the last `windowMs` (the wave that triggered raid mode), for sweeping. */
export function recentJoiners(guild, windowMs, now = Date.now()) {
    return [...guild.members.cache.values()].filter(m => !m.user.bot && m.joinedTimestamp && now - m.joinedTimestamp <= windowMs);
}
