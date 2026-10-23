import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { emergencyOn, emergencyPanel, startEmergency, stopEmergency } from '../../features/emergency.js';
export default defineCommand(new SlashCommandBuilder().setName('emergency').setDescription('One-click raid/nuke response: lock everything, pause invites, ping Admins')
    .addSubcommand(s => s.setName('start').setDescription('Lock every channel, pause invites, turn on raid mode and ping Admins'))
    .addSubcommand(s => s.setName('stop').setDescription('All clear: undo everything emergency mode did'))
    .addSubcommand(s => s.setName('panel').setDescription('Post Emergency / All clear buttons in this channel (put it in a staff channel)'))
    .addSubcommand(s => s.setName('status').setDescription('Is emergency mode on?')), { category: 'security', access: 'security', cooldown: 2000 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), deps = { store: ctx.store, logs: ctx.logs, locks: ctx.snapshots.locks };
    if (sub === 'status')
        return emergencyOn(ctx.store, i.guildId) ? '🚨 **Emergency mode is ON.** Use `/raid emergency stop` when it is over.' : 'Emergency mode is off.';
    if (sub === 'stop')
        return stopEmergency(deps, i.guild, i.user.id);
    if (sub === 'panel') {
        if (!i.channel?.isSendable())
            return 'I cannot post in this channel.';
        await i.channel.send(emergencyPanel());
        return 'Emergency buttons posted here. Admins and above can press them.';
    }
    if (emergencyOn(ctx.store, i.guildId))
        return 'Emergency mode is already on.';
    await confirmDanger(ctx, i, {
        title: 'Start emergency mode',
        summary: `**${i.guild.name}** is under attack and needs to be locked down now.`,
        consequences: ['Every channel is locked for members (staff keep access).', 'Server invites are paused, so nobody new can join.', 'Raid mode turns on: anyone who still joins is removed.', 'Admin and Head Admin roles are pinged in the security log.'],
        label: 'Start emergency mode',
        reversal: '`/raid emergency stop` undoes all of it.',
        run: (c, b) => startEmergency({ store: c.store, logs: c.logs, locks: c.snapshots.locks }, b.guild, b.user.id),
    });
}, { subcommands: { status: { responseKind: 'info' } } });
