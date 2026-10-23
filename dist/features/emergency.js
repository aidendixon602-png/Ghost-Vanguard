import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors } from 'discord.js';
import { embed } from '../ui/ui.js';
import { defaults } from '../bot/registry.js';
import { AppError, logEvent } from '../errors.js';
import { RANKS, rankOf } from '../bot/ranks.js';
import { lockGuild, lockdownState, unlockGuild } from '../security/lockdown.js';
import { raidState, setRaidMode } from '../security/raidmode.js';
/**
 * Emergency mode: one action for "we are being raided/nuked right now".
 *   - every channel locked (same as /raid lockdown; staff keep access)
 *   - server invites paused, so nobody new can join
 *   - raid mode on (new joins are removed)
 *   - every Admin / Head Admin role is pinged in the security log
 * "All clear" undoes exactly what emergency mode did and nothing else.
 */
export const EMERGENCY_REASON = 'Emergency mode';
async function pingStaff(store, guild, text) {
    const channelId = store.settings(guild.id).logChannelId;
    const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
    if (!channel?.isSendable())
        return;
    const roles = store.all("SELECT role_id FROM staff_roles WHERE guild_id=? AND level IN ('admin','headadmin')", guild.id).map(r => r.role_id).filter(id => guild.roles.cache.has(id)).slice(0, 10);
    await channel.send({ content: `${roles.map(r => `<@&${r}>`).join(' ')} ${text}`.trim(), allowedMentions: { roles } }).catch(() => { });
}
export async function startEmergency(d, guild, actorId) {
    // A second press (double click, two admins) must not overwrite what the first one recorded.
    if (emergencyOn(d.store, guild.id))
        return 'Emergency mode is already on. Use `/raid emergency stop` when it is over.';
    const steps = [];
    if (lockdownState(d.store, guild.id))
        steps.push('🔒 Server was already locked down');
    else {
        const r = await d.locks.run([guild.id], () => lockGuild(d, guild, actorId, '🚨 Emergency lockdown. Staff are handling an incident; chat is paused.', EMERGENCY_REASON));
        steps.push(`🔒 ${r.locked} of ${r.total} channels locked`);
    }
    const invitesWerePaused = !!guild.features.includes('INVITES_DISABLED');
    if (invitesWerePaused)
        steps.push('🚪 Invites were already paused');
    else
        steps.push(await guild.disableInvites(true).then(() => '🚪 Invites paused (nobody new can join)', () => '⚠ Could not pause invites (needs Manage Server)'));
    const raidWasOn = raidState(d.store, guild.id).enabled;
    if (raidWasOn)
        steps.push('🛑 Raid mode was already on');
    else {
        setRaidMode(d.store, guild.id, true, actorId, { action: 'kick' });
        steps.push('🛑 Raid mode on (new joins are removed)');
    }
    d.store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `emergency:${guild.id}`, JSON.stringify({ by: actorId, at: Date.now(), pausedInvites: !invitesWerePaused, startedRaid: !raidWasOn }));
    await pingStaff(d.store, guild, `🚨 **EMERGENCY MODE** started by <@${actorId}>. Check the security log now.`);
    d.logs.push(guild.id, embed('🚨 Emergency mode ON', `Started by <@${actorId}>\n${steps.join('\n')}\n\nWhen it is over, use \`/raid emergency stop\` or the **All clear** button.`, Colors.Red));
    logEvent('emergency_start', { guildId: guild.id, by: actorId });
    return `**Emergency mode is ON.**\n${steps.join('\n')}\nUse \`/raid emergency stop\` when it is over.`;
}
export async function stopEmergency(d, guild, actorId) {
    const key = `emergency:${guild.id}`, meta = d.store.get('SELECT value FROM runtime_meta WHERE key=?', key);
    if (!meta)
        throw new AppError('VALIDATION_ERROR', 'Emergency mode is not on.');
    const state = JSON.parse(String(meta.value));
    const steps = [];
    const lock = lockdownState(d.store, guild.id);
    if (lock && String(lock.reason) === EMERGENCY_REASON) {
        const r = await d.locks.run([guild.id], () => unlockGuild(d, guild, actorId, '✅ All clear. Chat is open again.', true));
        steps.push(`🔓 ${r.restored} of ${r.total} channels restored`);
    }
    else if (lock)
        steps.push('🔒 A separate lockdown is still on; lift it with `/raid unlock`');
    if (state.pausedInvites)
        steps.push(await guild.disableInvites(false).then(() => '🚪 Invites back on', () => '⚠ Could not turn invites back on (needs Manage Server)'));
    // Only switch off raid mode if emergency mode switched it on.
    if (state.startedRaid !== false) {
        setRaidMode(d.store, guild.id, false, actorId);
        steps.push('🛑 Raid mode off');
    }
    else
        steps.push('🛑 Raid mode left on (it was on before the emergency)');
    d.store.run('DELETE FROM runtime_meta WHERE key=?', key);
    d.logs.push(guild.id, embed('✅ Emergency mode OFF', `Ended by <@${actorId}>\n${steps.join('\n')}`, Colors.Green));
    logEvent('emergency_stop', { guildId: guild.id, by: actorId });
    return `**All clear.**\n${steps.join('\n')}`;
}
export const emergencyOn = (store, guild) => !!store.get('SELECT 1 FROM runtime_meta WHERE key=?', `emergency:${guild}`);
export const emergencyPanel = () => ({
    embeds: [embed('🚨 Emergency controls', 'Press **Emergency** if the server is being raided or nuked. It locks every channel, pauses invites, turns on raid mode and pings Admins.\nPress **All clear** when it is over. Admins and above only.', Colors.Red)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('emergency:start').setLabel('🚨 Emergency').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('emergency:stop').setLabel('✅ All clear').setStyle(ButtonStyle.Success))],
});
/** Panel buttons. "Emergency" asks once more (one accidental click must not lock a server). */
export function registerEmergencyControls(registry) {
    registry.component({ prefix: 'emergency:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'member', cooldown: 2000 }, execute: async (ctx, i) => {
            const action = i.customId.split(':')[1];
            if (rankOf(ctx.store, i.guildId, i.user.id, ctx.actor, 'emergency') < RANKS.admin && i.user.id !== i.guild.ownerId)
                throw new AppError('PERMISSION_ERROR', 'Only Admins and above can use emergency controls.');
            const deps = { store: ctx.store, logs: ctx.logs, locks: ctx.snapshots.locks };
            if (action === 'start') {
                if (emergencyOn(ctx.store, i.guildId))
                    return 'Emergency mode is already on. Press **All clear** when it is over.';
                await i.editReply({ embeds: [embed('Start emergency mode?', 'This locks every channel, pauses invites, turns on raid mode and pings Admins.', Colors.Red)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('emergency:confirm').setLabel('Yes, lock everything').setStyle(ButtonStyle.Danger))] });
                return;
            }
            if (action === 'confirm')
                return startEmergency(deps, i.guild, i.user.id); // re-checks that it is not already on
            if (action === 'stop')
                return stopEmergency(deps, i.guild, i.user.id);
            throw new AppError('VALIDATION_ERROR', 'Unknown emergency control.');
        } });
}
