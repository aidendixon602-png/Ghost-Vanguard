import { type SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { CommandContext } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { getWorkspaceConfig, saveWorkspaceConfig, validateWorkspaceConfig } from './config.js';
import { publishWorkspacePanels, setupStatus } from './panels.js';
import { previewGuildStaff } from './staff.js';
import { openSetupWizard } from './setup-wizard.js';

export function addWorkspaceSubcommands(builder: SlashCommandSubcommandsOnlyBuilder) {
    builder
    .addSubcommand(s => s.setName('workspace-setup').setDescription('Open the guided Workspace setup panel (channels, roles, sheet — no manual IDs)'))
    .addSubcommand(s => s.setName('workspace-publish').setDescription('Post or update the configured persistent panels')
        .addStringOption(o => o.setName('kind').setDescription('Panel to publish').setRequired(true).addChoices({ name: 'All configured panels', value: 'all' }, { name: 'Member', value: 'member' }, { name: 'Staff', value: 'staff' }, { name: 'Tasks', value: 'tasks' })))
    .addSubcommand(s => s.setName('workspace-status').setDescription('Show Workspace setup status'))
    .addSubcommand(s => s.setName('workspace-enable').setDescription('Enable the validated Workspace integration'))
    .addSubcommand(s => s.setName('workspace-disable').setDescription('Disable Workspace and stop its reminders without deleting records'))
    .addSubcommand(s => s.setName('workspace-sync').setDescription('Preview and synchronize recognized staff members'));
    return builder;
}

export async function executeWorkspaceSubcommand(ctx: CommandContext, i: any) {
        const guild = i.guild;
        const sub = i.options.getSubcommand().replace(/^workspace-/, '');
        if (sub === 'setup') return openSetupWizard(ctx, i);
        if (sub === 'status') {
            const status = setupStatus(ctx.store, guild.id);
            const cfg = getWorkspaceConfig(ctx.store, guild.id);
            return [`**Workspace:** ${cfg?.branding.departmentName ?? 'not configured'}`, `**Enabled:** ${status.enabled ? 'yes' : 'no'}`, `**Workbook validated:** ${status.validated ? 'yes' : 'no'}`, `**Modules:** ${cfg ? Object.entries(cfg.modules).filter(([, enabled]) => enabled).map(([name]) => name).join(', ') || 'none' : 'none'}`, status.errors.length ? `\n${status.errors.map(e => `• ${e}`).join('\n')}` : 'Ready for configured users.'].join('\n');
        }
        if (sub === 'disable') {
            const cfg = getWorkspaceConfig(ctx.store, guild.id);
            if (!cfg) return 'Workspace is not configured in this guild.';
            cfg.enabled = false; cfg.disabledAt = Date.now(); saveWorkspaceConfig(ctx.store, cfg, i.user.id);
            return 'Workspace is disabled for this guild. Existing records and audit history were preserved; scheduled reminders stopped.';
        }
        if (sub === 'enable') {
            const cfg = getWorkspaceConfig(ctx.store, guild.id);
            if (!cfg) throw new AppError('VALIDATION_ERROR', 'Run `/setup config workspace-setup` first.');
            const errors = validateWorkspaceConfig(cfg);
            if (!cfg.validatedAt || errors.length) throw new AppError('VALIDATION_ERROR', `Workspace is not ready to enable.\n${errors.map(e => `• ${e}`).join('\n')}`);
            cfg.enabled = true; cfg.disabledAt = null; saveWorkspaceConfig(ctx.store, cfg, i.user.id);
            return 'Workspace is enabled. Existing panels will work after they are published or updated with `/setup config workspace-publish`.';
        }
        if (sub === 'publish') {
            const kind = i.options.getString('kind', true) as 'all' | 'member' | 'staff' | 'tasks';
            const kinds = kind === 'all' ? ['member', 'staff', 'tasks'] as ('member' | 'staff' | 'tasks')[] : [kind];
            const posted = await publishWorkspacePanels(ctx.store, guild, i.user.id, kinds);
            return posted.length ? `Workspace panels are ready.\n${posted.map(line => `• ${line}`).join('\n')}` : 'No panel was posted. Check the selected panel channels and enabled modules.';
        }
        if (sub === 'sync') {
            const preview = await previewGuildStaff(ctx.store, guild);
            const summary = preview.changes.slice(0, 20).map(c => `${c.kind}: \`${c.userId}\``).join('\n') || 'No changes detected.';
            return `Staff synchronization preview only; no roster rows were changed. **${preview.changes.length}** changes would be applied after confirmation.\n${summary}${preview.changes.length > 20 ? `\n…and ${preview.changes.length - 20} more.` : ''}\n\nUse the Staff panel’s Refresh Staff button to review and confirm the same preview before applying it.`;
        }
        throw new AppError('VALIDATION_ERROR', 'Unknown Workspace subcommand.');
}
