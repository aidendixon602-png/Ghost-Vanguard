import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { addConfirmation, showLayoutReview } from '../../ui/layout-ui.js';
import { snapshotPage, deletionReview } from '../../ui/snapshot-ui.js';
import { selectComponents } from '../../recovery/recovery.js';
import { AppError } from '../../errors.js';
import { Colors } from 'discord.js';
import { CLEANUP_LABELS, CLEANUP_TYPES, cleanupPlan, cleanupSnapshots } from '../../recovery/cleanup.js';
import { embed } from '../../ui/ui.js';
import { defineCommand } from '../../bot/registry.js';
export default defineCommand(new SlashCommandBuilder().setName('snapshot').setDescription('Save, list, restore and delete server snapshots and backups')
    .addSubcommand(s => s.setName('create').setDescription('Save roles, category/channel layout and permission overwrites'))
    .addSubcommand(s => s.setName('list').setDescription('List this server\'s snapshots and backups, newest first').addIntegerOption(o => o.setName('page').setDescription('Page number (1 = newest)').setMinValue(1).setMaxValue(100000)))
    .addSubcommand(s => s.setName('restore').setDescription('Preview restoring a snapshot or backup, then confirm').addIntegerOption(o => o.setName('number').setDescription('Number from /recovery snapshot list; defaults to the newest').setMinValue(1)).addBooleanOption(o => o.setName('prune').setDescription('Also delete extra manageable roles/channels after a successful restoration')))
    .addSubcommand(s => s.setName('delete').setDescription('Delete snapshots/backups: one (3), several (3,5,7), a range (2-6) or all').addStringOption(o => o.setName('numbers').setDescription('e.g. 3 · 3,5,7 · 2-6 · all').setRequired(true).setMaxLength(200)))
    .addSubcommand(s => s.setName('cleanup').setDescription('Delete old snapshots/backups in bulk by age and type (previews first)')
    .addIntegerOption(o => o.setName('older_than_days').setDescription('Delete points older than this many days (0 = any age)').setRequired(true).setMinValue(0).setMaxValue(3650))
    .addStringOption(o => o.setName('type').setDescription('Which kind to delete (default: all)').addChoices(...CLEANUP_TYPES.map(t => ({ name: CLEANUP_LABELS[t], value: t }))))
    .addIntegerOption(o => o.setName('keep_latest').setDescription('Always keep this many of the newest matching points (default 1)').setMinValue(0).setMaxValue(100))
    .addStringOption(o => o.setName('confirm').setDescription('Type DELETE to delete; leave empty to preview'))), { category: 'security', cooldown: 1500, access: 'security' }, async (ctx, i) => {
    const actor = ctx.actor;
    const sub = i.options.getSubcommand();
    if (sub === 'create') {
        const id = await ctx.snapshots.locks.run([i.guildId], () => ctx.snapshots.save(i.guild, actor.id));
        const data = ctx.snapshots.load(i.guildId, id).data;
        return `Snapshot **#${ctx.snapshots.numberOf(i.guildId, id)}** saved: ${data.roles.length} roles and ${data.channels.length} supported channels. ${data.unsupported.length} forum/media channels skipped. Messages, member role assignments and integrations are outside snapshot recovery.`;
    }
    if (sub === 'restore') {
        const number = i.options.getInteger('number');
        const snap = ctx.snapshots.load(i.guildId, number ? ctx.snapshots.idFor(i.guildId, number) : undefined);
        const key = addConfirmation(ctx, { guild: i.guildId, user: actor.id, snapshot: snap.id, prune: i.options.getBoolean('prune') ?? false, fingerprint: '', components: selectComponents() });
        await showLayoutReview(ctx, i, key, ctx.confirmations.get(key));
        return;
    }
    if (sub === 'list') {
        await i.editReply(snapshotPage(ctx, i.guildId, i.user.id, i.options.getInteger('page') ?? 1));
        return;
    }
    if (sub === 'delete') {
        const numbers = ctx.snapshots.resolveNumbers(i.guildId, i.options.getString('numbers', true));
        await deletionReview(ctx, i, numbers.map(n => ctx.snapshots.idFor(i.guildId, n)));
        return;
    }
    if (sub === 'cleanup') {
        const options = { olderThanDays: i.options.getInteger('older_than_days', true), type: (i.options.getString('type') ?? 'all'), keepLatest: i.options.getInteger('keep_latest') ?? 1 };
        const label = CLEANUP_LABELS[options.type].replace(/ \(.*$/, '').toLowerCase();
        const age = options.olderThanDays ? ` older than ${options.olderThanDays} days` : '';
        const date = (ms) => ms ? `<t:${Math.floor(ms / 1000)}:D>` : '';
        if (i.options.getString('confirm') !== 'DELETE') {
            const plan = cleanupPlan(ctx.store, i.guildId, options);
            if (!plan.ids.length)
                return `**Nothing to delete.** No ${label}${age} match${plan.kept ? ` (the newest ${plan.kept} are always kept)` : ''}.`;
            return `**Preview only, nothing was deleted.**\nWould delete **${plan.ids.length}** of ${plan.total} recovery points (${label}${age}), dated ${date(plan.oldest)} to ${date(plan.newest)}.${plan.kept ? ` The newest ${plan.kept} matching ${plan.kept === 1 ? 'point is' : 'points are'} kept.` : ''}\nServer roles, channels and restore mappings are not affected.\nRun again with \`confirm: DELETE\` to delete them.`;
        }
        const plan = await cleanupSnapshots(ctx.snapshots, ctx.store, i.guildId, options, actor.id);
        if (plan.ids.length)
            ctx.logs.push(i.guildId, embed('Recovery points cleaned up', `By <@${actor.id}> · deleted ${plan.ids.length} (${label}${age}) · ${plan.total - plan.ids.length} remain`, Colors.Orange));
        return plan.ids.length ? `Deleted **${plan.ids.length}** recovery point(s). ${plan.total - plan.ids.length} remain.` : 'Nothing matched any more, so nothing was deleted.';
    }
    throw new AppError('VALIDATION_ERROR', 'Unknown snapshot action.');
}, { subcommands: { create: { botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] }, restore: { botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] } } });
