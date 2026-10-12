import { Colors, EmbedBuilder, Guild, GuildMember, PermissionFlagsBits } from 'discord.js';
import { clip } from '../core.js';
import { AppError } from '../errors.js';

export function embed(title: string, description: string, color: number = Colors.Blurple) {
    return new EmbedBuilder().setColor(color).setTitle(title).setDescription(clip(description, 3900))
        .setFooter({ text: 'Midtown Vanguard' }).setTimestamp();
}

export function checkTarget(actor: GuildMember, target: GuildMember, bot: GuildMember) {
    if ([actor.id, bot.id, actor.guild.ownerId].includes(target.id))
        throw new AppError('VALIDATION_ERROR', 'You cannot target yourself, this bot, or the server owner.');
    if (actor.id !== actor.guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        throw new AppError('VALIDATION_ERROR', 'The target has an equal or higher role than you.');
    if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        throw new AppError('VALIDATION_ERROR', 'Move the bot role above the target’s roles first.');
}

export async function memberOrNull(guild: Guild, id: string): Promise<GuildMember | null> {
    try {
        return await guild.members.fetch({ user: id, force: true });
    } catch (error) {
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
