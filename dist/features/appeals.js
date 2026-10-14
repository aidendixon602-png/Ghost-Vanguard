import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';
import { clip } from '../core.js';
import { embed } from '../ui/ui.js';
import { defaults } from '../bot/registry.js';
import { AppError, logEvent } from '../errors.js';
import { RANKS, rankOf } from '../bot/ranks.js';
import { staffReason } from '../security/raidmode.js';
import { getFeature } from './settings.js';
import { activeBan, assertLocalUnban, recordId } from '../security/network-ban.js';
export const APPEALS_DEFAULTS = { enabled: false, channelId: null };
export const appealsConfig = (store, guild) => getFeature(store, guild, 'appeals', APPEALS_DEFAULTS);
const RETRY = 7 * 24 * 3600000;
/** DM the banned user (call BEFORE banning: after the ban they may share no server with the bot). */
export async function sendBanNotice(store, guild, user, reason, extra = '') {
    if (user.bot)
        return false;
    const c = appealsConfig(store, guild.id);
    const canAppeal = c.enabled && !!c.channelId;
    return Promise.resolve().then(() => user.send({
        embeds: [embed(`You were banned from ${guild.name}`, `**Reason:** ${clip(reason, 1000)}${extra ? `\n${extra}` : ''}${canAppeal ? '\n\nIf you think this was a mistake, press **Appeal** to send your side to the staff team.' : ''}`, Colors.Red)],
        components: canAppeal ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`appealdm:open:${guild.id}`).setLabel('Appeal').setStyle(ButtonStyle.Primary))] : [],
        allowedMentions: { parse: [] },
    })).then(() => true, () => false);
}
/** Whether this user may submit an appeal right now; a reason when not. */
export function appealBlock(store, guild, user, now = Date.now()) {
    const network = activeBan(store, 'hardban', user) ?? activeBan(store, 'genreban', user);
    if (network)
        return `You are banned from every server Midtown Vanguard protects (${network.kind} ${recordId(network)}). Server staff cannot lift that ban, so it cannot be appealed here.`;
    if (store.get("SELECT 1 FROM appeals WHERE guild_id=? AND user_id=? AND status='pending'", guild, user))
        return 'You already have an appeal waiting for the staff team.';
    const denied = store.get("SELECT decided_at FROM appeals WHERE guild_id=? AND user_id=? AND status='denied' ORDER BY id DESC LIMIT 1", guild, user);
    if (denied && now - Number(denied.decided_at) < RETRY)
        return `Your last appeal was denied. You can appeal again <t:${Math.floor((Number(denied.decided_at) + RETRY) / 1000)}:R>.`;
    return null;
}
const staffButtons = (guild, id, disabled = false) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`appeal:accept:${guild}:${id}`).setLabel('Accept (unban)').setStyle(ButtonStyle.Success).setDisabled(disabled), new ButtonBuilder().setCustomId(`appeal:deny:${guild}:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled));
/**
 * Appeal buttons and forms inside DMs. The normal router needs a server, so index.ts sends
 * DM interactions starting with "appealdm:" here instead.
 */
export async function handleAppealDm(i, store, client) {
    if (!(i.isButton() || i.isModalSubmit()) || !i.customId.startsWith('appealdm:'))
        return false;
    const [, action, guildId] = i.customId.split(':');
    const answer = (payload) => (i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, flags: MessageFlags.Ephemeral })).catch(() => { });
    const fail = (text) => answer({ embeds: [embed('Appeal', text, Colors.Red)] });
    const stop = async (text) => { await fail(text); return true; };
    try {
        if (!guildId || !/^\d{17,20}$/.test(guildId))
            return await stop('This appeal button is no longer valid.');
        const guild = client.guilds.cache.get(guildId);
        if (!guild || !store.isAuthorized(guildId))
            return await stop('That server is not available right now.');
        const c = appealsConfig(store, guildId);
        if (!c.enabled || !c.channelId)
            return await stop('This server is not accepting appeals.');
        const blocked = store.readGuild(guildId, () => appealBlock(store, guildId, i.user.id));
        if (blocked)
            return await stop(blocked);
        if (i.isButton() && action === 'open') {
            await i.showModal(new ModalBuilder().setCustomId(`appealdm:submit:${guildId}`).setTitle(`Appeal · ${guild.name}`.slice(0, 45)).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('why').setLabel('Why should you be unbanned?').setStyle(TextInputStyle.Paragraph).setMinLength(20).setMaxLength(1000).setRequired(true))));
            return true;
        }
        if (i.isModalSubmit() && action === 'submit') {
            // Several Discord calls follow; acknowledge first so the 3-second deadline cannot be missed.
            await i.deferReply();
            const banned = await guild.bans.fetch({ user: i.user.id, force: true }).catch(() => null);
            if (!banned)
                return await stop('You are not banned from that server, so there is nothing to appeal.');
            const text = i.fields.getTextInputValue('why').trim();
            const channel = await guild.channels.fetch(c.channelId).catch(() => null);
            if (!channel?.isSendable())
                return await stop('The staff appeals channel is unavailable. Try again later.');
            const id = await store.withAuthorized(guildId, async () => {
                store.run('INSERT INTO appeals(guild_id,user_id,text,at) VALUES(?,?,?,?)', guildId, i.user.id, text, Date.now());
                return Number(store.get('SELECT MAX(id) AS id FROM appeals WHERE guild_id=? AND user_id=?', guildId, i.user.id)?.id);
            });
            const cases = store.readGuild(guildId, () => store.all("SELECT number,action,reason,at FROM cases WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 3", guildId, i.user.id));
            let msg;
            try {
                msg = await channel.send({ embeds: [embed(`Ban appeal #${id}`, `**User:** <@${i.user.id}> (${i.user.tag}) · \`${i.user.id}\`\n**Ban reason:** ${clip(banned.reason ?? 'none recorded', 300)}\n${cases.length ? `**Recent cases:** ${cases.map(r => `#${r.number} ${r.action}`).join(', ')}\n` : ''}\n**Their appeal:**\n${clip(text, 1500)}`, Colors.Blurple)], components: [staffButtons(guildId, id)], allowedMentions: { parse: [] } });
            }
            catch (error) {
                // Staff never saw it, so do not leave a "pending" appeal that blocks the next try.
                await store.withAuthorized(guildId, async () => store.run('DELETE FROM appeals WHERE guild_id=? AND id=?', guildId, id)).catch(() => { });
                throw error;
            }
            await store.withAuthorized(guildId, async () => store.run('UPDATE appeals SET message_id=? WHERE guild_id=? AND id=?', msg.id, guildId, id)).catch(() => { });
            await answer({ embeds: [embed('Appeal sent', `Your appeal to **${guild.name}** was sent to the staff team. You will get a DM with their decision.`, Colors.Green)] });
            return true;
        }
        await fail('Unknown appeal action.');
    }
    catch (error) {
        logEvent('appeal_dm_failure', { userId: i.user.id, guildId, detail: error instanceof Error ? error.message : String(error) });
        await fail('Something went wrong sending your appeal. Try again later.');
    }
    return true;
}
/** Accept / Deny on the staff appeal message. Deny: Moderator rank or Ban Members. Accept (unbans): Admin rank or Administrator. */
export function registerAppealControls(registry) {
    registry.component({ prefix: 'appeal:', kinds: ['button'], metadata: { ...defaults, category: 'moderation', access: 'member', cooldown: 0 }, execute: async (ctx, i) => {
            const m = /^appeal:(accept|deny):(\d{17,20}):(\d{1,10})$/.exec(i.customId);
            if (!m || m[2] !== i.guildId)
                throw new AppError('VALIDATION_ERROR', 'Unknown appeal control.');
            const actor = ctx.actor;
            if (rankOf(ctx.store, i.guildId, actor.id, actor) < RANKS.moderator && !actor.permissions.has(PermissionFlagsBits.BanMembers))
                throw new AppError('PERMISSION_ERROR', 'You need the Moderator rank or Ban Members to decide appeals.');
            const id = Number(m[3]), row = ctx.store.get('SELECT * FROM appeals WHERE guild_id=? AND id=?', i.guildId, id);
            if (!row)
                throw new AppError('VALIDATION_ERROR', 'That appeal no longer exists.');
            if (row.status !== 'pending')
                throw new AppError('VALIDATION_ERROR', `Appeal #${id} was already ${row.status}.`);
            const accept = m[1] === 'accept';
            // Accepting lifts the ban, and lifting bans is for Admins and owners (same as /mod unban).
            if (accept && rankOf(ctx.store, i.guildId, actor.id, actor) < RANKS.admin && !actor.permissions.has(PermissionFlagsBits.Administrator))
                throw new AppError('PERMISSION_ERROR', 'Accepting an appeal unbans them, so it needs the Admin rank or Administrator. Moderators can still deny appeals.');
            if (accept) {
                // An appeal decides this server's own ban only; it can never lift a genreban or hardban.
                await assertLocalUnban(ctx.store, i.guild, row.user_id);
                await i.guild.members.unban(row.user_id, staffReason(actor.id, `ban appeal #${id} accepted`)).catch((e) => { if (e?.code !== 10026)
                    throw e; });
                ctx.store.recordCase(i.guildId, row.user_id, actor.id, 'unban (appeal)', `Ban appeal #${id} accepted`);
                // Their Roblox account was blacklisted when they were banned; an accepted appeal lifts that too.
                ctx.store.run('DELETE FROM blocked_accounts WHERE guild_id=? AND reason=?', i.guildId, `Linked Discord account banned: ${row.user_id}`);
                ctx.store.run('DELETE FROM roblox_network WHERE guild_id=? AND reason=?', i.guildId, `Linked Discord account banned: ${row.user_id}`);
            }
            ctx.store.run('UPDATE appeals SET status=?,decided_by=?,decided_at=? WHERE guild_id=? AND id=?', accept ? 'accepted' : 'denied', actor.id, Date.now(), i.guildId, id);
            const user = await i.client.users.fetch(row.user_id).catch(() => null);
            const told = user ? await user.send({ embeds: [embed(`Your appeal to ${i.guild.name}`, accept ? 'Your appeal was **accepted** and you have been unbanned. You can rejoin with a new invite.' : 'Your appeal was **denied**. You can appeal again in 7 days.', accept ? Colors.Green : Colors.Red)], allowedMentions: { parse: [] } }).then(() => true, () => false) : false;
            const old = i.message?.embeds?.[0];
            await i.message?.edit({ embeds: [embed(`${old?.title ?? `Ban appeal #${id}`} · ${accept ? 'ACCEPTED' : 'DENIED'}`, `${old?.description ?? ''}\n\n**${accept ? 'Accepted (unbanned)' : 'Denied'} by** <@${actor.id}> <t:${Math.floor(Date.now() / 1000)}:R>`.slice(0, 4000), accept ? Colors.Green : Colors.Red)], components: [staffButtons(i.guildId, id, true)] }).catch(() => { });
            return `Appeal #${id} ${accept ? 'accepted: they are unbanned' : 'denied'}.${told ? ' They were told by DM.' : ' Their DMs are closed, so they were not told.'}`;
        } });
}
