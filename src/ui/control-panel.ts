import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Colors, EmbedBuilder, OverwriteType, PermissionFlagsBits, StringSelectMenuBuilder,
    UserSelectMenuBuilder, type Guild, type GuildMember, type OverwriteResolvable, type TextChannel } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { AppError } from '../errors.js';
import { developers } from '../bot/developers.js';
import { defaults, type CommandContext, type Registry } from '../bot/registry.js';
import { getFeature, setFeature } from '../features/settings.js';
import { confirmDanger } from './danger-ui.js';
import { undoPlan } from './incident-ui.js';
import { restoreRoles, savedRoles } from '../features/rejoin-roles.js';
import { assertLocalUnban, existingBan } from '../security/network-ban.js';
import { staffReason } from '../security/raidmode.js';
import { clip, dangerous } from '../core.js';
import { isProtectedUser } from '../bot/env-rules.js';
import { getRecord, setStatus, publish } from '../audit/ban-log.js';

/**
 * The control panel: a private #vanguard-control channel with one panel message whose buttons
 * let authorized staff restore or strip roles, undo the bot's own actions and read the recent log,
 * without typing commands.
 *
 * - Who: the button handler uses the "security" access level (server owner, developers, security
 *   admins, admin permission roles, Head Admin rank). The channel is only visible to the same people.
 * - Safety: strip, restore and revert always ask for confirmation, re-check access when confirmed,
 *   respect role hierarchy (never above the bot, never above the person pressing it) and are logged
 *   with who, whom, what and when.
 * - Persistence: buttons use a fixed "vgpanel:" prefix routed by the registry, so they work after restarts.
 */
export const PANEL_CHANNEL = 'vanguard-control';
const KEY = 'control_panel';
type Saved = { channelId: string | null; messageId: string | null };
const EMPTY: Saved = { channelId: null, messageId: null };
const PREFIX = 'vgpanel:';
const WEEK = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- accountability

export function recordPanelAction(store: Store, logs: LogQueue, guildId: string, staffId: string, targetId: string | null, action: string, detail: string, at = Date.now()) {
    store.run('INSERT INTO panel_actions(guild_id,at,staff_id,target_id,action,detail) VALUES(?,?,?,?,?,?)', guildId, at, staffId, targetId, action, clip(detail, 900));
    logs.push(guildId, new EmbedBuilder().setColor(Colors.Blurple).setTitle(`Control panel · ${action}`)
        .addFields(
            { name: 'Staff', value: `<@${staffId}> (\`${staffId}\`)`, inline: true },
            { name: 'Target', value: targetId ? `<@${targetId}> (\`${targetId}\`)` : '—', inline: true },
            { name: 'When', value: `<t:${Math.floor(at / 1000)}:f>`, inline: true },
            { name: 'Result', value: clip(detail, 1000) || '—' },
        ).setFooter({ text: 'Ghost Vanguard control panel' }).setTimestamp(at));
}

// ---------------------------------------------------------------- the panel message

