import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { RULES } from '../core.js';
import { VERSION } from '../config.js';
import { antinukeOptedOut } from '../security/locked-antinuke.js';
import { readiness } from '../security/readiness.js';
import { logChannels } from '../audit/log-setup.js';
import { eventLogConfig } from '../audit/event-log.js';
/**
 * The welcome panel Vanguard posts when it joins a server: what is already running, a live
 * checklist of what still needs doing, and buttons that do it (set up the log channels,
 * re-check, open the command list). It is posted at most once every 6 hours per server, so
 * kicking and re-adding the bot cannot spam a channel.
 */
export const WELCOME_COOLDOWN_MS = 6 * 3600000;
export const WELCOME_PREFIX = 'vgwelcome:';
export const WELCOME_HELP_ID = 'vgcommands:open';
/** Whether the bot has Administrator, and where its highest role sits (1 = top). */
export function setupStatus(guild) {
    const me = guild.members?.me;
    const admin = !!me?.permissions?.has(PermissionFlagsBits.Administrator);
    const roles = [...(guild.roles?.cache?.values() ?? [])].filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
    const mine = me?.roles?.highest;
    const rank = mine ? roles.findIndex(r => r.id === mine.id) + 1 : 0;
    return { admin, top: rank === 1, rank, total: roles.length };
}
export function checklist(store, guild) {
    const s = setupStatus(guild);
    const audit = s.admin || !!guild.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog);
    const logsReady = !!store && !!logChannels(store, guild.id).bansChannelId && !!eventLogConfig(store, guild.id).channelId;
    const settings = store ? store.settings(guild.id) : null;
    const optedOut = !!store && antinukeOptedOut(store, guild.id);
    const check = store && settings ? readiness(guild, settings.logChannelId, store) : null;
    const readinessBlockers = check?.missing ?? ['Authorize the server first'];
    const enforcementReady = !!check && check.missing.length === 0;
    const active = !!settings?.enabled;
    const enforcementOn = active && settings?.mode === 'enforce' && !optedOut;
    const enforcingFix = !store
        ? 'Authorize the server first'
        : readinessBlockers.length
            ? `Fix readiness: ${readinessBlockers.join(', ')}; see /antinuke check`
            : 'Run /antinuke enable and confirm to switch from observe to enforce';
    const items = [
        { ok: s.admin, label: 'Administrator permission', fix: 'Server Settings → Roles → Ghost Vanguard → turn on Administrator' },
        { ok: s.top, label: `Role position ${s.rank ? `#${s.rank} of ${s.total}` : 'unknown'}`, fix: 'Drag the Ghost Vanguard role to the very top' },
        { ok: audit, label: 'View Audit Log', fix: 'Needed to see who did what (anti-nuke and logs)' },
        { ok: logsReady, label: 'Log channels', fix: 'Press **Set up logs** below' },
        { ok: enforcementOn, label: 'Anti-nuke enforcement', fix: enforcingFix },
    ];
    return { items, ready: items.filter(i => i.ok).length, logsReady, enforcementOn, enforcementReady, active, optedOut, readinessBlockers };
}
const bar = (done, total) => '🟩'.repeat(done) + '⬛'.repeat(total - done);
/** The panel for a server Vanguard protects. `inviter` is the developer who added it, if known. */
export function welcomePanel(store, guild, inviter = null) {
    const c = checklist(store, guild);
    const all = c.ready === c.items.length;
    const intro = inviter
        ? `Authorized by approved developer <@${inviter}>.`
        : `**${guild.name}** is authorized.`;
    const protection = c.enforcementOn
        ? `Anti-nuke enforcement is active with ${RULES.length} rules.`
        : c.optedOut
            ? 'Staff have opted out of anti-nuke protection; it stays off until they enable it again.'
            : !store
                ? 'This server is not authorized yet; protection is not active.'
                : c.active
                    ? 'Anti-nuke starts in observe mode. Enforcement requires a successful readiness check and an explicit confirmation.'
                    : 'Anti-nuke setup has not initialized yet. Once initialized, it starts in observe mode.';
    const protectionField = c.enforcementOn
        ? `🟢 **Enforce mode** · ${RULES.length} rules · automated containment is active`
        : c.optedOut
            ? '🔴 **Off by staff choice** · use /antinuke enable after readiness is fixed'
            : !store
                ? '⚪ **Not authorized** · protection is not active'
                : c.active
                    ? `🟠 **Observe mode** · incidents are recorded, but actions are not automatically reverted. ${c.enforcementReady ? 'Run /antinuke enable and confirm when ready.' : `Fix readiness: ${c.readinessBlockers.join(', ')}.`}`
                    : '🟠 **Not initialized** · setup will start anti-nuke in observe mode.';
    const e = new EmbedBuilder().setColor(all ? Colors.Green : Colors.Gold)
        .setTitle('🛡️ Ghost Vanguard is online')
        .setDescription([intro, protection].join('\n'))
        .addFields({ name: 'Protection', value: protectionField, inline: false }, { name: `Setup ${bar(c.ready, c.items.length)} ${c.ready}/${c.items.length}`, value: c.items.map(i => `${i.ok ? '✅' : '⚠️'} **${i.label}**${i.ok ? '' : `\n-# ${i.fix}`}`).join('\n') }, { name: 'Good to know', value: '`/help` lists every command you can use · `/antinuke status` shows the rules · `/role` gives roles safely' })
        .setFooter({ text: `Ghost Vanguard v${VERSION} · ${all ? 'fully set up' : 'buttons below finish the setup'}` }).setTimestamp();
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${WELCOME_PREFIX}logs:${inviter ?? '0'}`).setLabel(c.logsReady ? 'Re-check logs' : 'Set up logs').setEmoji('🗂️').setStyle(c.logsReady ? ButtonStyle.Secondary : ButtonStyle.Primary), new ButtonBuilder().setCustomId(`${WELCOME_PREFIX}check:${inviter ?? '0'}`).setLabel('Re-check').setEmoji('🔄').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(WELCOME_HELP_ID).setLabel('Commands').setEmoji('📖').setStyle(ButtonStyle.Secondary));
    return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}
/** Before authorization: a live countdown, no buttons (protected features are off until then). */
export function pendingPanel(guild, deadline) {
    const e = new EmbedBuilder().setColor(Colors.Blurple).setTitle('⏳ Waiting for a Ghost Vanguard developer')
        .setDescription([
        `An approved developer needs to run \`,authserver\` here **<t:${Math.floor(deadline / 1000)}:R>**, or Ghost Vanguard leaves on its own.`,
        '',
        'Until then protection, logs and moderation commands stay off.',
        '-# If a developer invited the bot, this happens automatically when Vanguard can read the audit log.',
    ].join('\n'))
        .setFooter({ text: `Ghost Vanguard v${VERSION}` }).setTimestamp();
    return { embeds: [e], allowedMentions: { parse: [] } };
}
/** Kept for older callers: the checklist embed without buttons. */
export function setupTipsEmbed(guild) {
    return welcomePanel(null, guild).embeds[0];
}
