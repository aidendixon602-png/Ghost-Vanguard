import { developers } from '../bot/developers.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { AppError } from '../errors.js';
import { addConfirmation } from './layout-ui.js';
import { defaults } from '../bot/registry.js';
import { dangerous } from '../core.js';
import { embed } from './ui.js';
function requirePermissionManager(component, user, before, after) {
    const kind = component === 'grant' ? JSON.parse(before ?? after ?? 'null')?.kind : undefined;
    if (component === 'permission-role' || component.startsWith('staff/') || kind === 'admin' || kind?.startsWith('staff:'))
        developers.require(user);
}
export async function previewHistory(ctx, i, id) {
    const row = ctx.store.get('SELECT * FROM configuration_history WHERE guild_id=? AND id=?', i.guildId, id);
    if (!row)
        throw new AppError('VALIDATION_ERROR', 'Configuration history entry not found in this guild.');
    requirePermissionManager(String(row.component), i.user.id, row.before_json, row.after_json);
    if (row.component === 'authorization')
        throw new AppError('VALIDATION_ERROR', 'Authorization history is retained for audit. Authorization must be changed by a developer through /dev server authorize, /dev server deauthorize or /dev server info.');
    if (row.component === 'antiping')
        throw new AppError('VALIDATION_ERROR', 'Anti-ping changes are retained for audit. Use /automod antiping to change Discord protection and keep its rule synchronized.');
    const key = addConfirmation(ctx, { guild: i.guildId, user: i.user.id, snapshot: id, prune: false, fingerprint: row.before_json ?? 'null', action: 'history' });
    await i.editReply({ embeds: [embed('Confirm configuration rollback', `**History #${id} · ${row.component}**\nRestore the values from before this change. This can change Anti-Nuke mode, command access, or verification policy. A verified database backup is required before applying the rollback.\n\nPrevious values:\n${(row.before_json ?? 'Default/unconfigured state').slice(0, 2200)}\n\nExpires in two minutes.`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`history:apply:${key}`).setLabel('Restore previous configuration').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`history:cancel:${key}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))], allowedMentions: { parse: [] } });
}
export function registerHistory(registry) {
    registry.component({ prefix: 'history:', kinds: ['button'], metadata: { ...defaults, category: 'configuration', access: 'owner' }, execute: async (ctx, i) => {
            const [, action, key] = i.customId.split(':'), p = ctx.confirmations.get(key);
            if (!p || p.action !== 'history' || p.guild !== i.guildId || p.user !== i.user.id || p.expires < Date.now())
                throw new AppError('VALIDATION_ERROR', 'Configuration rollback confirmation expired or belongs to another user/server.');
            ctx.confirmations.delete(key);
            if (action === 'cancel') {
                await i.editReply({ content: 'Rollback cancelled.', embeds: [], components: [] });
                return;
            }
            if (action !== 'apply')
                throw new AppError('VALIDATION_ERROR', 'Invalid rollback control.');
            const row = ctx.store.get('SELECT * FROM configuration_history WHERE guild_id=? AND id=?', i.guildId, p.snapshot);
            if (!row || (row.before_json ?? 'null') !== p.fingerprint)
                throw new AppError('VALIDATION_ERROR', 'History changed. Review a fresh rollback.');
            requirePermissionManager(String(row.component), i.user.id, row.before_json, row.after_json);
            if (!ctx.databaseBackups)
                throw new AppError('DATABASE_ERROR', 'Database backup service unavailable. No rollback performed.');
            const previous = row.before_json === null ? null : JSON.parse(row.before_json), current = row.after_json === null ? null : JSON.parse(row.after_json);
            if (previous?.guild_id && previous.guild_id !== i.guildId || previous?.guildId && previous.guildId !== i.guildId)
                throw new AppError('DATABASE_ERROR', 'Guild mismatch in configuration history.');
            if (row.component === 'settings') {
                if (!previous)
                    throw new AppError('VALIDATION_ERROR', 'No previous settings are available.');
                for (const id of [previous.verifiedRoleId, previous.quarantineRoleId].filter(Boolean)) {
                    const role = await i.guild.roles.fetch(id);
                    if (!role || role.managed || !role.editable || dangerous(role.permissions.bitfield))
                        throw new AppError('VALIDATION_ERROR', 'A saved verification/quarantine role is now missing or unsafe. Configure a safe role first.');
                }
            }
            // Database backup service performs only internal operations; leave the caller guild scope explicitly.
            await ctx.databaseBackups.create('before-config-rollback');
            ctx.assertActive();
            if (row.component === 'settings')
                ctx.store.save({ ...previous, guildId: i.guildId, authorized: true }, i.user.id);
            else {
                const mappings = { grant: { table: 'grants', key: 'user_id' }, 'permission-role': { table: 'permission_roles', key: 'role_id' }, provider: { table: 'provider_config', key: 'provider' }, command: { table: 'command_settings', key: 'command' }, feature: { table: 'feature_settings', key: 'feature' }, 'backup-config': { table: 'backup_config', key: 'guild_id' } };
                const base = String(row.component).split(':')[0], mapping = mappings[base];
                if (!mapping)
                    throw new AppError('VALIDATION_ERROR', 'This history component does not support automatic rollback.');
                const identity = previous ?? current;
                if (!identity)
                    throw new AppError('VALIDATION_ERROR', 'No rollback identity available.');
                ctx.store.transaction(() => {
                    const args = [i.guildId, identity[mapping.key]];
                    let where = `guild_id=? AND ${mapping.key}=?`;
                    if (base === 'grant') {
                        where += ' AND kind=?';
                        args.push(identity.kind);
                    }
                    ctx.store.run(`DELETE FROM ${mapping.table} WHERE ${where}`, ...args);
                    if (previous) {
                        const allowed = ctx.store.db.prepare(`PRAGMA table_info(${mapping.table})`).all().map(c => String(c.name));
                        const columns = allowed.filter(k => Object.hasOwn(previous, k));
                        ctx.store.run(`INSERT INTO ${mapping.table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(k => previous[k]));
                    }
                    ctx.store.history(i.guildId, row.component, current, previous, i.user.id);
                });
            }
            ctx.logs.push(i.guildId, embed('Configuration rolled back', `History #${row.id} (${row.component}) by ${i.user.id}; database backup verified first.`));
            await i.editReply({ content: 'Previous configuration restored. The rollback is recorded in configuration history.', embeds: [], components: [] });
        } });
}
