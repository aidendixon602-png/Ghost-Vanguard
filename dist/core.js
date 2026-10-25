import { AuditLogEvent, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
export const DANGEROUS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageThreads];
export const dangerous = (bits) => new PermissionsBitField(BigInt(bits)).any(DANGEROUS);
/**
 * Permissions that hand over control of the server. Granting one of these is
 * treated as an incident on the first occurrence (the dangerous_grant rule).
 * Kept narrower than DANGEROUS so routine moderator promotions do not trigger it.
 */
export const ESCALATION = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageWebhooks];
const ESCALATION_MASK = ESCALATION.reduce((all, bit) => all | BigInt(bit), 0n);
/** Escalation permissions present in `after` that were not present in `before`. */
export function escalationAdded(before, after) {
    return toBits(after) & ESCALATION_MASK & ~toBits(before);
}
// Audit-log permission values arrive as strings; a malformed one must not break event handling.
function toBits(value) {
    try {
        return BigInt(value ?? 0);
    }
    catch {
        return 0n;
    }
}
export const RULES = [
    { key: 'mass_ban', title: 'Ban', count: 5, seconds: 60, punishment: 'strip', revert: true, actions: [AuditLogEvent.MemberBanAdd] },
    { key: 'bot_add', title: 'Bot Add', count: 1, seconds: 60, punishment: 'strip', revert: true, actions: [AuditLogEvent.BotAdd] },
    { key: 'channel_create', title: 'Channel Create', count: 6, seconds: 120, punishment: 'strip', revert: true, actions: [AuditLogEvent.ChannelCreate] },
    { key: 'channel_delete', title: 'Channel Delete', count: 3, seconds: 120, punishment: 'strip', revert: false, actions: [AuditLogEvent.ChannelDelete] },
    { key: 'mass_kick', title: 'Kick', count: 5, seconds: 120, punishment: 'strip', revert: false, actions: [AuditLogEvent.MemberKick] },
    { key: 'dangerous_grant', title: 'Permission Grant', count: 1, seconds: 60, punishment: 'strip', revert: true, recipient: true, actions: [], singleEvent: true },
    { key: 'role_create', title: 'Role Create', count: 8, seconds: 120, punishment: 'strip', revert: true, actions: [AuditLogEvent.RoleCreate] },
    { key: 'role_delete', title: 'Role Delete', count: 5, seconds: 120, punishment: 'strip', revert: false, actions: [AuditLogEvent.RoleDelete] },
    { key: 'role_grant', title: 'Role Invite', count: 8, seconds: 60, punishment: 'strip', revert: true, actions: [AuditLogEvent.MemberRoleUpdate] },
    { key: 'guild_update', title: 'Server Update', count: 5, seconds: 120, punishment: 'strip', revert: false, actions: [AuditLogEvent.GuildUpdate] },
    { key: 'timeout', title: 'Timeout', count: 10, seconds: 120, punishment: 'strip', revert: true, actions: [] },
    { key: 'webhook_change', title: 'Webhook', count: 3, seconds: 60, punishment: 'strip', revert: true, actions: [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate, AuditLogEvent.WebhookDelete] },
    { key: 'channel_update', title: 'Channel Update', count: 15, seconds: 60, actions: [AuditLogEvent.ChannelUpdate, AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete] },
    { key: 'role_update', title: 'Role Update', count: 15, seconds: 60, actions: [AuditLogEvent.RoleUpdate] },
    { key: 'member_prune', title: 'Member Prune', count: 1, seconds: 60, actions: [AuditLogEvent.MemberPrune], singleEvent: true },
    { key: 'automod_tamper', title: 'AutoMod', count: 1, seconds: 60, actions: [AuditLogEvent.AutoModerationRuleDelete], singleEvent: true },
    { key: 'join_flood', title: 'Join Flood', count: 12, seconds: 15, actions: [] },
];
/**
 * Everyday rules: the first time someone hits one, the change is undone and they get a warning instead of
 * being stripped. Hitting any of them again within WARNING_MEMORY_MS gets the normal punishment. Other
 * dangerous permission grants also warn first, except self-assigned Administrator or Manage Server,
 * which always strips and reverts immediately. Other bots' offences do not get a warning.
 */
/**
 * Well-known verification and role bots. They give ordinary roles all day (verified, level and reaction roles),
 * so their member-role updates are exempt from Role Invite automatically. Dangerous permission grants and every
 * other rule still apply. A server can switch one off with /antinuke whitelist bots allowed:false.
 */
export const KNOWN_ROLE_BOTS = {
    '426537812993638400': 'Bloxlink',
    '298796807323123712': 'RoVer',
    '235148962103951360': 'Carl-bot',
    '155149108183695360': 'Dyno',
    '159985870458322944': 'MEE6',
};
/** What is recorded when a moderator leaves the (optional) reason empty. */
export const NO_REASON = 'No reason given';
export const WARN_FIRST = new Set(['role_grant', 'role_create', 'role_update', 'channel_create', 'channel_update', 'guild_update', 'timeout', 'webhook_change']);
export const WARNING_MEMORY_MS = 60 * 60 * 1000;
export function ruleFor(action) {
    return RULES.find(r => r.actions.includes(action));
}
export function overrideRule(rule, custom, defaults) {
    // The preset is locked: saved custom limits, shared defaults and per-rule toggles are ignored.
    void custom;
    void defaults;
    return { ...rule };
}
export function decideLinks(results) {
    const ids = new Set(results.flatMap(r => r.kind === 'found' ? [r.id] : []));
    if (ids.size > 1)
        return { kind: 'conflict' };
    if (ids.size === 1)
        return { kind: 'found', id: [...ids][0] };
    return results.length > 0 && results.every(r => r.kind === 'absent') ? { kind: 'absent' } : { kind: 'unavailable' };
}
export function ageDays(created, now = Date.now()) {
    const timestamp = Date.parse(created);
    if (!Number.isFinite(timestamp))
        throw new Error('Roblox returned an invalid creation date.');
    return Math.floor((now - timestamp) / 86400000);
}
export class KeyedQueue {
    tails = new Map();
    run(key, fn) {
        const current = (this.tails.get(key) ?? Promise.resolve()).catch(() => { }).then(fn);
        this.tails.set(key, current);
        void current.finally(() => {
            if (this.tails.get(key) === current)
                this.tails.delete(key);
        }).catch(() => { });
        return current;
    }
}
export class Cooldowns {
    until = new Map();
    clearPrefix(prefix) {
        for (const key of this.until.keys())
            if (key.startsWith(prefix))
                this.until.delete(key);
    }
    take(key, ms, now = Date.now()) {
        if ((this.until.get(key) ?? 0) > now)
            return false;
        this.until.set(key, now + ms);
        if (this.until.size > 10000)
            for (const [k, expiry] of this.until)
                if (expiry <= now)
                    this.until.delete(k);
        return true;
    }
}
export const clip = (text, max = 1000) => text.length <= max ? text : text.slice(0, max - 1) + '…';
