import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { banById, enforceOnJoin, listExceptions, networkDeps, recordId, revokeException } from '../../security/network-ban.js';
/** /network exceptions: see and cancel servers' "let this genrebanned person back in here" exceptions. */
export default defineCommand(new SlashCommandBuilder().setName('netexception').setDescription('Developer: servers that let a genrebanned user back in (their server only)')
    .addSubcommand(s => s.setName('list').setDescription('Active genreban exceptions, newest first')
    .addStringOption(o => o.setName('user_id').setDescription('Only this user').setMinLength(17).setMaxLength(20)))
    .addSubcommand(s => s.setName('revoke').setDescription('Cancel an exception: the genreban applies in that server again')
    .addIntegerOption(o => o.setName('id').setDescription('Exception number from the list or the DM').setRequired(true).setMinValue(1))), { category: 'developer', developerOnly: true, requiresAuthorization: false, responseKind: 'info' }, async (ctx, i) => {
    if (i.options.getSubcommand() === 'list') {
        const rows = listExceptions(ctx.store, i.options.getString('user_id') ?? undefined);
        return rows.map(r => `**#${r.id}** · \`${r.user_id}\` allowed in **${r.guild_name ?? r.guild_id}** by <@${r.by_id}> · <t:${Math.floor(r.at / 1000)}:R>\n${recordId({ id: r.ban_id, kind: 'genreban' })} · ${r.reason}`).join('\n\n')
            || 'No active genreban exceptions.';
    }
    const id = i.options.getInteger('id', true);
    const before = ctx.store.get('SELECT * FROM network_exceptions WHERE id=?', id);
    if (!before)
        throw new AppError('VALIDATION_ERROR', `There is no exception #${id}.`);
    if (before.revoked_at)
        return `Exception #${id} was already cancelled.`;
    revokeException(ctx.store, id, i.user.id);
    // If they are in that server right now, the genreban applies again immediately.
    const guild = ctx.client.guilds.cache.get(String(before.guild_id));
    const ban = banById(ctx.store, Number(before.ban_id));
    let note = 'If they join that server again, they will be banned.';
    if (guild && ban?.status === 'active' && guild.members.cache.has(String(before.user_id)))
        note = await enforceOnJoin(networkDeps(ctx), guild, String(before.user_id)) ? 'They were in that server and have been banned again.' : 'They are in that server, but could not be banned right now; the regular check will retry.';
    return `Exception #${id} cancelled: the genreban applies in **${before.guild_name ?? before.guild_id}** again. ${note}`;
});
