import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { applyRestore, planRestore, planSummary, readBackup } from '../../database/settings-restore.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { embed } from '../../ui/ui.js';

export default defineCommand(new SlashCommandBuilder().setName('database').setDescription('Developer: database health and database backups')
    .addSubcommand(s => s.setName('status').setDescription('Show database health, storage, backup and migration status'))
    .addSubcommand(s => s.setName('backup').setDescription('Create a verified database backup now'))
    .addSubcommand(s => s.setName('backups').setDescription('List recent database backups'))
    .addSubcommand(s => s.setName('restore-settings').setDescription('Supreme Leader: put back lost settings from an old backup file; anything newer is kept')
        .addAttachmentOption(o => o.setName('file').setDescription('vanguard.db or a vanguard-YYYY-MM-DD.db.gz backup').setRequired(true)))
    .addSubcommand(s => s.setName('verify').setDescription('Recheck backup checksum and database integrity').addStringOption(o => o.setName('backup').setDescription('Backup UUID').setRequired(true).setMaxLength(36))), { category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    if (!ctx.databaseBackups)
        throw new AppError('DATABASE_ERROR', 'Database backup service unavailable.');
    const sub = i.options.getSubcommand();
    if (sub === 'restore-settings') {
        const file = i.options.getAttachment('file', true);
        if (file.size > 50 * 1024 * 1024) throw new AppError('VALIDATION_ERROR', 'That file is over 50 MB, which is too big for a Vanguard database.');
        const response = await fetch(file.url).catch(() => null);
        if (!response?.ok) throw new AppError('DISCORD_API_ERROR', 'Could not download that file from Discord. Try uploading it again.');
        const bytes = Buffer.from(await response.arrayBuffer());
        const preview = (() => { const src = readBackup(bytes); try { return planSummary(planRestore(ctx.store, src.db)); } finally { src.close(); } })();
        if (!preview.total) return preview.text;
        const backups = ctx.databaseBackups;
        await confirmDanger(ctx, i, {
            title: 'Restore lost settings',
            summary: `From **${file.name}**, these would be added back:\n${preview.text}`.slice(0, 3000),
            consequences: [
                'Only missing settings are added. Anything set now stays exactly as it is.',
                'Whitelist entries changed or removed after the backup are left as they are now.',
                'A database backup is made first, so this can be rolled back with `npm run database:restore`.',
            ],
            label: `Restore ${preview.total} setting(s)`,
            reversal: 'Restore the backup made just before this (`/dev database backups` lists it).',
            run: async () => {
                const safety = await backups.create('manual');
                const src = readBackup(bytes);
                try {
                    const plan = planRestore(ctx.store, src.db);
                    const added = applyRestore(ctx.store, plan, i.user.id);
                    for (const guild of plan.guilds.keys())
                        ctx.logs.push(guild, embed('Settings restored', `<@${i.user.id}> put back settings lost earlier, from an older database backup. Nothing that was set already was changed.`));
                    return `✅ **Restored ${added} setting(s).** Safety backup **${safety.id}** was made first.\n${planSummary(plan).text}`.slice(0, 1900);
                } finally { src.close(); }
            },
        });
        return;
    }
    if (sub === 'backup') {
        const backup = await ctx.databaseBackups.create('manual');
        return `Database backup **${backup.id}** verified (${backup.size} bytes).`;
    }
    if (sub === 'verify') {
        await ctx.databaseBackups.verify(i.options.getString('backup', true));
        return 'Checksum and database integrity verified.';
    }
    if (sub === 'backups')
        return ctx.store.all('SELECT id,at,kind,size,status,verified,expires FROM database_backups ORDER BY at DESC LIMIT 15').map(r => `**${r.id}** · ${r.kind} · ${r.status} · ${r.size ?? 0} bytes · verified ${!!r.verified} · <t:${Math.floor(r.at / 1000)}:f>`).join('\n') || 'No backups saved.';
    const health = ctx.store.health();
    return `**Database:** ${health.status}\n**Schema:** ${health.databaseVersion ?? 'unavailable'}\n**Storage:** ${health.storageBytes ?? 'unavailable'} bytes\n**Query failures:** ${health.query_failures ?? 0}\n**Backup failures:** ${health.backup_failures ?? 0}\n**Migration failures:** ${health.migration_failures ?? 0}\n**Last verified backup:** ${health.last_backup ? `<t:${Math.floor(health.last_backup / 1000)}:f>` : 'none'}\n**Last health check:** ${health.checked_at ? `<t:${Math.floor(health.checked_at / 1000)}:f>` : 'unavailable'}`;
});
