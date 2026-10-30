import { PermissionsBitField } from 'discord.js';
import { Cooldowns } from '../core.js';
import { config } from '../config.js';
import { inviteUrl } from './invite.js';
import { developers } from './developers.js';
import { AppError } from '../errors.js';
import { aboveSupremeMessage, botRank, needsDeveloper, rankOf, RANKS, requiredRank } from './ranks.js';
import { ANTINUKE_LOCK_KEYS, antinukeLocked } from './env-rules.js';
const lockedKey = (key) => !!key && antinukeLocked() && ANTINUKE_LOCK_KEYS.has(key.replace(/\/$/, ''));
export const ANTINUKE_LOCKED_MESSAGE = 'Anti-nuke is **locked** in the bot settings (`ANTINUKE_LOCK`), so its rules cannot be weakened or turned off from Discord. Only a Developer can change them.';
const permissionNames = (permissions) => permissions.map(p => new PermissionsBitField(p).toArray().join(' ')).map(p => p.replace(/([a-z])([A-Z])/g, '$1 $2'));
export class Guard {
    store;
    ready;
    cooldowns = new Cooldowns();
    constructor(store, ready) {
        this.store = store;
        this.ready = ready;
    }
    allowed(policy, guildId, user, actor, command, rankKey) {
        if (!guildId && (policy.guildOnly || !policy.dmAllowed))
            return false;
        if (guildId && this.store.get('SELECT 1 FROM server_bans WHERE guild_id=?', guildId))
            return false;
        if (policy.requiresAuthorization && (!guildId || !this.store.isAuthorized(guildId)))
            return false;
        if (policy.requiresAuthorization && this.ready && !this.ready(guildId))
            return false;
        // Developer-only commands: the Developer rank is the only way in (no Discord permission, server role
        // or lower bot-wide rank).
        // ANTINUKE_LOCK (.env): turning anti-nuke off or changing its layers is Developer-only.
        if (lockedKey(rankKey ?? command))
            return botRank(this.store, user) >= RANKS.developer && this.enabledHere(policy, guildId, command);
        if (needsDeveloper(rankKey ?? command))
            return botRank(this.store, user) >= requiredRank(rankKey ?? command) && this.enabledHere(policy, guildId, command);
        // For ordinary slash policies, Developers (the bot owner and DEVELOPER_IDS) may use commands without
        // Administrator, Manage Roles or a server role. `/restart` separately requires DEVELOPER_IDS exactly.
        if (developers.has(user))
            return this.enabledHere(policy, guildId, command);
        // A Vanguard staff rank high enough for this command replaces the Discord-permission and access checks.
        const need = requiredRank(rankKey ?? command);
        const byRank = need !== undefined && rankOf(this.store, guildId, user, actor, rankKey ?? command) >= need;
        if (byRank)
            return this.enabledHere(policy, guildId, command);
        if (policy.developerOnly && !developers.has(user))
            return false;
        const roleAccess = actor && [...(actor.roles?.cache?.keys() ?? [])].some(role => this.store.get('SELECT 1 FROM permission_roles WHERE guild_id=? AND role_id=? AND (access=? OR access=?)', actor.guild.id, role, 'admin', policy.category === 'moderation' ? 'moderator' : 'admin'));
        if (policy.access !== 'member' && !developers.has(user) && (!actor || actor.id !== actor.guild.ownerId && (policy.access === 'owner' || !this.store.hasGrant(actor.guild.id, actor.id, 'admin') && !roleAccess)))
            return false;
        if (!this.enabledHere(policy, guildId, command))
            return false;
        return !policy.requiredPermissions.length || !!actor?.permissions.has(policy.requiredPermissions);
    }
    /** Commands and features a server switched off stay off for every rank. */
    enabledHere(policy, guildId, command) {
        if (command && guildId && policy.requiresAuthorization) {
            if (this.store.get('SELECT enabled FROM command_settings WHERE guild_id=? AND command=?', guildId, command)?.enabled === 0)
                return false;
            const feature = policy.category === 'moderation' ? 'moderation' : policy.category === 'verification' ? 'verification' : command === 'ask' ? 'ai' : ['snapshot', 'backup', 'copylayout'].includes(command) ? 'snapshots' : null;
            if (feature && this.store.get('SELECT enabled FROM feature_settings WHERE guild_id=? AND feature=?', guildId, feature)?.enabled === 0)
                return false;
        }
        return true;
    }
    clearGuild(id) {
        this.cooldowns.clearPrefix(`${id}:`);
    }
    async check(i, policy, key, consumeCooldown = true, refreshMember = false) {
        if (!i.inCachedGuild()) {
            const link = /^\d{17,20}$/.test(config.clientId) ? `\n[Invite Ghost Vanguard to this server](${inviteUrl(config.clientId, i.guildId ?? undefined)})` : '';
            throw new AppError('VALIDATION_ERROR', `Ghost Vanguard is not connected to this server. Install the bot using the invite link, then retry. If it is already a server member, wait for reconnection.${link}`);
        }
        if (this.store.get('SELECT 1 FROM server_bans WHERE guild_id=?', i.guildId))
            throw new AppError('AUTHORIZATION_ERROR', 'This server is banned from Ghost Vanguard.');
        if (policy.requiresAuthorization) {
            this.store.assertAuthorized(i.guildId);
            if (this.ready && !this.ready(i.guildId))
                throw new AppError('AUTHORIZATION_ERROR', 'Server systems are initializing. A developer listed in `DEVELOPER_IDS` can run `/dev server authorize` to retry initialization.');
        }
        // Interaction member contains current permission data; fetch only role data if not cached.
        const actor = refreshMember ? await i.guild.members.fetch({ user: i.user.id, force: true }) : i.member;
        if (lockedKey(key) && botRank(this.store, i.user.id) < RANKS.developer)
            throw new AppError('PERMISSION_ERROR', ANTINUKE_LOCKED_MESSAGE);
        if (needsDeveloper(key) && botRank(this.store, i.user.id) < requiredRank(key))
            throw new AppError('PERMISSION_ERROR', aboveSupremeMessage(key));
        if (policy.developerOnly && (requiredRank(key) ?? Infinity) > rankOf(this.store, i.guildId, i.user.id, actor, key))
            developers.require(i.user.id);
        if (!this.allowed(policy, i.guildId, i.user.id, actor, undefined, key))
            throw new AppError('PERMISSION_ERROR', 'You do not have permission to use this action.');
        const me = i.guild.members.me ?? await i.guild.members.fetchMe();
        const missing = policy.botPermissions.filter(p => !me.permissions.has(p));
        if (missing.length)
            throw new AppError('PERMISSION_ERROR', `Ghost Vanguard is missing:\n${permissionNames(missing).map(p => `• ${p}`).join('\n')}`);
        const rankOk = developers.has(i.user.id) || (requiredRank(key) ?? Infinity) <= rankOf(this.store, i.guildId, i.user.id, actor, key);
        for (const [member, permissions, label] of [[me, policy.channelPermissions ?? [], 'Ghost Vanguard'], [actor, rankOk ? [] : policy.userChannelPermissions ?? [], 'You']]) {
            if (!permissions.length)
                continue;
            const channel = i.channel;
            const channelMissing = permissions.filter(p => !channel || !('permissionsFor' in channel) || !channel.permissionsFor(member)?.has(p));
            if (channelMissing.length)
                throw new AppError('PERMISSION_ERROR', `${label} need these channel permissions:\n${permissionNames(channelMissing).join('\n')}`);
        }
        const control = key.split('/')[0];
        const command = { anpanel: 'antinuke', ruleui: 'antinuke', helpui: 'help', permui: 'perm', incident: 'snapshot', restore: 'snapshot', layoutselect: 'snapshot', layoutcancel: 'snapshot', snapshotdelete: 'snapshot', snapshotcancel: 'snapshot', snapshotpage: 'snapshot' }[control] ?? control;
        const configured = policy.requiresAuthorization ? this.store.get('SELECT * FROM command_settings WHERE guild_id=? AND command=?', i.guildId, command) : undefined;
        const feature = policy.category === 'moderation' ? 'moderation' : policy.category === 'verification' ? 'verification' : command === 'ask' ? 'ai' : ['snapshot', 'backup', 'copylayout', 'restore'].includes(command) ? 'snapshots' : null;
        if (policy.requiresAuthorization && (configured?.enabled === 0 || feature && this.store.get('SELECT enabled FROM feature_settings WHERE guild_id=? AND feature=?', i.guildId, feature)?.enabled === 0))
            throw new AppError('VALIDATION_ERROR', 'This command or feature is disabled in this guild.');
        const cooldown = configured?.cooldown_ms ?? policy.cooldown;
        if (consumeCooldown && !this.cooldowns.take(`${i.guildId}:${i.user.id}:${key}`, cooldown))
            throw new AppError('RATE_LIMIT_ERROR', `Wait ${Math.ceil(cooldown / 1000)} seconds between uses of this action.`);
        return actor;
    }
}
