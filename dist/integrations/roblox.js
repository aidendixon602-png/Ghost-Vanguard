import { isBotPermissionRole } from '../security/role-policy.js';
import { Colors } from 'discord.js';
import { ageDays, dangerous, KeyedQueue } from '../core.js';
import { addToBlacklist, blacklistEntry, syncGroupRoles } from '../features/roblox-tools.js';
import { AppError } from '../errors.js';
import { HttpReads } from './http.js';
import { embed, memberOrNull } from '../ui/ui.js';
import { getLink } from './custom-verification.js';
export class Roblox {
    store;
    logs;
    queue = new KeyedQueue();
    http = new HttpReads();
    refreshing = false;
    // Compat: dashboard still calls providerStatus; report custom as enabled
    providerStatus(guild, _provider) {
        const s = this.store.settings(guild);
        const enabled = !!s.verifiedRoleId; // custom is enabled when verified role set
        return { enabled, observed: { ok: true, at: Date.now(), detail: 'Custom verification (VG- code in Roblox bio)' }, pausedUntil: 0 };
    }
    constructor(store, logs) {
        this.store = store;
        this.logs = logs;
    }
    clearGuild(id) {
        this.http.clearPrefix(`${id}:`);
        // pending is guild-scoped and auto-pruned; nothing else to clear
    }
    /** Only previously linked members can be synchronized when they rejoin. */
    async syncOnJoin(member) {
        if (getLink(this.store, member.guild.id, member.id))
            await this.sync(member, { isInitial: true });
    }
    /** Sync a member's verified role + nickname + group ranks from their linked Roblox account. */
    async sync(member, opts = {}) {
        return this.queue.run(`${member.guild.id}:${member.id}`, async () => {
            this.store.assertAuthorized(member.guild.id);
            if (this.store.get('SELECT enabled FROM feature_settings WHERE guild_id=? AND feature=?', member.guild.id, 'verification')?.enabled === 0)
                throw new AppError('INTEGRATION_ERROR', 'Verification is disabled in this guild.');
            const s = this.store.settings(member.guild.id);
            if (!s.authorized)
                throw new AppError('INTEGRATION_ERROR', 'This server is not authorized.');
            if (this.store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', member.guild.id, member.id))
                throw new AppError('INTEGRATION_ERROR', 'Verification is unavailable while you are quarantined.');
            if (!s.verifiedRoleId)
                throw new AppError('INTEGRATION_ERROR', 'A security administrator must configure the verified role first (use `/setup security verified_role`).');
            const fresh = await member.guild.members.fetch({ user: member.id, force: true });
            const role = await member.guild.roles.fetch(s.verifiedRoleId);
            const roleHelp = 'Ask a security administrator to choose a safe, unmanaged role with `/setup security verified_role` and place it below the bot’s highest role.';
            if (!role)
                throw new AppError('INTEGRATION_ERROR', `The configured verified role no longer exists. ${roleHelp}`);
            if (role.managed)
                throw new AppError('INTEGRATION_ERROR', `The configured verified role is managed by an integration. ${roleHelp}`);
            if (!role.editable)
                throw new AppError('INTEGRATION_ERROR', `The bot cannot manage the verified role. Grant Manage Roles and check the role hierarchy. ${roleHelp}`);
            if (isBotPermissionRole(this.store, member.guild.id, role.id) || dangerous(role.permissions.bitfield))
                throw new AppError('INTEGRATION_ERROR', `The verified role grants moderation or administrative permissions. ${roleHelp}`);
            // Custom link lookup — no external provider
            const link = this.store.get('SELECT roblox_id, username FROM links WHERE guild_id=? AND user_id=?', member.guild.id, member.id);
            if (!link?.roblox_id) {
                // Check if they have a pending code not yet confirmed
                const pending = this.store.get('SELECT code, roblox_id FROM verification_pending WHERE guild_id=? AND user_id=?', member.guild.id, member.id);
                if (pending)
                    throw new AppError('INTEGRATION_ERROR', `You have a pending verification for **${pending.roblox_id ?? 'your account'}** with code \`${pending.code}\`. Add it to your Roblox profile About (https://www.roblox.com/users/${pending.roblox_id}/profile), save, then run \`/verify\` again or click **Verify now**.`);
                throw new AppError('INTEGRATION_ERROR', 'No linked Roblox account. Run `/verify username: YourRobloxName` to link your account.');
            }
            const robloxId = String(link.roblox_id);
            // Fetch Roblox profile (public API, no key)
            const response = await this.http.get(`${member.guild.id}:profile:${robloxId}`, `https://users.roblox.com/v1/users/${robloxId}`);
            if (!response.ok)
                throw new AppError('INTEGRATION_ERROR', `Roblox profile lookup failed (HTTP ${response.status}). Try again in a moment.`);
            const profile = await response.json();
            if (typeof profile.name !== 'string' || typeof profile.created !== 'string')
                throw new AppError('INTEGRATION_ERROR', 'Roblox returned an incomplete profile.');
            const age = ageDays(profile.created);
            const blocked = s.blockBanned && (profile.isBanned || blacklistEntry(this.store, member.guild.id, robloxId));
            this.store.assertAuthorized(member.guild.id);
            if (age < s.minAge || blocked) {
                if (fresh.roles.cache.has(role.id))
                    await fresh.roles.remove(role, 'Roblox verification policy failed');
                this.store.run('DELETE FROM links WHERE guild_id=? AND user_id=?', member.guild.id, member.id);
                this.logs.push(member.guild.id, embed('Roblox verification revoked', `<@${member.id}> (${profile.name}): ${blocked ? 'Roblox account is banned or blacklisted.' : `Account age is below minimum (${age} < ${s.minAge} days).`}`, Colors.Red));
                throw new AppError('INTEGRATION_ERROR', blocked ? 'This Roblox account is banned or is on this server’s Roblox blacklist.' : `Your Roblox account must be at least ${s.minAge} days old; it is ${age} days old.`);
            }
            if (!this.store.settings(member.guild.id).authorized || this.store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', member.guild.id, member.id))
                throw new AppError('INTEGRATION_ERROR', 'Verification was canceled because server authorization or quarantine status changed.');
            const checkedRole = await member.guild.roles.fetch(role.id, { force: true });
            if (!checkedRole || checkedRole.managed || !checkedRole.editable || isBotPermissionRole(this.store, member.guild.id, checkedRole.id) || dangerous(checkedRole.permissions.bitfield))
                throw new AppError('INTEGRATION_ERROR', 'The verified role became unsafe or unavailable during verification.');
            this.store.assertAuthorized(member.guild.id);
            const hadRole = fresh.roles.cache.has(checkedRole.id);
            let roleAdded = false;
            if (!hadRole) {
                await fresh.roles.add(checkedRole, 'Roblox account verified');
                roleAdded = true;
            }
            let nickname = '';
            let nicknameChanged = false;
            if (s.nickname && fresh.nickname !== profile.name) {
                if (fresh.manageable) {
                    this.store.assertAuthorized(member.guild.id);
                    try {
                        await fresh.setNickname(profile.name.slice(0, 32), 'Roblox nickname sync');
                        nicknameChanged = true;
                    }
                    catch {
                        nickname = ' Nickname update failed; check Manage Nicknames.';
                    }
                }
                else {
                    nickname = ' Nickname could not be changed because of role hierarchy.';
                }
            }
            this.store.run('INSERT INTO links VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET roblox_id=excluded.roblox_id,username=excluded.username,synced=excluded.synced', member.guild.id, member.id, robloxId, profile.name, Date.now());
            const ranks = await syncGroupRoles(this.store, fresh, robloxId).catch(() => '');
            const changed = roleAdded || nicknameChanged || Boolean(ranks);
            if (opts.silent) {
                // Background refresh: never log if nothing changed!
                if (changed) {
                    const details = [];
                    if (roleAdded)
                        details.push('verified role restored');
                    if (nicknameChanged)
                        details.push(`nickname synced to **${profile.name}**`);
                    if (ranks)
                        details.push(ranks.trim());
                    this.logs.push(member.guild.id, embed('Roblox sync update', `<@${member.id}> (${profile.name})${details.length ? ` · ${details.join(' · ')}` : ''}`, Colors.Blurple));
                }
            }
            else if (opts.isInitial || !hadRole) {
                this.logs.push(member.guild.id, embed('Roblox verification', `<@${member.id}> → **${profile.name}** (${robloxId})${nickname}${ranks}`, Colors.Green));
            }
            else if (changed) {
                this.logs.push(member.guild.id, embed('Roblox sync update', `<@${member.id}> (${profile.name})${nickname}${ranks}`, Colors.Blurple));
            }
            return `Verified as **${profile.name}** (${robloxId}).${nickname}${ranks}`;
        });
    }
    async refresh(client, permitted = id => this.store.isAuthorized(id)) {
        if (this.refreshing)
            return;
        this.refreshing = true;
        try {
            for (const row of this.store.all('SELECT * FROM links WHERE synced<? ORDER BY synced LIMIT 10', Date.now() - 15 * 60000)) {
                const guild = client.guilds.cache.get(row.guild_id);
                if (!guild || !permitted(guild.id) || !this.store.isAuthorized(guild.id))
                    continue;
                let member;
                try {
                    member = await memberOrNull(guild, row.user_id);
                }
                catch {
                    continue;
                }
                if (member) {
                    this.store.run('UPDATE links SET synced=? WHERE guild_id=? AND user_id=?', Date.now(), row.guild_id, row.user_id);
                    await this.store.withAuthorized(guild.id, () => this.sync(member, { silent: true })).catch(() => { });
                }
                else
                    this.store.run('DELETE FROM links WHERE guild_id=? AND user_id=?', row.guild_id, row.user_id);
            }
        }
        finally {
            this.refreshing = false;
        }
    }
    async identify(member) {
        const link = getLink(this.store, member.guild.id, member.id);
        return link ? link.roblox_id : null;
    }
    rememberBan(guildId, userId) {
        const row = this.store.get('SELECT roblox_id FROM links WHERE guild_id=? AND user_id=?', guildId, userId);
        const temporary = !!this.store.get('SELECT 1 FROM tempbans WHERE guild_id=? AND user_id=?', guildId, userId);
        if (row)
            temporary ? this.store.run('INSERT OR REPLACE INTO blocked_accounts VALUES(?,?,?)', guildId, row.roblox_id, `Linked Discord account banned: ${userId}`)
                : addToBlacklist(this.store, guildId, String(row.roblox_id), `Linked Discord account banned: ${userId}`, 'Banned member', userId);
    }
    // ---- Legacy stubs (so old callers don't crash) ----
    async discordIdsForRoblox(_guild, _robloxId) {
        // No reverse lookup without Bloxlink — return links we know
        return null;
    }
    async updateBloxlinkUser(_member) {
        throw new AppError('INTEGRATION_ERROR', 'Bloxlink sync is disabled — we now use custom verification (`/verify`). Ask users to re-verify with `/verify username: TheirName`.');
    }
}
