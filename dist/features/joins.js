import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors } from 'discord.js';
import { clip } from '../core.js';
import { embed } from '../ui/ui.js';
import { defaults } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { automodConfig } from './automod.js';
import { getFeature } from './settings.js';
import { blacklistEntry } from './roblox-tools.js';
/**
 * Things that happen when someone joins:
 *  - Alt check: their linked Roblox account is on this server's blacklist (a banned member's
 *    account), or is already linked to another Discord account here.
 *  - History: they have past cases or staff notes in this server.
 *  - Welcome: a greeting in the welcome channel, with a Verify button.
 */
const banButtons = (id) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`newacct:kick:${id}`).setLabel('Kick').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`newacct:ban:${id}`).setLabel('Ban (alt)').setStyle(ButtonStyle.Danger));
export async function checkAltAccount(store, logs, roblox, member, trusted) {
    if (member.user.bot || trusted(member.id) || !automodConfig(store, member.guild.id).alts)
        return;
    const robloxId = await roblox.identify(member).catch(() => null);
    if (!robloxId)
        return;
    const entry = blacklistEntry(store, member.guild.id, robloxId);
    // A block made from THIS member's own ban (e.g. a tempban that ended) is not an alt: they are just coming back.
    const blocked = entry && !entry.reason.includes(member.id) ? entry : null;
    const others = store.all('SELECT user_id,username FROM links WHERE guild_id=? AND roblox_id=? AND user_id<>?', member.guild.id, robloxId, member.id);
    if (!blocked && !others.length)
        return;
    const lines = [`**Member:** <@${member.id}> (${member.user.tag}) · \`${member.id}\``, `**Linked Roblox account:** [${robloxId}](https://www.roblox.com/users/${robloxId}/profile)`];
    if (blocked)
        lines.push(`⚠ **This Roblox account is blacklisted here.** ${clip(String(blocked.reason ?? ''), 200)}`);
    if (others.length)
        lines.push(`**Same Roblox account as:** ${others.slice(0, 5).map(o => `<@${o.user_id}>${o.username ? ` (${o.username})` : ''}`).join(', ')}`);
    lines.push('', blocked ? 'This is very likely a banned member on a new Discord account.' : 'Could be an alt, or someone who moved to a new Discord account.');
    logs.push(member.guild.id, embed(blocked ? 'Alt account · banned member\'s Roblox' : 'Alt account · shared Roblox account', lines.join('\n'), blocked ? Colors.Red : Colors.Orange), [banButtons(member.id)]);
}
export function historyOnJoin(store, logs, member) {
    if (member.user.bot)
        return;
    const cases = store.all('SELECT number,action,reason,at FROM cases WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 3', member.guild.id, member.id);
    const total = Number(store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=? AND user_id=?', member.guild.id, member.id)?.n ?? 0);
    const notes = Number(store.get('SELECT COUNT(*) AS n FROM member_notes WHERE guild_id=? AND user_id=?', member.guild.id, member.id)?.n ?? 0);
    if (!total && !notes)
        return;
    const recentCases = cases.map(c => `• **#${c.number} ${c.action}** <t:${Math.floor(c.at / 1000)}:R> · ${clip(String(c.reason), 90)}`).join('\n');
    logs.push(member.guild.id, embed('Returning member with history', `<@${member.id}> (${member.user.tag}) rejoined.\n**Cases:** ${total} · **Staff notes:** ${notes}${recentCases ? `\n${recentCases}` : ''}\n\nFull history: \`/mod history\` · \`/mod note list\``, Colors.Yellow));
}
export const WELCOME_DEFAULTS = { enabled: false, channelId: null, message: 'Welcome to **{server}**, {user}! You are member #{count}.', verifyButton: true };
export const welcomeConfig = (store, guild) => getFeature(store, guild, 'welcome', WELCOME_DEFAULTS);
export function renderWelcome(template, member) {
    return template.replaceAll('{user}', `<@${member.id}>`).replaceAll('{name}', member.user.username).replaceAll('{server}', member.guild.name).replaceAll('{count}', String(member.guild.memberCount)).slice(0, 1900);
}
export async function sendWelcome(store, member) {
    const w = welcomeConfig(store, member.guild.id);
    if (!w.enabled || !w.channelId || member.user.bot)
        return;
    const channel = await member.guild.channels.fetch(w.channelId).catch(() => null);
    if (!channel?.isSendable())
        return;
    const verify = w.verifyButton && store.settings(member.guild.id).verifiedRoleId;
    await channel.send({ content: renderWelcome(w.message, member), allowedMentions: { users: [member.id] },
        components: verify ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('welcome:verify').setLabel('Verify with Roblox').setStyle(ButtonStyle.Success))] : [] });
}
/** The Verify button under welcome messages: anyone can press it to verify themselves. */
export function registerWelcomeControls(registry) {
    registry.component({ prefix: 'welcome:verify', kinds: ['button'], metadata: { ...defaults, category: 'verification', access: 'member', cooldown: 10000 }, execute: async (ctx, i) => {
            const member = ctx.actor ?? await i.guild.members.fetch(i.user.id).catch(() => null);
            if (!member)
                throw new AppError('VALIDATION_ERROR', 'Could not find you in this server. Try /verify.');
            return ctx.roblox.sync(member);
        } });
}
