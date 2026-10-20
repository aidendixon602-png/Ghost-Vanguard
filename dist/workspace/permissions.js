import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { AppError } from '../errors.js';
export function memberOf(i) {
    return i?.member && typeof i.member === 'object' && 'roles' in i.member ? i.member : null;
}
export function hasAnyRole(member, roleIds) {
    return !!member && roleIds.some(id => member.roles.cache.has(String(id)));
}
export function isWorkspaceStaff(member, cfg) {
    return !!member && (member.id === member.guild.ownerId || hasAnyRole(member, [...cfg.roles.staffRoleIds, ...cfg.roles.reviewerRoleIds, ...cfg.roles.managerRoleIds]));
}
export function isWorkspaceReviewer(member, cfg) {
    return !!member && (member.id === member.guild.ownerId || hasAnyRole(member, [...cfg.roles.reviewerRoleIds, ...cfg.roles.managerRoleIds]));
}
export function isWorkspaceManager(member, cfg) {
    return !!member && (member.id === member.guild.ownerId || hasAnyRole(member, cfg.roles.managerRoleIds));
}
export function requireStaff(member, cfg) {
    if (!isWorkspaceStaff(member, cfg))
        throw new AppError('PERMISSION_ERROR', 'This Workspace screen is limited to configured staff.');
}
export function requireReviewer(member, cfg) {
    if (!isWorkspaceReviewer(member, cfg))
        throw new AppError('PERMISSION_ERROR', 'A configured reviewer or manager role is required for this action.');
}
export function requireManager(member, cfg) {
    if (!isWorkspaceManager(member, cfg))
        throw new AppError('PERMISSION_ERROR', 'A configured Workspace manager role or the server owner is required.');
}
export function requireModule(cfg, module) {
    if (!cfg.modules[module])
        throw new AppError('VALIDATION_ERROR', `The ${module} module is disabled in this guild.`);
}
export async function selectedChannel(guild, id, label, types = [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
    if (!id || !/^\d{17,20}$/.test(id))
        throw new AppError('VALIDATION_ERROR', `${label} has not been selected in Workspace setup.`);
    const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
    if (!channel || channel.guildId !== guild.id || !types.includes(channel.type))
        throw new AppError('VALIDATION_ERROR', `${label} is missing or is not a supported channel in this guild.`);
    return channel;
}
export function assertPanelPermissions(channel, me) {
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
        throw new AppError('PERMISSION_ERROR', `Ghost Vanguard needs View Channel, Send Messages, and Embed Links in <#${channel.id}>.`);
}
export function validateRoleSelection(guild, ids, label) {
    const errors = [];
    for (const id of ids) {
        if (!/^\d{17,20}$/.test(id)) {
            errors.push(`${label} contains an invalid Discord role ID.`);
            continue;
        }
        const role = guild.roles.cache.get(id);
        if (!role || role.guild.id !== guild.id || role.managed || role.id === guild.roles.everyone.id)
            errors.push(`${label} contains a role that is missing, managed, or @everyone.`);
    }
    return errors;
}
export function validateChannelSelection(guild, id, label, types = [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
    if (!id)
        return [];
    const channel = guild.channels.cache.get(id);
    return !channel || channel.guildId !== guild.id || !types.includes(channel.type) ? [`${label} must be selected from this guild and be a text or announcement channel.`] : [];
}
