import { Colors, PermissionFlagsBits } from 'discord.js';
import { defaults } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { checkChannel, describeCheck, serverPermissionGaps, setupLogChannels } from '../audit/log-setup.js';
import { helpPage } from './help-ui.js';
import { embed } from './ui.js';
import { WELCOME_HELP_ID, WELCOME_PREFIX, welcomePanel } from './setup-tips.js';
/**
 * Buttons on the welcome panel. Each re-checks who is pressing it (Admin rank or above for the
 * setup buttons, anyone for the command list), has a 15-second cooldown, answers privately, and
 * refreshes the panel itself so its checklist always shows the current state.
 */
const COOLDOWN = 15000;
export function registerWelcomePanel(registry) {
    // The command list: anyone, and only what they can use.
    registry.component({ prefix: WELCOME_HELP_ID, kinds: ['button'], metadata: { ...defaults, responseKind: 'info', cooldown: COOLDOWN },
        execute: async (ctx, i) => { await i.editReply(helpPage(ctx, i.guildId, i.user.id)); } });
    registry.component({ prefix: WELCOME_PREFIX, kinds: ['button'], metadata: { ...defaults, category: 'configuration', access: 'security', cooldown: COOLDOWN, botPermissions: [] },
        execute: async (ctx, i) => {
            const match = /^vgwelcome:(logs|check):(\d{17,20}|0)$/.exec(i.customId);
            if (!match)
                throw new AppError('VALIDATION_ERROR', 'This button is out of date. Run /setup logs check instead.');
            const inviter = match[2] === '0' ? null : match[2];
            const refresh = () => i.message.edit(welcomePanel(ctx.store, i.guild, inviter)).catch(() => undefined);
            if (match[1] === 'check') {
                await refresh();
                return 'The setup panel was refreshed with the current state.';
            }
            if (!i.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels))
                throw new AppError('PERMISSION_ERROR', 'Ghost Vanguard needs Manage Channels to create the log channels. Give it Administrator (recommended) or Manage Channels, then press the button again.');
            const result = await setupLogChannels(ctx.store, i.guild, i.user.id);
            const bans = await checkChannel(i.guild, result.bans.channel.id, 'ban logs');
            const logging = await checkChannel(i.guild, result.logging.channel.id, 'server logs');
            const gaps = serverPermissionGaps(i.guild);
            const ok = bans.ok && logging.ok && !gaps.length;
            await refresh();
            await i.editReply({ embeds: [embed(ok ? '✅ Log channels ready' : '⚠️ Log channels need attention', [
                        `**Ban logs:** <#${result.bans.channel.id}> · ${result.bans.how}`,
                        `**Server logs:** <#${result.logging.channel.id}> · ${result.logging.how}`,
                        '', describeCheck('Ban logs', bans), describeCheck('Server logs', logging),
                        gaps.length ? `**Server permissions missing:** ${gaps.join('; ')}` : '',
                    ].filter(Boolean).join('\n'), ok ? Colors.Green : Colors.Orange)] });
        } });
}