export function panelMessage(store: Store, guildId: string, now = Date.now()) {
    const s = store.settings(guildId);
    const stripped = store.all('SELECT user_id FROM backups WHERE guild_id=? AND active=1 ORDER BY at DESC', guildId).map(r => String(r.user_id));
    const alerts = Number(store.get("SELECT COUNT(*) AS n FROM incidents WHERE guild_id=? AND at>? AND mode<>'warn'", guildId, now - 86400000)?.n ?? 0);
    const warnings = Number(store.get("SELECT COUNT(*) AS n FROM incidents WHERE guild_id=? AND at>? AND mode='warn'", guildId, now - 86400000)?.n ?? 0);
    const cases = Number(store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=? AND at>?', guildId, now - 86400000)?.n ?? 0);
    const last = store.get('SELECT * FROM panel_actions WHERE guild_id=? ORDER BY at DESC LIMIT 1', guildId);
    const embed = new EmbedBuilder().setColor(Colors.Blurple).setTitle('🛡️ Ghost Vanguard · Control Panel')
        .setDescription('Manage moderation and anti-nuke actions with the buttons below.\nOnly the server owner and authorized staff can use them. Anything that changes roles asks you to confirm first, and every action is logged.')
        .addFields(
            { name: 'Anti-nuke', value: !s.enabled ? '🔴 Off' : s.mode === 'enforce' ? '🟢 On' : '🟠 Watch-only', inline: true },
            { name: 'Last 24 hours', value: `${alerts} alert(s) · ${warnings} warning(s) · ${cases} case(s)`, inline: true },
            { name: 'Stripped right now', value: stripped.length ? `${stripped.slice(0, 8).map(id => `<@${id}>`).join(' ')}${stripped.length > 8 ? ` +${stripped.length - 8}` : ''}` : 'Nobody', inline: false },
            { name: 'Last panel action', value: last ? `**${last.action}** · <@${last.target_id ?? last.staff_id}> by <@${last.staff_id}> · <t:${Math.floor(Number(last.at) / 1000)}:R>` : 'None yet', inline: false },
            { name: 'Buttons', value: '🟢 **Restore Roles**: give back roles the bot removed\n🔴 **Strip Roles**: remove someone\'s staff/admin roles\n↩️ **Revert Action**: undo a recent strip or ban made by the bot\n📋 **View Logs** · 🔄 **Refresh Panel**', inline: false },
        ).setFooter({ text: 'Updated' }).setTimestamp(now);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}restore`).setLabel('Restore Roles').setEmoji('🟢').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PREFIX}strip`).setLabel('Strip Roles').setEmoji('🔴').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${PREFIX}revert`).setLabel('Revert Action').setEmoji('↩️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${PREFIX}logs`).setLabel('View Logs').setEmoji('📋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${PREFIX}refresh`).setLabel('Refresh Panel').setEmoji('🔄').setStyle(ButtonStyle.Secondary));
    return { embeds: [embed], components: [row], allowedMentions: { parse: [] as never[] } };
}

// ---------------------------------------------------------------- the private channel

