import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { AppError } from '../../errors.js';
import { addConfirmation, checkDestination, showLayoutReview } from '../../ui/layout-ui.js';
import { selectComponents } from '../../recovery/recovery.js';
import { defineCommand } from '../../bot/registry.js';
export default defineCommand(new SlashCommandBuilder().setName('copylayout').setDescription('Copy this server\'s roles and channels to another server Vanguard protects')
    .addStringOption(o => o.setName('destination_id').setDescription('Destination server ID; Vanguard must be installed and authorized').setRequired(true)), { category: 'security', access: 'security', botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] }, async (ctx, i) => {
    const destination = ctx.client.guilds.cache.get(i.options.getString('destination_id', true));
    if (!destination || destination.id === i.guildId)
        throw new AppError('VALIDATION_ERROR', 'Choose a different destination server connected to Vanguard.');
    const components = selectComponents();
    await checkDestination(ctx, destination, i.user.id, components);
    const snap = await ctx.snapshots.prepareCopy(i.guild, destination, i.user.id);
    const key = addConfirmation(ctx, { guild: i.guildId, user: i.user.id, destination: destination.id, snapshot: snap.id, prune: false, fingerprint: '', components });
    await showLayoutReview(ctx, i, key, ctx.confirmations.get(key));
});
