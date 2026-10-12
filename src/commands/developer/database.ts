import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';

export default defineCommand(new SlashCommandBuilder().setName('database').setDescription('Developer: database health and database backups')
    .addSubcommand(s => s.setName('status').setDescription('Show database health, storage, backup and migration status'))
    .addSubcommand(s => s.setName('backup').setDescription('Create a verified database backup now'))
    .addSubcommand(s => s.setName('backups').setDescription('List recent database backups'))
    .addSubcommand(s => s.setName('verify').setDescription('Recheck backup checksum and database integrity').addStringOption(o => o.setName('backup').setDescription('Backup UUID').setRequired(true).setMaxLength(36))), { category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    if (!ctx.databaseBackups)
        throw new AppError('DATABASE_ERROR', 'Database backup service unavailable.');
    const sub = i.options.getSubcommand();
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