/** Everyone who should see the channel: the owner, security admins, admin permission roles and Head Admin/Admin staff roles. */
export function panelOverwrites(store: Store, guild: Pick<Guild, 'id' | 'ownerId' | 'roles'>, botId: string): OverwriteResolvable[] {
    const view = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    const out: OverwriteResolvable[] = [
        { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: botId, type: OverwriteType.Member, allow: [...view, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
        { id: guild.ownerId, type: OverwriteType.Member, allow: view },
    ];
    const seen = new Set([guild.id, botId, guild.ownerId]);
    const users = store.all("SELECT user_id FROM grants WHERE guild_id=? AND kind='admin' AND (expires IS NULL OR expires>?) LIMIT 50", guild.id, Date.now()).map(r => String(r.user_id));
    for (const id of users) if (!seen.has(id)) { seen.add(id); out.push({ id, type: OverwriteType.Member, allow: view, deny: [PermissionFlagsBits.SendMessages] }); }
    const roles = [
        ...store.all("SELECT role_id FROM permission_roles WHERE guild_id=? AND access='admin'", guild.id),
        ...store.all("SELECT role_id FROM staff_roles WHERE guild_id=? AND level IN ('admin','headadmin')", guild.id),
    ].map(r => String(r.role_id));
    for (const id of roles) if (!seen.has(id) && guild.roles.cache.has(id)) { seen.add(id); out.push({ id, type: OverwriteType.Role, allow: view, deny: [PermissionFlagsBits.SendMessages] }); }
    return out;
}

/** Create (or update) the private channel and its single panel message. Running it again never duplicates either. */
export async function setupPanel(store: Store, guild: Guild, by: string): Promise<{ channel: TextChannel; created: boolean; reposted: boolean; viewers: number }> {
    const me = await guild.members.fetchMe();
    const saved = getFeature<Saved>(store, guild.id, KEY, EMPTY);
    const overwrites = panelOverwrites(store, guild, me.id);
    let channel = (saved.channelId ? await guild.channels.fetch(saved.channelId).catch(() => null) : null) as TextChannel | null;
    if (!channel || channel.type !== ChannelType.GuildText)
        channel = (guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === PANEL_CHANNEL) as TextChannel | undefined) ?? null;
    let created = false;
    if (!channel) {
        channel = await guild.channels.create({ name: PANEL_CHANNEL, type: ChannelType.GuildText, topic: 'Ghost Vanguard control panel: authorized staff only. Every action here is logged.',
            permissionOverwrites: overwrites, reason: `${by}: /setup panel` });
        created = true;
    } else await channel.permissionOverwrites.set(overwrites, `${by}: /setup panel (refresh access)`);
    const payload = panelMessage(store, guild.id);
    let message = saved.messageId && saved.channelId === channel.id ? await channel.messages.fetch(saved.messageId).catch(() => null) : null;
    let reposted = false;
    if (message) await message.edit(payload);
    else { message = await channel.send(payload); reposted = true; }
    setFeature<Saved>(store, guild.id, KEY, EMPTY, { channelId: channel.id, messageId: message.id }, by);
    return { channel, created, reposted, viewers: overwrites.length - 2 };
}

/** Refresh the panel message wherever it is (after any panel action). Quietly does nothing if there is none. */
export async function refreshPanel(store: Store, guild: Guild) {
    const saved = getFeature<Saved>(store, guild.id, KEY, EMPTY);
    if (!saved.channelId || !saved.messageId) return;
    const channel = await guild.channels.fetch(saved.channelId).catch(() => null) as TextChannel | null;
    const message = channel ? await channel.messages.fetch(saved.messageId).catch(() => null) : null;
    if (message) await message.edit(panelMessage(store, guild.id)).catch(() => null);
}

// ---------------------------------------------------------------- checks

const isBoss = (guild: Pick<Guild, 'ownerId'>, id: string) => id === guild.ownerId || developers.has(id);

/** Strip checks: never yourself, the owner, the bot or a developer; never someone at or above you (unless you are the owner/a developer). */
export function canStrip(guild: Pick<Guild, 'ownerId'>, actor: GuildMember, target: GuildMember | null, botId: string): string | null {
    if (!target) return 'That user is not in this server.';
    if (target.id === actor.id) return 'You cannot strip yourself.';
    if (target.id === guild.ownerId) return 'The server owner cannot be stripped.';
    if (target.id === botId || developers.has(target.id)) return 'Ghost Vanguard and its developers cannot be stripped.';
    if (isProtectedUser(target.id) && !developers.has(actor.id)) return `<@${target.id}> is a protected user (set in the bot settings). Only a Developer can strip them.`;
    if (!target.manageable) return `<@${target.id}> has a role at or above Ghost Vanguard's highest role, so the bot cannot change their roles. Move the bot's role above theirs first.`;
    if (!isBoss(guild, actor.id) && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) return `<@${target.id}>'s highest role is equal to or above yours.`;
    return null;
}

// ---------------------------------------------------------------- what can be reverted

export interface Revertible { value: string; label: string; description: string }
export function revertibles(store: Store, guildId: string, now = Date.now()): Revertible[] {
    const out: Revertible[] = [];
    for (const r of store.all("SELECT * FROM incidents WHERE guild_id=? AND at>? AND mode='enforce' ORDER BY at DESC LIMIT 15", guildId, now - WEEK)) {
        const result = String(r.result ?? '');
        if (!/^Removed [1-9]\d* dangerous role/.test(result) || / Undone by \d+\./.test(result)) continue;
        if (!store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=?', guildId, r.actor_id)) continue;
        out.push({ value: `inc:${r.id}`, label: `Undo anti-nuke strip · incident #${r.id}`, description: `Gives ${r.actor_id} their roles back · ${new Date(Number(r.at)).toUTCString().slice(5, 22)} UTC` });
    }
    for (const r of store.all("SELECT * FROM ban_records WHERE guild_id=? AND status='banned' AND banned_at>? AND kind NOT IN ('genreban','hardban') AND moderator_role IN ('via-bot','automatic') ORDER BY banned_at DESC LIMIT 10", guildId, now - WEEK))
        out.push({ value: `ban:${r.id}`, label: `Unban · ${clip(String(r.username ?? r.user_id), 40)}`, description: clip(`${r.reason ?? 'No reason given'}`, 100) });
    return out.slice(0, 25);
}

// ---------------------------------------------------------------- recent activity

export function recentActivity(store: Store, guildId: string, limit = 15): string {
    const rows: { at: number; line: string }[] = [];
    for (const r of store.all('SELECT * FROM panel_actions WHERE guild_id=? ORDER BY at DESC LIMIT ?', guildId, limit))
        rows.push({ at: Number(r.at), line: `🛡️ **${r.action}** · ${r.target_id ? `<@${r.target_id}>` : '—'} · by <@${r.staff_id}> · ${clip(String(r.detail ?? ''), 80)}` });
    for (const r of store.all('SELECT * FROM incidents WHERE guild_id=? ORDER BY at DESC LIMIT ?', guildId, limit))
        rows.push({ at: Number(r.at), line: `${r.mode === 'warn' ? '⚠️ **Anti-nuke warning**' : '🚨 **Anti-nuke**'} · <@${r.actor_id}> · ${r.rule} · by Ghost Vanguard${/ Undone by (\d+)\./.test(String(r.result)) ? ' · undone' : ''}` });
    for (const r of store.all('SELECT * FROM cases WHERE guild_id=? ORDER BY at DESC LIMIT ?', guildId, limit))
        rows.push({ at: Number(r.at), line: `🔨 **${r.action}** · <@${r.user_id}> · by <@${r.moderator_id}> · ${clip(String(r.reason ?? ''), 60)}` });
    rows.sort((a, b) => b.at - a.at);
    return rows.slice(0, limit).map(r => `<t:${Math.floor(r.at / 1000)}:R> ${r.line}`).join('\n') || 'Nothing has happened yet.';
}

// ---------------------------------------------------------------- buttons

const pickUser = (action: 'restore' | 'strip', text: string) => ({
    embeds: [new EmbedBuilder().setColor(action === 'strip' ? Colors.Red : Colors.Green).setTitle(action === 'strip' ? '🔴 Strip Roles' : '🟢 Restore Roles').setDescription(text)],
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(`${PREFIX}pick:${action}`).setPlaceholder('Pick a member').setMaxValues(1))],
    allowedMentions: { parse: [] as never[] },
});

