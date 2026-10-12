import { Colors, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { dangerous } from '../../core.js';
import { embed } from '../../ui/ui.js';
import { setFeature } from '../../features/settings.js';
import { robloxGroupInfo, robloxGroupRanks, robloxUserByName } from '../../integrations/roblox-api.js';
import { addToBlacklist, GROUP_DEFAULTS, groupConfig, lookupCard, NETWORK_DEFAULTS, networkConfig, partnerIds, removeFromBlacklist, syncGroupRoles } from '../../features/roblox-tools.js';

/** "Builderman", "156" or a profile link → Roblox user ID. */
async function resolveRoblox(input: string): Promise<string> {
    const raw = input.trim(), fromLink = /roblox\.com\/users\/(\d+)/i.exec(raw)?.[1];
    if (fromLink) return fromLink;
    if (/^\d{1,20}$/.test(raw)) return raw;
    if (!/^[A-Za-z0-9_]{3,20}$/.test(raw)) throw new AppError('VALIDATION_ERROR', 'Enter a Roblox username, user ID or profile link.');
    const found = await robloxUserByName(raw);
    if (!found) throw new AppError('VALIDATION_ERROR', `No Roblox account is named **${raw}**.`);
    return found.id;
}
const accountOption = (o: any) => o.setName('account').setDescription('Roblox username, user ID or profile link').setRequired(true).setMaxLength(100);

export default defineCommand(new SlashCommandBuilder().setName('roblox').setDescription('Roblox: look up accounts, blacklist, shared ban network and group rank sync')
    .addSubcommand(s => s.setName('lookup').setDescription('Profile card: account age, past names, groups, linked Discord, blacklist status')
        .addStringOption(o => o.setName('account').setDescription('Roblox username, user ID or profile link').setMaxLength(100))
        .addUserOption(o => o.setName('member').setDescription('Or a Discord member who verified')))
    .addSubcommand(s => s.setName('blacklist').setDescription('Block a Roblox account from verifying here (and flag it on join)')
        .addStringOption(accountOption).addStringOption(o => o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(300)))
    .addSubcommand(s => s.setName('unblacklist').setDescription('Remove a Roblox account from this server\'s blacklist').addStringOption(accountOption))
    .addSubcommand(s => s.setName('blacklisted').setDescription('List blacklisted Roblox accounts'))
    .addSubcommand(s => s.setName('network').setDescription('Share blacklists with your partner servers (both servers must add each other)')
        .addBooleanOption(o => o.setName('share').setDescription('Send this server\'s blacklist to partners').setRequired(true))
        .addBooleanOption(o => o.setName('use').setDescription('Block accounts blacklisted by partners').setRequired(true)))
    .addSubcommand(s => s.setName('partner').setDescription('Add or remove a partner server for the ban network (do it in both servers)')
        .addStringOption(o => o.setName('action').setDescription('Add or remove').setRequired(true).addChoices({ name: 'Add partner', value: 'add' }, { name: 'Remove partner', value: 'remove' }))
        .addStringOption(o => o.setName('server_id').setDescription('The other server\'s ID (Vanguard must be in it)').setRequired(true).setMinLength(17).setMaxLength(20)))
    .addSubcommand(s => s.setName('group').setDescription('Set the Roblox group whose ranks give Discord roles')
        .addStringOption(o => o.setName('group_id').setDescription('Group ID from the group page link (leave empty to turn off)').setMaxLength(20)))
    .addSubcommand(s => s.setName('bind').setDescription('Give a Discord role for a group rank')
        .addIntegerOption(o => o.setName('rank').setDescription('Group rank number (1-255)').setRequired(true).setMinValue(1).setMaxValue(255))
        .addRoleOption(o => o.setName('role').setDescription('Discord role').setRequired(true))
        .addStringOption(o => o.setName('mode').setDescription('Exactly this rank, or this rank and above (default)').addChoices({ name: 'This rank and above', value: 'min' }, { name: 'Exactly this rank', value: 'exact' })))
    .addSubcommand(s => s.setName('unbind').setDescription('Stop giving a role from group ranks').addRoleOption(o => o.setName('role').setDescription('Discord role').setRequired(true)))
    .addSubcommand(s => s.setName('binds').setDescription('Show the group and its rank → role binds'))
    .addSubcommand(s => s.setName('sync').setDescription('Re-check someone\'s Roblox verification and group roles now')
        .addUserOption(o => o.setName('member').setDescription('Member (default: you)'))),
{ category: 'verification', access: 'security', cooldown: 2000 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId;
    if (sub === 'lookup') {
        const member = i.options.getUser('member'), account = i.options.getString('account');
        let id: string | null = null;
        if (member) {
            id = ctx.store.get('SELECT roblox_id FROM links WHERE guild_id=? AND user_id=?', guild, member.id)?.roblox_id ?? null;
            if (!id) throw new AppError('VALIDATION_ERROR', `<@${member.id}> has not verified a Roblox account here.`);
        } else if (account) id = await resolveRoblox(account);
        else throw new AppError('VALIDATION_ERROR', 'Give a Roblox account or pick a member.');
        const card = await lookupCard(ctx.store, guild, String(id));
        if (!card) throw new AppError('INTEGRATION_ERROR', 'Roblox did not return that account. Try again in a moment.');
        await i.editReply({ embeds: [card], allowedMentions: { parse: [] } });
        return;
    }
    if (sub === 'blacklist' || sub === 'unblacklist') {
        const id = await resolveRoblox(i.options.getString('account', true));
        if (sub === 'blacklist') {
            const reason = i.options.getString('reason', true);
            addToBlacklist(ctx.store, guild, id, `${reason} (by ${i.user.tag})`, reason);
            ctx.logs.push(guild, embed('Roblox account blacklisted', `By <@${i.user.id}> · [${id}](https://www.roblox.com/users/${id}/profile)\n**Reason:** ${reason}`, Colors.Red));
            return `Roblox account \`${id}\` is blacklisted. It cannot verify here, and staff are alerted if it joins on any Discord account.${networkConfig(ctx.store, guild).share ? ' It was shared with your network.' : ''}`;
        }
        if (!removeFromBlacklist(ctx.store, guild, id)) throw new AppError('VALIDATION_ERROR', 'That account is not on this server\'s blacklist.');
        ctx.logs.push(guild, embed('Roblox account unblacklisted', `By <@${i.user.id}> · \`${id}\``, Colors.Green));
        return `Roblox account \`${id}\` is no longer blacklisted here.`;
    }
    if (sub === 'blacklisted') {
        const rows = ctx.store.all('SELECT roblox_id,reason FROM blocked_accounts WHERE guild_id=? ORDER BY rowid DESC LIMIT 25', guild);
        const total = Number(ctx.store.get('SELECT COUNT(*) AS n FROM blocked_accounts WHERE guild_id=?', guild)?.n ?? 0);
        return `**Blacklisted Roblox accounts · ${total}**\n${rows.map(r => `• [${r.roblox_id}](https://www.roblox.com/users/${r.roblox_id}/profile) · ${String(r.reason ?? '').slice(0, 80)}`).join('\n') || 'None.'}${total > 25 ? '\n…newest 25 shown' : ''}`;
    }
    if (sub === 'network') {
        const share = i.options.getBoolean('share', true), use = i.options.getBoolean('use', true);
        setFeature(ctx.store, guild, 'network', NETWORK_DEFAULTS, { share, use }, i.user.id);
        // Partners only ever see a plain reason, never moderator names or Discord IDs.
        if (share) for (const r of ctx.store.all('SELECT roblox_id,reason FROM blocked_accounts WHERE guild_id=?', guild)) {
            const source = /Linked Discord account banned: (\d{17,20})/.exec(String(r.reason ?? ''))?.[1] ?? null;
            ctx.store.run('INSERT OR REPLACE INTO roblox_network(roblox_id,guild_id,reason,at,source_user) VALUES(?,?,?,?,?)', r.roblox_id, guild, source ? 'Banned member' : 'Blacklisted', Date.now(), source);
        }
        else ctx.store.run('DELETE FROM roblox_network WHERE guild_id=?', guild);
        ctx.logs.push(guild, embed('Ban network changed', `By <@${i.user.id}> · share ${share ? 'on' : 'off'} · use ${use ? 'on' : 'off'}`, Colors.Orange));
        const partners = partnerIds(ctx.store, guild);
        return `**Ban network:** sharing ${share ? '🟢 on' : '⚪ off'} · using partner bans ${use ? '🟢 on' : '⚪ off'}.\n**Partners (confirmed both ways):** ${partners.length ? partners.map(id => i.client.guilds.cache.get(id)?.name ?? id).join(', ') : 'none yet · add them with `/roblox partner`'}`;
    }
    if (sub === 'partner') {
        const action = i.options.getString('action', true), other = i.options.getString('server_id', true).trim();
        if (!/^\d{17,20}$/.test(other) || other === guild) throw new AppError('VALIDATION_ERROR', 'Enter another server\'s ID.');
        if (action === 'remove') {
            ctx.store.db.prepare('DELETE FROM network_partners WHERE guild_id=? AND partner_id=?').run(guild, other);
            return `Removed partner \`${other}\`. Their bans no longer apply here.`;
        }
        const target = i.client.guilds.cache.get(other);
        if (!target) throw new AppError('VALIDATION_ERROR', 'Vanguard is not in that server, so it cannot be a partner.');
        ctx.store.db.prepare('INSERT OR REPLACE INTO network_partners(guild_id,partner_id,by_id,at) VALUES(?,?,?,?)').run(guild, other, i.user.id, Date.now());
        ctx.logs.push(guild, embed('Ban network partner added', `By <@${i.user.id}> · **${target.name}** (\`${other}\`)`, Colors.Orange));
        const mutual = partnerIds(ctx.store, guild).includes(other);
        return mutual ? `**${target.name}** is now a confirmed partner. Turn on sharing/using with \`/roblox network\` in both servers.` : `Partner request saved. It becomes active once someone in **${target.name}** runs \`/roblox partner action:Add partner server_id:${guild}\` there too.`;
    }
    if (sub === 'group') {
        const raw = i.options.getString('group_id')?.trim();
        if (!raw) { setFeature(ctx.store, guild, 'robloxgroup', GROUP_DEFAULTS, { groupId: null, groupName: null }, i.user.id); return 'Group rank sync is **off**. Binds are kept for later.'; }
        if (!/^\d{1,15}$/.test(raw)) throw new AppError('VALIDATION_ERROR', 'Use the number from your group page link, e.g. roblox.com/communities/**1234567**/...');
        const info = await robloxGroupInfo(raw);
        if (!info) throw new AppError('VALIDATION_ERROR', 'Roblox did not find that group.');
        setFeature(ctx.store, guild, 'robloxgroup', GROUP_DEFAULTS, { groupId: info.id, groupName: info.name }, i.user.id);
        const ranks = (await robloxGroupRanks(info.id)).filter(r => r.rank > 0).map(r => `\`${r.rank}\` ${r.name}`).join(' · ');
        return `Group set to **${info.name}** (\`${info.id}\`).\n**Ranks:** ${ranks || 'unavailable'}\nNow link ranks to roles with \`/roblox bind\`.`;
    }
    const c = groupConfig(ctx.store, guild);
    if (sub === 'bind') {
        const role = i.options.getRole('role', true), rank = i.options.getInteger('rank', true), mode = (i.options.getString('mode') ?? 'min') as 'min' | 'exact';
        if (role.managed || role.id === guild) throw new AppError('VALIDATION_ERROR', 'Pick a normal role.');
        if (dangerous(BigInt(role.permissions.bitfield))) throw new AppError('VALIDATION_ERROR', 'That role has moderation or admin permissions. Roblox ranks can only give plain roles.');
        if (role.position >= (ctx.actor?.roles?.highest?.position ?? 0) && i.guild.ownerId !== i.user.id) throw new AppError('PERMISSION_ERROR', 'Pick a role below your own highest role.');
        if (c.binds.length >= 25 && !c.binds.some(b => b.roleId === role.id)) throw new AppError('VALIDATION_ERROR', 'Up to 25 binds.');
        setFeature(ctx.store, guild, 'robloxgroup', GROUP_DEFAULTS, { binds: [...c.binds.filter(b => b.roleId !== role.id), { rank, roleId: role.id, mode }].sort((a, b) => a.rank - b.rank) }, i.user.id);
        return `<@&${role.id}> is given for group rank **${rank}${mode === 'min' ? ' and above' : ' exactly'}**.${c.groupId ? '' : '\n⚠ Set the group first with `/roblox group`.'} Members get it the next time they verify or sync (every ~15 minutes).`;
    }
    if (sub === 'unbind') {
        const role = i.options.getRole('role', true);
        if (!c.binds.some(b => b.roleId === role.id)) throw new AppError('VALIDATION_ERROR', 'That role is not bound.');
        setFeature(ctx.store, guild, 'robloxgroup', GROUP_DEFAULTS, { binds: c.binds.filter(b => b.roleId !== role.id) }, i.user.id);
        return `<@&${role.id}> is no longer given from group ranks (members keep it until removed).`;
    }
    if (sub === 'binds')
        return `**Group:** ${c.groupId ? `${c.groupName} (\`${c.groupId}\`)` : 'not set · use `/roblox group`'}\n${c.binds.map(b => `• rank **${b.rank}**${b.mode === 'min' ? '+' : ''} → <@&${b.roleId}>`).join('\n') || 'No binds yet · use `/roblox bind`'}`;
    // sync
    const target = i.options.getUser('member') ?? i.user;
    const member = await i.guild.members.fetch(target.id).catch(() => null);
    if (!member) throw new AppError('VALIDATION_ERROR', 'They are not in this server.');
    const result = await ctx.roblox.sync(member);
    const linked = ctx.store.get('SELECT roblox_id FROM links WHERE guild_id=? AND user_id=?', guild, member.id)?.roblox_id;
    const extra = linked && !/Group rank/.test(result) ? await syncGroupRoles(ctx.store, member, String(linked)) : '';
    return `${result}${extra}`;
}, { subcommands: { lookup: { responseKind: 'info' }, binds: { responseKind: 'info' }, blacklisted: { responseKind: 'info' } } });
