import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { addConfirmation, showLayoutReview } from '../../ui/layout-ui.js';
import { deletionReview, snapshotPage } from '../../ui/snapshot-ui.js';
import { selectComponents } from '../../recovery/recovery.js';
import { defineCommand } from '../../bot/registry.js';

export default defineCommand(new SlashCommandBuilder().setName('backup').setDescription('Save, list, restore and delete server layout backups')
    .addSubcommand(s => s.setName('create').setDescription('Save a manual server backup'))
    .addSubcommand(s => s.setName('list').setDescription('List this server\'s backups, newest first').addIntegerOption(o => o.setName('page').setDescription('Page number (1 = newest)').setMinValue(1).setMaxValue(100000)))
    .addSubcommand(s => s.setName('restore').setDescription('Preview restoring a backup, then confirm').addIntegerOption(o => o.setName('number').setDescription('Number from /recovery backup list or /recovery snapshot list; newest by default').setMinValue(1)))
    .addSubcommand(s => s.setName('delete').setDescription('Delete backups: one (3), several (3,5,7), a range (2-6) or all').addStringOption(o => o.setName('numbers').setDescription('e.g. 3 · 3,5,7 · 2-6 · all').setRequired(true).setMaxLength(200))),
    { category: 'security', access: 'security' }, async (ctx, i) => {
    const sub = i.options.getSubcommand();
    if (sub === 'create') {
        const id = await ctx.snapshots.locks.run([i.guildId], () => ctx.snapshots.save(i.guild, i.user.id, 'backup'));
        return `Server backup **#${ctx.snapshots.numberOf(i.guildId, id)}** saved. Restore it with /recovery backup restore.`;
    }
    if (sub === 'list') {
        await i.editReply(snapshotPage(ctx, i.guildId, i.user.id, i.options.getInteger('page') ?? 1, true));
        return;
    }
    if (sub === 'delete') {
        const numbers = ctx.snapshots.resolveNumbers(i.guildId, i.options.getString('numbers', true), 'backups');
        await deletionReview(ctx, i, numbers.map(n => ctx.snapshots.idFor(i.guildId, n)));
        return;
    }
    const number = i.options.getInteger('number');
    const snap = ctx.snapshots.load(i.guildId, number ? ctx.snapshots.idFor(i.guildId, number) : undefined);
    const key = addConfirmation(ctx, { guild: i.guildId, user: i.user.id, snapshot: snap.id, prune: false, fingerprint: '', components: selectComponents() });
    await showLayoutReview(ctx, i, key, ctx.confirmations.get(key)!);
}, { subcommands: { create: { botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] }, restore: { botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] } } });
