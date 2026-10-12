import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { checkTarget } from '../../ui/ui.js';
import { staffReason } from '../../security/raidmode.js';

export default defineCommand(new SlashCommandBuilder().setName('nick').setDescription('Set or reset a member\'s server nickname')
    .addSubcommand(s => s.setName('set').setDescription('Give a member a nickname').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('nickname').setDescription('New nickname (max 32 characters)').setRequired(true).setMaxLength(32)))
    .addSubcommand(s => s.setName('reset').setDescription('Remove a member\'s nickname').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))),
{ category: 'moderation', access: 'member', requiredPermissions: [PermissionFlagsBits.ManageNicknames], botPermissions: [PermissionFlagsBits.ManageNicknames], cooldown: 1500 }, async (ctx, i) => {
    const user = i.options.getUser('user', true), member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new AppError('VALIDATION_ERROR', 'That user is not in this server.');
    if (user.id !== ctx.actor!.id) checkTarget(ctx.actor!, member, await i.guild.members.fetchMe());
    if (!member.manageable) throw new AppError('PERMISSION_ERROR', 'Vanguard cannot change this member\'s nickname (role hierarchy).');
    const nickname = i.options.getSubcommand() === 'set' ? i.options.getString('nickname', true) : null;
    await member.setNickname(nickname, staffReason(ctx.actor!.id, nickname ? `/mod nick set ${nickname}` : '/mod nick reset'));
    return nickname ? `<@${user.id}> is now **${nickname}**.` : `Nickname reset for <@${user.id}>.`;
});
