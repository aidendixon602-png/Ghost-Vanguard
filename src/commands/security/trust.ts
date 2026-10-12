import { Colors, SlashCommandBuilder } from 'discord.js';
import { AppError } from '../../errors.js';
import { defineCommand, type CommandContext } from '../../bot/registry.js';
import { trustListPage } from '../../ui/antinuke-panel.js';
import { panelFor, trustPanel } from '../../ui/trust-panel.js';
import { embed } from '../../ui/ui.js';

export default defineCommand(new SlashCommandBuilder().setName('trust').setDescription('Anti-nuke whitelist: choose what trusted users or roles may do')
    .addSubcommand(s => s.setName('manage').setDescription('Open the whitelist panel: pick who, tick what they may do, pick how long, Save')
        .addUserOption(o => o.setName('user').setDescription('Open the panel on this user (optional)'))
        .addRoleOption(o => o.setName('role').setDescription('Or open it on this role (optional)')))
    .addSubcommand(s => s.setName('verification-bot').setDescription('Let a verification bot (Bloxlink, RoVer) give verified roles without tripping anti-nuke')
        .addUserOption(o => o.setName('bot').setDescription('The verification bot').setRequired(true))
        .addBooleanOption(o => o.setName('allowed').setDescription('True to allow, false to remove').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Show everyone on the whitelist, what they skip and when it expires')
        .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(100000))
        .addBooleanOption(o => o.setName('expired').setDescription('Include expired entries'))), { category: 'security', cooldown: 1500, access: 'security' }, async (ctx: CommandContext, i) => {
    const actor = ctx.actor!;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
        await i.editReply(trustListPage(ctx, i.guildId, i.user.id, i.options.getInteger('page') ?? 1, i.options.getBoolean('expired') ?? false));
        return;
    }
    if (sub === 'verification-bot') {
        const bot = i.options.getUser('bot', true), allowed = i.options.getBoolean('allowed', true);
        if (!bot.bot) throw new AppError('VALIDATION_ERROR', 'That is a person, not a bot. To whitelist a person use /antinuke trust manage.');
        if (allowed) ctx.store.grant(i.guildId, bot.id, 'bot', actor.id); else ctx.store.revokeGrant(i.guildId, bot.id, 'bot', actor.id);
        ctx.logs.push(i.guildId, embed('Verification bot exemption changed', `By <@${actor.id}> · ${allowed ? 'allowed' : 'removed'} <@${bot.id}> (member role updates only)`, Colors.Orange));
        return `<@${bot.id}> ${allowed ? 'can now give verified roles without tripping anti-nuke. Every other rule still applies to it.' : 'no longer has the verification exemption.'}`;
    }
    // manage: open the panel, preloaded with the chosen user/role and what they have saved.
    const user = i.options.getUser('user'), role = i.options.getRole('role');
    if (user && role) throw new AppError('VALIDATION_ERROR', 'Pick a user or a role, not both. You can switch inside the panel.');
    if (role?.id === i.guildId) throw new AppError('VALIDATION_ERROR', 'You cannot whitelist @everyone.');
    await i.editReply(trustPanel(ctx, i.guildId, i.user.id, panelFor(ctx, i.guildId, (user ?? role)?.id ?? null, !!role)));
});
