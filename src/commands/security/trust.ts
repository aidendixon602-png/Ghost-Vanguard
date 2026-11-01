import { KNOWN_ROLE_BOTS } from '../../core.js';
import { Colors, SlashCommandBuilder } from 'discord.js';
import { AppError } from '../../errors.js';
import { defineCommand, type CommandContext } from '../../bot/registry.js';
import { canManageOwnTrust, trustListPage } from '../../ui/antinuke-panel.js';
import { panelFor, trustPanel } from '../../ui/trust-panel.js';
import { embed } from '../../ui/ui.js';
import { whitelistCheck } from '../../ui/whitelist-check.js';

export default defineCommand(new SlashCommandBuilder().setName('trust').setDescription('Anti-nuke whitelist: who anti-nuke leaves alone, and for what')
    .addSubcommand(s => s.setName('add').setDescription('Whitelist a user or role: pick what anti-nuke lets them do and for how long')
        .addUserOption(o => o.setName('user').setDescription('User to whitelist (optional)'))
        .addRoleOption(o => o.setName('role').setDescription('Or a role to whitelist (optional)')))
    .addSubcommand(s => s.setName('remove').setDescription('Take a user or role off the whitelist completely')
        .addUserOption(o => o.setName('user').setDescription('User to remove'))
        .addRoleOption(o => o.setName('role').setDescription('Or role to remove')))
    .addSubcommand(s => s.setName('list').setDescription('Show everyone on the whitelist, what they skip and when it expires')
        .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(100000))
        .addBooleanOption(o => o.setName('expired').setDescription('Include expired entries')))
    .addSubcommand(s => s.setName('admin').setDescription('Separate whitelist: who may hand out Administrator and other protected permissions')
        .addUserOption(o => o.setName('user').setDescription('User'))
        .addRoleOption(o => o.setName('role').setDescription('Or a role'))
        .addBooleanOption(o => o.setName('allowed').setDescription('True (default): they may grant protected permissions · False: stop allowing'))
        .addIntegerOption(o => o.setName('days').setDescription('Expire after this many days (omit for no expiry)').setMinValue(1).setMaxValue(365)))
    .addSubcommand(s => s.setName('check').setDescription('See exactly what anti-nuke lets someone do, and what would get them stripped')
        .addUserOption(o => o.setName('user').setDescription('The person to check').setRequired(true)))
    .addSubcommand(s => s.setName('bots').setDescription('Let a verification bot (Bloxlink, RoVer) give verified roles without tripping anti-nuke')
        .addUserOption(o => o.setName('bot').setDescription('The verification bot').setRequired(true))
        .addBooleanOption(o => o.setName('allowed').setDescription('True to allow, false to remove').setRequired(true))), { category: 'security', cooldown: 1500, access: 'security' }, async (ctx: CommandContext, i) => {
    const actor = ctx.actor!;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
        await i.editReply(trustListPage(ctx, i.guildId, i.user.id, i.options.getInteger('page') ?? 1, i.options.getBoolean('expired') ?? false));
        return;
    }
    if (sub === 'remove') {
        const user = i.options.getUser('user'), role = i.options.getRole('role');
        if (!!user === !!role) throw new AppError('VALIDATION_ERROR', 'Pick exactly one: a user or a role.');
        const id = (user ?? role)!.id;
        if (user && (user.id === i.guild.ownerId)) throw new AppError('VALIDATION_ERROR', 'The server owner is always protected and cannot be removed.');
        const kinds = ctx.store.all(`SELECT kind FROM grants WHERE guild_id=? AND user_id=? AND (kind IN ('trust','trust_role') OR kind LIKE 'trust:%' OR kind LIKE 'trust_role:%')`, i.guildId, id).map(r => String(r.kind));
        if (!kinds.length) return `${user ? `<@${id}>` : `<@&${id}>`} is not on the whitelist.`;
        for (const kind of kinds) ctx.store.revokeGrant(i.guildId, id, kind, actor.id);
        ctx.logs.push(i.guildId, embed('Whitelist entry removed', `By <@${actor.id}> · ${user ? `<@${id}>` : `<@&${id}>`} · ${kinds.length} permission(s) removed`, Colors.Orange));
        return `${user ? `<@${id}>` : `<@&${id}>`} is off the whitelist. Anti-nuke now treats them like everyone else.`;
    }
    if (sub === 'admin') {
        // A second, narrower whitelist: being on the regular whitelist (even "Everything") never allows
        // handing out Administrator or the other protected permissions through Discord.
        const user = i.options.getUser('user'), role = i.options.getRole('role');
        if (!!user === !!role) throw new AppError('VALIDATION_ERROR', 'Pick exactly one: a user or a role.');
        if (role && role.id === i.guildId) throw new AppError('VALIDATION_ERROR', 'You cannot whitelist @everyone.');
        const target = (user ?? role)!.id, allowed = i.options.getBoolean('allowed') ?? true, days = i.options.getInteger('days');
        const who = `<@${role ? '&' : ''}${target}>`;
        // The server owner is granted this automatically: anti-nuke never punishes them, so no entry is needed.
        if (!role && user && user.id === i.guild.ownerId) {
            if (!allowed) ctx.store.revokeGrant(i.guildId, target, 'trust:dangerous_grant', actor.id);
            return allowed
                ? `${who} is the **server owner**, so anti-nuke already allows them to grant Administrator and the other protected permissions. No whitelist entry is needed.`
                : `${who} is the **server owner**, so anti-nuke never punishes them for granting protected permissions, with or without an entry. Any saved entry is now removed.`;
        }
        if (allowed && !canManageOwnTrust(actor.id, i.guild.ownerId) && (target === actor.id || !!role && actor.roles.cache.has(target)))
            throw new AppError('PERMISSION_ERROR', 'Another security administrator (or the server owner) must allow you to grant protected permissions. You can still remove it yourself.');
        const kind = role ? 'trust_role:dangerous_grant' : 'trust:dangerous_grant';
        if (allowed) ctx.store.grant(i.guildId, target, kind, actor.id, days ? days * 24 : undefined);
        else ctx.store.revokeGrant(i.guildId, target, kind, actor.id);
        ctx.logs.push(i.guildId, embed('Permission-grant whitelist changed', `By <@${actor.id}> · ${allowed ? 'allowed' : 'removed'} ${who} · ${allowed && days ? `${days} day(s)` : 'until removed'}`, allowed ? Colors.Orange : Colors.Green));
        if (!allowed) return `${who} can no longer hand out protected permissions. Anti-nuke checks those grants like anyone else's again.`;
        return `${who} can now hand out **Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban Members and Kick Members** through Discord without anti-nuke stepping in${days ? `, for ${days} day(s)` : ''}. This is the permission-grant whitelist only: their other whitelist entries do not allow this, and this entry does not skip any other rule. A first-time grant still warns first and is reverted.`;
    }
    if (sub === 'check') {
        const user = i.options.getUser('user', true);
        const member = await i.guild.members.fetch({ user: user.id }).catch(() => null);
        await i.editReply({ embeds: [whitelistCheck(ctx.store, i.guild, user.id, member ? [...member.roles.cache.keys()] : [], !!user.bot)], allowedMentions: { parse: [] } });
        return;
    }
    if (sub === 'bots') {
        const bot = i.options.getUser('bot', true), allowed = i.options.getBoolean('allowed', true);
        if (!bot.bot) throw new AppError('VALIDATION_ERROR', 'That is a person, not a bot. To whitelist a person use /antinuke whitelist add.');
        if (allowed) { ctx.store.grant(i.guildId, bot.id, 'bot', actor.id); ctx.store.revokeGrant(i.guildId, bot.id, 'bot_denied', actor.id); }
        else { ctx.store.revokeGrant(i.guildId, bot.id, 'bot', actor.id); if (bot.id in KNOWN_ROLE_BOTS) ctx.store.grant(i.guildId, bot.id, 'bot_denied', actor.id); }
        ctx.logs.push(i.guildId, embed('Verification bot exemption changed', `By <@${actor.id}> · ${allowed ? 'allowed' : 'removed'} <@${bot.id}> (member role updates only)`, Colors.Orange));
        const known = KNOWN_ROLE_BOTS[bot.id];
        return `<@${bot.id}> ${allowed ? 'can now give verified roles without tripping anti-nuke. Every other rule still applies to it.' : `no longer has the verification exemption${known ? ` (${known} is normally exempt automatically; it is now switched off for this server)` : ''}.`}`;
    }
    // add: open the panel, preloaded with the chosen user/role and what they have saved.
    const user = i.options.getUser('user'), role = i.options.getRole('role');
    if (user && role) throw new AppError('VALIDATION_ERROR', 'Pick a user or a role, not both. You can switch inside the panel.');
    if (role?.id === i.guildId) throw new AppError('VALIDATION_ERROR', 'You cannot whitelist @everyone.');
    await i.editReply(trustPanel(ctx, i.guildId, i.user.id, panelFor(ctx, i.guildId, (user ?? role)?.id ?? null, !!role)));
});
