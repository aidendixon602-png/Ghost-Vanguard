import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { RULES } from '../../core.js';
import { AppError } from '../../errors.js';
import { defineCommand, type CommandContext } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { embed } from '../../ui/ui.js';
import { readiness } from '../../security/readiness.js';
import { applyLockedPreset, setAntinukeChoice } from '../../security/locked-antinuke.js';
import { statusPanel } from '../../ui/antinuke-panel.js';

export default defineCommand(new SlashCommandBuilder().setName('antinuke').setDescription('Anti-nuke: turn it on or off, see its rules and check Vanguard\'s permissions')
    .addSubcommand(s => s.setName('enable').setDescription('Turn anti-nuke on (saves a backup of the server first)'))
    .addSubcommand(s => s.setName('disable').setDescription('Turn anti-nuke off (stays off after restarts)'))
    .addSubcommand(s => s.setName('rules').setDescription('Show the 17 anti-nuke rules and the whitelist'))
    .addSubcommand(s => s.setName('status').setDescription('Show whether anti-nuke is on, its rules and the whitelist'))
    .addSubcommand(s => s.setName('check').setDescription('Check Vanguard\'s permissions and role position'))
    .addSubcommand(s => s.setName('test').setDescription('List each rule\'s trigger limit (no actions taken)')), { category: 'antinuke', cooldown: 1500, access: 'security' }, async (ctx: CommandContext, i) => {
    const actor = ctx.actor!;
    const s = ctx.store.settings(i.guildId);
    const sub = i.options.getSubcommand();
    if (sub === 'rules' || sub === 'status') {
        await i.editReply(statusPanel(ctx, i.guildId, i.user.id));
        return;
    }
    if(sub==='check') {if(s.logChannelId)await i.guild.channels.fetch(s.logChannelId).catch(()=>null);return readiness(i.guild,s.logChannelId,ctx.store).text;}
    if (sub === 'test') {
        const results = RULES.map(r => `${r.key}: triggers at ${r.count} in ${r.seconds}s`);
        return `**Dry run:** ${results.length} rules loaded. No Discord actions or synthetic incidents were executed.\n${results.join('\n')}`;
    }
    if (sub === 'enable') {
        if (!s.logChannelId)
            throw new AppError('VALIDATION_ERROR', 'Set a security log channel with /security config before enabling enforcement.');
        await i.guild.channels.fetch(s.logChannelId).catch(()=>null);
        const ready=readiness(i.guild,s.logChannelId,ctx.store);
        // Missing permissions stop enabling. Roles above Vanguard only limit who can be contained, so they are a warning.
        if(ready.missing.length)throw new AppError('PERMISSION_ERROR',`Protection was not enabled. ${ready.text}`);
        const snapshot = ctx.snapshots.numberOf(i.guildId, await ctx.snapshots.save(i.guild, actor.id, 'snapshot', 'baseline'));
        // The preset is fixed; enabling only switches it on and records the server's choice.
        applyLockedPreset(s);
        ctx.store.setKickBots(i.guildId, false);
        ctx.store.save(s, i.user.id);
        setAntinukeChoice(ctx.store, i.guildId, true);
        ctx.logs.push(i.guildId, embed('Anti-nuke enabled', `By <@${actor.id}> · baseline #${snapshot} · default preset · enforce mode`, Colors.Green));
        return `The default preset is loaded: ${RULES.length} rules enabled in **enforce** mode. Baseline snapshot **#${snapshot}** saved. The preset is fixed; use /antinuke trust for approved exceptions and /antinuke status to review it.\n${ready.text}${ready.above.length?'\n-# To fix the warning, drag the Midtown Vanguard role above those roles in Server Settings → Roles, or whitelist them with `/antinuke trust manage`.':''}`;
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
            reversal: '`/antinuke enable` or `/antinuke enable` reloads the default preset in enforce mode and captures a fresh baseline.',
            run: (c: any, b: any) => {
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
    throw new AppError('VALIDATION_ERROR', 'Anti-nuke rules are fixed. Use /antinuke enable or /antinuke disable to switch protection, and /antinuke trust for exceptions.');
}, { subcommands: { enable: { botPermissions: [PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageRoles] } } });