async function afterAction(ctx: CommandContext, guild: Guild) { await refreshPanel(ctx.store, guild).catch(() => null); }

export function registerControlPanel(registry: Registry) {
    registry.component({ prefix: PREFIX, kinds: ['button', 'select'], metadata: { ...defaults, category: 'security', access: 'security', botPermissions: [PermissionFlagsBits.ManageRoles] },
        execute: async (ctx, i) => {
            const [, action, sub] = i.customId.split(':') as [string, string, string?];
            const guild = i.guild as Guild;
            const actorId = i.user.id as string;

            if (action === 'refresh') {
                await i.message?.edit(panelMessage(ctx.store, guild.id)).catch(() => null);
                return 'Panel refreshed.';
            }
            if (action === 'logs') {
                await i.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle('📋 Recent actions').setDescription(recentActivity(ctx.store, guild.id).slice(0, 4000))
                    .setFooter({ text: 'Panel actions, anti-nuke alerts and moderation cases · newest first' })], allowedMentions: { parse: [] } });
                return;
            }
            if (action === 'restore' || action === 'strip') {
                await i.editReply(pickUser(action, action === 'strip'
                    ? 'Pick the member whose staff/admin roles should be removed. They are saved first, so **Restore Roles** can give them back.'
                    : 'Pick the member whose roles should be given back: roles anti-nuke or a strip removed, or roles they had before leaving the server.'));
                return;
            }
            if (action === 'revert') {
                const options = revertibles(ctx.store, guild.id);
                if (!options.length) return 'Nothing to revert: no strips or bot-made bans from the last 7 days are still in place.';
                await i.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle('↩️ Revert Action').setDescription('Pick what to undo. You will be asked to confirm.')],
                    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}undo`).setPlaceholder('Pick an action to undo')
                        .addOptions(options.map(o => ({ label: clip(o.label, 100), value: o.value, description: clip(o.description, 100) }))))], allowedMentions: { parse: [] } });
                return;
            }

            if (action === 'pick' && (sub === 'strip' || sub === 'restore')) {
                const targetId = i.values?.[0];
                if (!targetId || !/^\d{17,20}$/.test(targetId)) throw new AppError('VALIDATION_ERROR', 'Pick one member.');
                if (sub === 'strip') {
                    const [actor, target] = await Promise.all([guild.members.fetch({ user: actorId, force: true }), guild.members.fetch({ user: targetId, force: true }).catch(() => null)]);
                    const problem = canStrip(guild, actor, target, guild.client.user!.id);
                    if (problem) throw new AppError('PERMISSION_ERROR', problem);
                    const powerful = [...target!.roles.cache.values()].filter(r => r.id !== guild.id && !r.managed && dangerous(r.permissions.bitfield) && r.editable);
                    if (!powerful.length) return `<@${targetId}> has no staff/admin roles the bot can remove.`;
                    await confirmDanger(ctx, i, {
                        title: `Strip ${target!.user?.username ?? targetId}`, summary: `Remove **${powerful.length}** staff/admin role(s) from <@${targetId}>: ${powerful.map(r => `<@&${r.id}>`).join(' ')}`,
                        consequences: ['Their roles are saved first, so **Restore Roles** can give them back.', 'They keep ordinary roles (members, levels, colours).', 'Logged with your name in the security log.'],
                        label: 'Strip roles', reversal: 'Press **Restore Roles** on the panel.',
                        run: async (c: any) => {
                            // Re-check right before acting: roles or positions may have changed since the confirmation was shown.
                            const [a2, t2] = await Promise.all([guild.members.fetch({ user: actorId, force: true }), guild.members.fetch({ user: targetId, force: true }).catch(() => null)]);
                            const again = canStrip(guild, a2, t2, guild.client.user!.id);
                            if (again) throw new AppError('PERMISSION_ERROR', again);
                            const result = await c.security.contain(guild, targetId, false);
                            if (/^Protected/.test(result)) throw new AppError('VALIDATION_ERROR', `<@${targetId}> is on the anti-nuke whitelist (full bypass), so they cannot be stripped. Remove them with \`/antinuke whitelist remove\` first.`);
                            recordPanelAction(c.store, c.logs, guild.id, actorId, targetId, 'Strip Roles', result);
                            await afterAction(c, guild);
                            return `🔴 **Stripped <@${targetId}>.** ${result}`;
                        },
                    });
                    return;
                }
                // Restore: roles a strip saved (quarantine backup) come first; otherwise roles they had before leaving.
                const backup = ctx.store.get('SELECT roles FROM backups WHERE guild_id=? AND user_id=?', guild.id, targetId);
                const left = !backup ? savedRoles(ctx.store, guild.id, targetId) : null;
                if (!backup && !left) return `No saved roles for <@${targetId}>: nothing was stripped from them, and they have not left and rejoined in the last 90 days.`;
                const ids = backup ? JSON.parse(String(backup.roles)) as string[] : left!.roles;
                const boss = isBoss(guild, actorId);
                await confirmDanger(ctx, i, {
                    title: `Restore roles for ${targetId}`, summary: `Give <@${targetId}> back up to **${ids.length}** role(s): ${ids.slice(0, 20).map(id => `<@&${id}>`).join(' ')}`,
                    consequences: [backup ? 'These are the roles saved when they were stripped. Their quarantine ends.' : 'These are the roles they had before leaving the server.',
                        boss ? 'Staff and admin roles are included (you are the owner or a developer).' : 'Staff and admin roles are skipped: only the server owner (or someone allowed by `/role who-can-give`) can give those back.',
                        'Roles at or above the bot are always skipped. Logged with your name.'],
                    label: 'Restore roles', reversal: 'Press **Strip Roles** on the panel.',
                    run: async (c: any) => {
                        let result: string;
                        if (backup) {
                            const target = await guild.members.fetch({ user: targetId, force: true }).catch(() => null);
                            if (!target) throw new AppError('VALIDATION_ERROR', `<@${targetId}> is not in the server; their saved roles are kept for when they come back.`);
                            result = await c.security.release(guild, targetId, isBoss(guild, actorId), actorId);
                        } else {
                            const r = await restoreRoles(c.store, guild, actorId, targetId);
                            result = `Restored ${r.given.length} role(s)${r.skipped.length ? `; skipped ${r.skipped.length} (${r.skipped.map((s: any) => s.reason).slice(0, 3).join('; ')})` : ''}.`;
                        }
                        recordPanelAction(c.store, c.logs, guild.id, actorId, targetId, 'Restore Roles', result);
                        await afterAction(c, guild);
                        return `🟢 **Roles restored for <@${targetId}>.** ${result}`;
                    },
                });
                return;
            }

            if (action === 'undo') {
                const value = i.values?.[0] ?? '';
                const [kind, raw] = value.split(':');
                const id = Number(raw);
                if (kind === 'inc') {
                    const plan = undoPlan(ctx.store, guild.id, id, actorId, guild.ownerId);
                    await confirmDanger(ctx, i, {
                        title: `Undo anti-nuke strip · incident #${id}`, summary: `Give <@${plan.actor}> back the ${plan.roles} role(s) anti-nuke removed for **${plan.rule}**.`,
                        consequences: ['Only for false alarms: they get every removed role back, including staff and admin roles.', 'Their quarantine ends.', 'Logged with your name.'],
                        label: 'Undo strip', reversal: 'Press **Strip Roles** on the panel.',
                        run: async (c: any) => {
                            const again = undoPlan(c.store, guild.id, id, actorId, guild.ownerId);
                            const result = await c.security.release(guild, again.actor, true, actorId);
                            c.store.run('UPDATE incidents SET result=result || ? WHERE guild_id=? AND id=?', ` Undone by ${actorId}.`, guild.id, id);
                            recordPanelAction(c.store, c.logs, guild.id, actorId, again.actor, 'Revert · undo strip', `Incident #${id}. ${result}`);
                            await afterAction(c, guild);
                            return `↩️ **Undone.** ${result}`;
                        },
                    });
                    return;
                }
                if (kind === 'ban') {
                    const record = getRecord(ctx.store, guild.id, id);
                    if (!record || record.status !== 'banned') throw new AppError('VALIDATION_ERROR', 'That ban is no longer active.');
                    await confirmDanger(ctx, i, {
                        title: `Unban ${record.username ?? record.user_id}`, summary: `Lift ban for <@${record.user_id}>.\n**Reason it was made:** ${clip(record.reason ?? 'No reason given', 300)}`,
                        consequences: ['They can rejoin with an invite.', 'Genrebans and hardbans can never be lifted here.', 'Logged with your name, and the ban record in #bans is updated.'],
                        label: 'Unban', reversal: 'Ban them again with `/mod ban`.',
                        run: async (c: any) => {
                            const fresh = getRecord(c.store, guild.id, id);
                            if (!fresh || fresh.status !== 'banned') throw new AppError('VALIDATION_ERROR', 'That ban is no longer active.');
                            const existing = await existingBan(guild, fresh.user_id);
                            if (existing === null) {
                                publish(c.store, c.logs, setStatus(c.store, fresh, 'unbanned', actorId, 'via-bot', 'Already unbanned on Discord'), false);
                                return 'They were already unbanned on Discord, so the record was corrected.';
                            }
                            await assertLocalUnban(c.store, guild, fresh.user_id, existing);
                            await guild.members.unban(fresh.user_id, staffReason(actorId, 'control panel: revert unban'));
                            recordPanelAction(c.store, c.logs, guild.id, actorId, fresh.user_id, 'Revert · unban', `Unbanned <@${fresh.user_id}>.`);
                            await afterAction(c, guild);
                            return `↩️ **Unbanned <@${fresh.user_id}>**.`;
                        },
                    });
                    return;
                }
                throw new AppError('VALIDATION_ERROR', 'That option is no longer available. Press Revert Action again.');
            }
            throw new AppError('VALIDATION_ERROR', 'This panel control is outdated. Press 🔄 Refresh Panel.');
        } });
}
