import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, PermissionFlagsBits, StringSelectMenuBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { developers } from '../bot/developers.js';
import { COMPONENTS, selectComponents } from '../recovery/recovery.js';
import { embed } from './ui.js';
export const COMPONENT_OPTIONS = [{ label: 'All', value: 'all', description: 'Every supported restore component' }, ...COMPONENTS.map(value => ({ label: value[0].toUpperCase() + value.slice(1), value }))];
export async function checkDestination(ctx, guild, user, components) {
    if (!ctx.store.isAuthorized(guild.id) || !ctx.lifecycle.isReady(guild.id))
        throw new AppError('AUTHORIZATION_ERROR', 'Both servers must be authorized and ready before copying a layout.');
    const actor = await guild.members.fetch({ user, force: true }).catch(() => null);
    if (!developers.has(user) && (!actor || actor.id !== guild.ownerId && !ctx.store.readGuild(guild.id, () => ctx.store.hasGrant(guild.id, user, 'admin') || [...(actor.roles?.cache?.keys() ?? [])].some(role => !!ctx.store.get('SELECT 1 FROM permission_roles WHERE guild_id=? AND role_id=? AND access=?', guild.id, role, 'admin')))))
        throw new AppError('PERMISSION_ERROR', 'You must have Vanguard security access in both servers.');
    const me = await guild.members.fetchMe();
    if (!me.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels]))
        throw new AppError('PERMISSION_ERROR', 'Vanguard needs Manage Roles and Manage Channels in the destination server.');
}
export function addConfirmation(ctx, value) {
    for (const [key, p] of ctx.confirmations)
        if (p.expires < Date.now())
            ctx.confirmations.delete(key);
    if (ctx.confirmations.size >= 1000)
        throw new AppError('VALIDATION_ERROR', 'Too many pending confirmations. Try again later.');
    const key = randomUUID();
    ctx.confirmations.set(key, { ...value, expires: Date.now() + 120000 });
    return key;
}
export async function showLayoutReview(ctx, i, key, pending) {
    const destination = pending.destination ? ctx.client.guilds.cache.get(pending.destination) : i.guild;
    if (!destination)
        throw new AppError('VALIDATION_ERROR', 'Vanguard is no longer connected to the destination server.');
    const components = pending.components ?? selectComponents();
    if (pending.destination)
        await checkDestination(ctx, destination, i.user.id, components);
    const plan = await ctx.store.withAuthorized(destination.id, () => ctx.snapshots.plan(destination, ctx.snapshots.load(destination.id, pending.snapshot).data, pending.prune, components));
    pending.fingerprint = plan.fingerprint;
    const names = components.map(c => c[0].toUpperCase() + c.slice(1));
    const data = ctx.store.readGuild(destination.id, () => ctx.snapshots.load(destination.id, pending.snapshot).data);
    const settings = data.settings ? Object.keys(data.settings).join(', ') : 'No guild settings stored in this older snapshot';
    const summary = `**${pending.destination ? 'Copy layout to' : 'Restore server'}:** ${destination.name} (${destination.id})\n**Snapshot:** #${ctx.snapshots.numberOf(destination.id, pending.snapshot)}\n**Components:** ${names.join(', ')}\n${components.includes('settings') ? `**Supported settings:** ${settings}\n` : ''}**Create:** ${plan.roleCreate} roles · ${plan.channelCreate} categories/channels\n**Update/reorder candidates:** ${plan.roleUpdate} roles · ${plan.channelUpdate} categories/channels\n**Delete extras:** ${plan.roleDelete.length} roles · ${plan.channelDelete.length} channels\n**Settings changes:** ${plan.settingsUpdate}\n**Skipped:** ${plan.skipped.length}\n\nA fresh destination backup is required before any changes. Existing objects are matched before creation. ${components.includes('permissions') ? 'Saved permissions, including privileged permissions, will be applied.' : 'Existing permissions are preserved; new channels begin private.'}\n${pending.prune ? 'Explicit pruning will permanently delete the reviewed extras only if there are no skipped objects or failures.\n' : ''}Confirmation expires in two minutes and checks for server changes.`;
    const manifest = [
        `Snapshot #${ctx.snapshots.numberOf(destination.id, pending.snapshot)} -> ${destination.name} (${destination.id})`,
        `Selected: ${names.join(', ')}`,
        ...data.roles.filter(r => components.includes('roles') || components.includes('permissions')).map(r => `Role: ${r.name} (${r.id}) -> ${plan.roleMap[r.id] ?? 'create if Roles selected'}; snapshot position ${r.position}${plan.blockedRoles.includes(r.id) ? '; skipped' : ''}`),
        ...data.channels.filter(c => components.includes('permissions') || components.includes(c.type === 4 ? 'categories' : 'channels')).map(c => `${c.type === 4 ? 'Category' : 'Channel'}: ${c.name} (${c.id}) -> ${plan.channelMap[c.id] ?? 'create if layout component selected'}; parent ${c.parent ?? 'none'}; position ${c.position}; ${c.overwrites.length} saved overwrites${plan.blockedChannels.includes(c.id) ? '; skipped' : ''}`),
        ...(components.includes('settings') && data.settings ? Object.entries(data.settings).map(([k, v]) => `Setting: ${k} = ${v ?? 'none'}${k.endsWith('ChannelId') && v !== null ? ` -> ${plan.channelMap[String(v)] ?? 'unresolved'}` : ''}`) : []),
        ...plan.skipped,
        ...plan.roleDelete.map(id => `Delete role: ${destination.roles.cache.get(id)?.name} (${id})`),
        ...plan.channelDelete.map(id => `Delete channel: ${destination.channels.cache.get(id)?.name} (${id})`)
    ];
    const selector = new StringSelectMenuBuilder().setCustomId(`layoutselect:${key}`).setPlaceholder('Choose components — All selects everything').setMinValues(1).setMaxValues(6).addOptions(COMPONENT_OPTIONS.map(o => ({ ...o, default: components.length === COMPONENTS.length ? o.value === 'all' : components.includes(o.value) })));
    await i.editReply({ embeds: [embed(pending.destination ? 'Review layout copy' : 'Review snapshot restoration', summary, Colors.Orange)], components: [new ActionRowBuilder().addComponents(selector), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`restore:${key}`).setLabel(pending.destination ? 'Confirm layout copy' : 'Confirm restore').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`layoutcancel:${key}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))], files: [{ attachment: Buffer.from(manifest.join('\n')), name: 'restore-preview.txt' }], attachments: [], allowedMentions: { parse: [] } });
}
export function restoreProgress(i) {
    let last = 0;
    return async (message) => {
        const now = Date.now();
        if (now - last < 5000 && !message.startsWith('Restore complete') && !message.startsWith('Restore finished'))
            return;
        last = now;
        await i.editReply({ embeds: [embed('Server recovery in progress', message, Colors.Orange)], components: [], attachments: [] });
    };
}
export async function showRestoreReport(ctx, i, guildId, result) {
    // The full report remains available even when it exceeds Discord's embed/message limit.
    await i.editReply({ embeds: [embed('Server recovery report', result.slice(0, 3800), Colors.Orange)], components: [], files: [{ attachment: Buffer.from(result), name: 'restore-report.txt' }], allowedMentions: { parse: [] } });
}
