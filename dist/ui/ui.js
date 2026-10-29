import { Colors, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { PRODUCT_NAME } from '../branding.js';
import { clip } from '../core.js';
import { isProtectedUser } from '../bot/env-rules.js';
import { developers } from '../bot/developers.js';
import { isWhitelistedPerson, whitelistedMessage } from '../bot/trusted-bots.js';
import { AppError } from '../errors.js';
export function embed(title, description, color = Colors.Blurple) {
    return new EmbedBuilder().setColor(color).setTitle(title).setDescription(clip(description, 3900))
        .setFooter({ text: PRODUCT_NAME }).setTimestamp();
}
/** PROTECTED_USERS (.env): only Developers may moderate them. */
export function assertNotProtectedUser(targetId, actorId) {
    if (isWhitelistedPerson(targetId))
        throw new AppError('PERMISSION_ERROR', whitelistedMessage(targetId));
    if (isProtectedUser(targetId) && !developers.has(actorId))
        throw new AppError('PERMISSION_ERROR', `<@${targetId}> is a protected user (set in the bot settings). Only a Developer can ban, kick, time out or change their roles.`);
}
export function checkTarget(actor, target, bot) {
    assertNotProtectedUser(target.id, actor.id);
    if ([actor.id, bot.id, actor.guild.ownerId].includes(target.id))
        throw new AppError('VALIDATION_ERROR', 'You cannot target yourself, this bot, or the server owner.');
    if (actor.id !== actor.guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        throw new AppError('VALIDATION_ERROR', 'The target has an equal or higher role than you.');
    if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        throw new AppError('VALIDATION_ERROR', 'Move the bot role above the target’s roles first.');
}
export async function memberOrNull(guild, id) {
    try {
        return await guild.members.fetch({ user: id, force: true });
    }
    catch (error) {
        if (typeof error === 'object' && error && 'code' in error && error.code === 10007)
            return null;
        throw new AppError('VALIDATION_ERROR', 'Could not confirm target membership or role hierarchy. No action was taken; try again later.');
    }
}
export const REQUIRED_PERMISSIONS = [PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageNicknames, PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
