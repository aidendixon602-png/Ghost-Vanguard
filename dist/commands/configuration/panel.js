import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { setupPanel } from '../../ui/control-panel.js';
/** /setup panel: create or update the private #vanguard-control channel and its button panel. Safe to run again. */
export default defineCommand(new SlashCommandBuilder().setName('panel').setDescription('Create or update the private control panel channel (buttons for staff)'), { category: 'configuration', access: 'security', botPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles], cooldown: 5000 }, async (ctx, i) => {
    const r = await setupPanel(ctx.store, i.guild, i.user.id);
    return [
        `${r.created ? '✅ Created' : '🔄 Updated'} <#${r.channel.id}> with the control panel${r.reposted && !r.created ? ' (the old panel message was gone, so a new one was posted)' : ''}.`,
        `**Who can see it:** the server owner${r.viewers > 1 ? ` and ${r.viewers - 1} authorized staff entr${r.viewers - 1 === 1 ? 'y' : 'ies'} (security admins and admin roles)` : ''}. Everyone else is hidden from it.`,
        '-# People with Discord\'s Administrator permission can always see every channel, but the buttons only work for authorized staff.',
        '-# Run `/setup panel` again any time (for example after adding staff roles) to update who can see it. It never makes a second channel.',
    ].join('\n');
});
