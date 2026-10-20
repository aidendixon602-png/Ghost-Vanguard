import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { RULES } from '../../core.js';
import { AppError } from '../../errors.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { embed } from '../../ui/ui.js';
import { readiness } from '../../security/readiness.js';
import { applyLockedPreset, setAntinukeChoice } from '../../security/locked-antinuke.js';
import { statusPanel } from '../../ui/antinuke-panel.js';
export default defineCommand(new SlashCommandBuilder().setName('antinuke').setDescription('Anti-nuke status, readiness, enforcement and exceptions')
    .addSubcommand(s => s.setName('status').setDescription('Is anti-nuke observing or enforcing? Review rules and whitelist'))
    .addSubcommand(s => s.setName('enable').setDescription('Enable enforcement after readiness check and confirmation'))
    .addSubcommand(s => s.setName('disable').setDescription('Turn anti-nuke off (stays off after restarts)'))
    .addSubcommand(s => s.setName('check').setDescription('Check Vanguard\'s permissions and role position')), { category: 'antinuke', cooldown: 1500, access: 'security' }, async (ctx, i) => {
    const s = ctx.store.settings(i.guildId);
    const sub = i.options.getSubcommand();
    if (sub === 'rules' || sub === 'status') {
        await i.editReply(statusPanel(ctx, i.guildId, i.user.id));
        return;
    }
    if (sub === 'check') {
        await i.guild.members.fetchMe().catch(() => null);
        if (s.logChannelId)
            await i.guild.channels.fetch(s.logChannelId).catch(() => null);
        return readiness(i.guild, s.logChannelId, ctx.store).text;
    }
    if (sub === 'enable') {
        if (!s.logChannelId)
            throw new AppError('VALIDATION_ERROR', 'Set up a security log channel with `/setup logs setup` before enabling enforcement.');
        await i.guild.members.fetchMe().catch(() => null);
        await i.guild.channels.fetch(s.logChannelId).catch(() => null);
        const ready = readiness(i.guild, s.logChannelId, ctx.store);
        // Missing permissions stop enabling. Roles above Vanguard only limit who can be contained,
        // so they are an explicit warning in the confirmation rather than an automatic block.
        if (ready.missing.length)
            throw new AppError('PERMISSION_ERROR', `Enforcement remains off. Fix readiness, then run /antinuke check again. ${ready.text}`);
        const expectedLogChannel = s.logChannelId;
        const currentMode = s.enabled ? s.mode : 'off';
        const expectedAbove = [...ready.above].sort();
        const expectedBypassed = [...ready.bypassed].sort();
        const hierarchyUnchanged = (state) => JSON.stringify([...state.above].sort()) === JSON.stringify(expectedAbove)
            && JSON.stringify([...state.bypassed].sort()) === JSON.stringify(expectedBypassed);
        await confirmDanger(ctx, i, {
            title: 'Enable anti-nuke enforcement',
            summary: `**${i.guild?.name ?? 'This server'}** will switch from ${currentMode} mode to the fixed ${RULES.length}-rule enforce preset.`,
            consequences: [
                'The bot will automatically strip, remove, or revert actions when a rule triggers; this can affect staff who are not exempt.',
                'A baseline snapshot is saved immediately before enforcement is enabled.',
                'Readiness and role hierarchy will be rechecked when you confirm; any change cancels this confirmation.',
                ready.above.length
                    ? `Unprotected roles at or above Vanguard cannot be contained: ${ready.above.slice(0, 10).join(', ')}.`
                    : 'No unmanaged, unprotected roles are at or above Vanguard.',
                ready.bypassed.length
                    ? `Explicitly bypassed roles at or above Vanguard: ${ready.bypassed.slice(0, 10).join(', ')}; their holders are exempt from anti-nuke.`
                    : 'No anti-nuke-bypassed roles are at or above Vanguard.',
                'Use `/antinuke whitelist` for approved exceptions; exemptions reduce protection for their scope.',
            ],
            label: 'Enable enforcement',
            reversal: '`/antinuke disable` turns protection off (also requires confirmation).',
            run: async (c, b) => {
                const liveSettings = c.store.settings(b.guildId);
                if (!liveSettings.logChannelId || liveSettings.logChannelId !== expectedLogChannel)
                    throw new AppError('VALIDATION_ERROR', 'The security-log channel changed after the prompt. Run `/antinuke check` and `/antinuke enable` again.');
                const liveLogChannel = liveSettings.logChannelId;
                await b.guild.members.fetchMe().catch(() => null);
                await b.guild.channels.fetch(liveLogChannel).catch(() => null);
                let live = readiness(b.guild, liveLogChannel, c.store);
                if (live.missing.length)
                    throw new AppError('PERMISSION_ERROR', `Enforcement was not enabled. Readiness changed; fix the blockers and run /antinuke check again. ${live.text}`);
                if (!hierarchyUnchanged(live))
                    throw new AppError('VALIDATION_ERROR', 'The role hierarchy changed after the prompt. Review `/antinuke check`, then start a fresh `/antinuke enable` confirmation.');
                const snapshot = c.snapshots.numberOf(b.guildId, await c.snapshots.save(b.guild, b.user.id, 'snapshot', 'baseline'));
                // Snapshot creation can take time; refresh the destination and live checks immediately before switching modes.
                const finalSettings = c.store.settings(b.guildId);
                if (!finalSettings.logChannelId || finalSettings.logChannelId !== expectedLogChannel)
                    throw new AppError('VALIDATION_ERROR', 'The baseline was saved, but the security-log channel changed. Enforcement remains off; run /antinuke check and confirm again.');
                const finalLogChannel = finalSettings.logChannelId;
                await b.guild.members.fetchMe().catch(() => null);
                await b.guild.channels.fetch(finalLogChannel).catch(() => null);
                live = readiness(b.guild, finalLogChannel, c.store);
                if (live.missing.length || !hierarchyUnchanged(live))
                    throw new AppError('PERMISSION_ERROR', `The baseline was saved, but enforcement was not enabled because readiness or role hierarchy changed. ${live.text} Run /antinuke check and confirm again.`);
                const settings = c.store.settings(b.guildId);
                applyLockedPreset(settings, 'enforce');
                c.store.setKickBots(b.guildId, false);
                c.store.save(settings, b.user.id);
                setAntinukeChoice(c.store, b.guildId, true);
                c.logs.push(b.guildId, embed('Anti-nuke enabled', `By <@${b.user.id}> · baseline #${snapshot} · default preset · enforce mode`, Colors.Green));
                return [
                    `The default preset is now running: ${RULES.length} rules in **enforce** mode. Baseline snapshot **#${snapshot}** saved. Review with /antinuke status and manage exceptions with /antinuke whitelist.`,
                    live.text,
                    live.above.length ? `-# Roles above Vanguard cannot be contained. Move Vanguard's role higher in Server Settings → Roles to protect them.` : '',
                ].filter(Boolean).join('\n');
            },
        });
        return;
    }
    if (sub === 'disable') {
        await confirmDanger(ctx, i, {
            title: 'Disable anti-nuke protection',
            summary: `**${i.guild?.name ?? 'This server'}** would be left with no automatic protection.`,
            consequences: [
                `All ${RULES.length} detection rules stop running.`,
                'Mass role, channel and ban activity is no longer detected or contained.',
                'Existing incidents, snapshots and configuration are kept.',
                `Current mode: **${s.mode}**.`,
            ],
            label: 'Disable protection',
            reversal: '`/antinuke enable` runs the readiness check, saves a baseline and asks for confirmation.',
            run: (c, b) => {
                const settings = c.store.settings(b.guildId);
                settings.enabled = false;
                c.store.save(settings, b.user.id);
                // Remembered across restarts, so automatic startup protection does not re-enable it.
                setAntinukeChoice(c.store, b.guildId, false);
                c.logs.push(b.guildId, embed('Anti-nuke disabled', `By <@${b.user.id}>`, Colors.Red));
                return Promise.resolve('Anti-nuke is now **disabled** and will stay off after restarts until `/antinuke enable` is used. Nothing is being detected or contained in this server.');
            },
        });
        return;
    }
    throw new AppError('VALIDATION_ERROR', 'Anti-nuke rules are fixed. Use /antinuke enable or /antinuke disable to switch protection, and /antinuke whitelist for exceptions.');
}, { subcommands: { enable: { botPermissions: [PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageRoles] } } });
