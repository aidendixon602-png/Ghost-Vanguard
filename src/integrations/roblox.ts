import { Colors, GuildMember } from 'discord.js';
import { config } from '../config.js';
import { ageDays, dangerous, decideLinks, KeyedQueue } from '../core.js';
import { addToBlacklist, blacklistEntry, syncGroupRoles } from '../features/roblox-tools.js';
import type { Store } from '../database/db.js';
import { AppError } from '../errors.js';
import { HttpReads } from './http.js';
import type { LogQueue } from '../logging.js';
import { embed, memberOrNull } from '../ui/ui.js';

type Lookup = {
    kind: 'found';
    id: string;
} | {
    kind: 'absent';
} | {
    kind: 'error';
    /** The provider rejected our API key for this server (HTTP 401/403). */
    rejected?: boolean;
};

export interface BloxlinkUpdateResult {
    addedRoles: string[];
    removedRoles: string[];
    nickname: string | null;
}

const PROVIDER_NAMES = { rover: 'RoVer', bloxlink: 'Bloxlink' } as const;
const KEY_SETTINGS = { rover: 'ROVER_API_KEY', bloxlink: 'BLOXLINK_API_KEY' } as const;
/** How long to stop calling a provider for one server after it rejects our key. */
const REJECTED_KEY_PAUSE_MS = 5 * 60 * 1000;

export class Roblox {
    private queue = new KeyedQueue();
    private http = new HttpReads();
    private refreshing = false;
    private providerCooldown = new Map<string, number>();

    private observations = new Map<string, { ok: boolean; at: number; detail: string }>();
    providerStatus(guild: string, provider: 'rover' | 'bloxlink') {
        const enabled = !!(provider === 'rover' ? config.roverKey : config.bloxlinkKey) && this.store.get('SELECT enabled FROM provider_config WHERE guild_id=? AND provider=?', guild, provider)?.enabled !== 0;
        return { enabled, observed: this.observations.get(`${provider}:${guild}`), pausedUntil: Math.max(this.providerCooldown.get(provider) ?? 0, this.providerCooldown.get(`${provider}:${guild}`) ?? 0) };
    }
    private observed(provider: 'rover' | 'bloxlink', guild: string, ok: boolean, detail: string) {
        if (!this.store.isAuthorized(guild)) return;
        const key = `${provider}:${guild}`, previous = this.observations.get(key);
        this.observations.set(key, { ok, at: Date.now(), detail });
        if (!ok && previous?.ok !== false || ok && previous?.ok === false)
            this.logs.push(guild, embed(ok ? 'Verification provider recovered' : 'Verification provider unavailable', `${PROVIDER_NAMES[provider]}: ${detail} Existing verification roles are preserved on provider errors.`, ok ? Colors.Green : Colors.Orange));
    }

    constructor(private store: Store, private logs: LogQueue) { }

    private async lookup(provider: 'rover' | 'bloxlink', guild: string, user: string): Promise<Lookup> {
        const key = provider === 'rover' ? config.roverKey : config.bloxlinkKey;
        const providerSettings = this.store.get('SELECT enabled FROM provider_config WHERE guild_id=? AND provider=?', guild, provider);
        if (!key || providerSettings?.enabled === 0)
            return { kind: 'error' };
        if ((this.providerCooldown.get(provider) ?? 0) > Date.now())
            return { kind: 'error' };
        if ((this.providerCooldown.get(`${provider}:${guild}`) ?? 0) > Date.now())
            return { kind: 'error', rejected: true };
        const url = provider === 'rover'
            ? `https://registry.rover.link/api/guilds/${guild}/discord-to-roblox/${user}`
            : `https://api.blox.link/v4/public/guilds/${guild}/discord-to-roblox/${user}`;
        try {
            this.store.assertAuthorized(guild);
            const response = await this.http.get(`${guild}:${provider}:${user}`, url, { Authorization: provider === 'rover' ? `Bearer ${key}` : key });
            if (response.status === 404) {
                this.observed(provider, guild, true, 'Provider responded; this member has no linked account.');
                return { kind: 'absent' };
            }
            if (response.status === 401 || response.status === 403) {
                this.observed(provider, guild, false, `HTTP ${response.status}; check ${KEY_SETTINGS[provider]} and server access.`);
                // Keys are tied to specific servers, so pause only this server and say what to check.
                this.providerCooldown.set(`${provider}:${guild}`, Date.now() + REJECTED_KEY_PAUSE_MS);
                console.warn(`[verification] ${PROVIDER_NAMES[provider]} rejected the API key for guild ${guild} (HTTP ${response.status}). `
                    + `Check ${KEY_SETTINGS[provider]} in .env and that the key has access to this server. `
                    + `Pausing ${PROVIDER_NAMES[provider]} lookups for this server for 5 minutes.`);
                return { kind: 'error', rejected: true };
            }
            if (!response.ok) {
                this.observed(provider, guild, false, `HTTP ${response.status}; retry after the provider pause.`);
                if (response.status === 429 || response.status >= 500)
                    this.providerCooldown.set(provider, Date.now() + 60000);
                console.warn(`[verification] ${provider} HTTP ${response.status}; credentials and response bodies omitted.`);
                return { kind: 'error' };
            }
            const data = await response.json() as {
                robloxId?: unknown;
                robloxID?: unknown;
            };
            const id = String(data.robloxId ?? data.robloxID ?? '');
            const valid = /^\d+$/.test(id) && id !== '0';
            this.observed(provider, guild, valid, valid ? 'Provider returned a linked account.' : 'Provider returned an incomplete account response.');
            return valid ? { kind: 'found', id } : { kind: 'error' };
        } catch {
            this.observed(provider, guild, false, 'Network/request failure; try again later.');
            return { kind: 'error' };
        }
    }

    /** Resolve a Roblox account to Discord members through Bloxlink; null means the lookup is unavailable. */
    async discordIdsForRoblox(guild: string, robloxId: string): Promise<string[] | null> {
        const key = config.bloxlinkKey;
        if (!key || this.store.get('SELECT enabled FROM provider_config WHERE guild_id=? AND provider=?', guild, 'bloxlink')?.enabled === 0)
            return null;
        if (!/^\d{1,20}$/.test(robloxId) || (this.providerCooldown.get('bloxlink') ?? 0) > Date.now() || (this.providerCooldown.get(`bloxlink:${guild}`) ?? 0) > Date.now())
            return null;
        try {
            this.store.assertAuthorized(guild);
            const response = await this.http.get(`${guild}:bloxlink:reverse:${robloxId}`,
                `https://api.blox.link/v4/public/guilds/${guild}/roblox-to-discord/${robloxId}`, { Authorization: key });
            if (response.status === 404) {
                this.observed('bloxlink', guild, true, 'Provider responded; no linked Discord accounts were found.');
                return [];
            }
            if (response.status === 401 || response.status === 403) {
                this.observed('bloxlink', guild, false, `HTTP ${response.status}; check BLOXLINK_API_KEY and server access.`);
                this.providerCooldown.set(`bloxlink:${guild}`, Date.now() + REJECTED_KEY_PAUSE_MS);
                console.warn(`[verification] Bloxlink rejected the API key for guild ${guild} (HTTP ${response.status}); check BLOXLINK_API_KEY and server access. Pausing lookups for 5 minutes.`);
                return null;
            }
            if (!response.ok) {
                this.observed('bloxlink', guild, false, `HTTP ${response.status}; retry after the provider pause.`);
                if (response.status === 429 || response.status >= 500) this.providerCooldown.set('bloxlink', Date.now() + 60000);
                console.warn(`[verification] Bloxlink reverse lookup HTTP ${response.status}; credentials and response bodies omitted.`);
                return null;
            }
            const data = await response.json() as { discordIDs?: unknown };
            if (!Array.isArray(data.discordIDs)) {
                this.observed('bloxlink', guild, false, 'Provider returned an incomplete reverse-lookup response.');
                return null;
            }
            const ids = [...new Set(data.discordIDs.map(String).filter(id => /^\d{17,20}$/.test(id)))];
            this.observed('bloxlink', guild, true, ids.length ? 'Provider returned linked Discord accounts.' : 'Provider returned no linked Discord accounts.');
            return ids;
        } catch {
            this.observed('bloxlink', guild, false, 'Network/request failure; try again later.');
            return null;
        }
    }

    /** Explicitly request Bloxlink to re-run its configured verification for a member. This is a non-retried POST. */
    async updateBloxlinkUser(member: GuildMember): Promise<BloxlinkUpdateResult> {
        const guild = member.guild.id;
        return this.queue.run(`${guild}:${member.id}`, async () => {
            this.store.assertAuthorized(guild);
            const key = config.bloxlinkKey;
            if (!key) throw new AppError('INTEGRATION_ERROR', 'Bloxlink is not configured. Set BLOXLINK_API_KEY in .env.');
            if (this.store.get('SELECT enabled FROM provider_config WHERE guild_id=? AND provider=?', guild, 'bloxlink')?.enabled === 0)
                throw new AppError('INTEGRATION_ERROR', 'Bloxlink verification is disabled in this server.');
            if (this.store.get('SELECT enabled FROM feature_settings WHERE guild_id=? AND feature=?', guild, 'verification')?.enabled === 0)
                throw new AppError('INTEGRATION_ERROR', 'Verification is disabled in this server.');
            if (this.store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', guild, member.id))
                throw new AppError('INTEGRATION_ERROR', 'Bloxlink updates are unavailable while this member is quarantined.');
            const paused = Math.max(this.providerCooldown.get('bloxlink') ?? 0, this.providerCooldown.get(`bloxlink:${guild}`) ?? 0);
            if (paused > Date.now()) throw new AppError('INTEGRATION_ERROR', 'Bloxlink requests are temporarily paused after a provider error. Try again later.');
            const fresh = await member.guild.members.fetch({ user: member.id, force: true }).catch(() => null);
            if (!fresh) throw new AppError('VALIDATION_ERROR', 'That member is no longer in this server.');
            this.store.assertAuthorized(guild);
            let response: Response;
            try {
                response = await fetch(`https://api.blox.link/v4/public/guilds/${guild}/update-user/${member.id}`, {
                    method: 'POST', headers: { Authorization: key }, signal: AbortSignal.timeout(10000),
                });
            } catch {
                this.observed('bloxlink', guild, false, 'Update request failed or timed out; check Bloxlink before retrying.');
                throw new AppError('INTEGRATION_ERROR', 'The Bloxlink update request failed or timed out. Check the member in Bloxlink before retrying.');
            }
            if (response.status === 401 || response.status === 403) {
                this.observed('bloxlink', guild, false, `HTTP ${response.status}; check BLOXLINK_API_KEY and server access.`);
                this.providerCooldown.set(`bloxlink:${guild}`, Date.now() + REJECTED_KEY_PAUSE_MS);
                console.warn(`[verification] Bloxlink rejected the API key for guild ${guild} (HTTP ${response.status}); check BLOXLINK_API_KEY and server access. Pausing requests for 5 minutes.`);
                throw new AppError('INTEGRATION_ERROR', 'Bloxlink rejected the API key for this server. Check BLOXLINK_API_KEY and its server access.');
            }
            if (response.status === 404) {
                this.observed('bloxlink', guild, true, 'Provider could not find a linked account or current server member.');
                throw new AppError('VALIDATION_ERROR', 'Bloxlink could not find a linked account for that member in this server.');
            }
            if (!response.ok) {
                this.observed('bloxlink', guild, false, `HTTP ${response.status}; retry after the provider pause.`);
                if (response.status === 429 || response.status >= 500) this.providerCooldown.set('bloxlink', Date.now() + 60000);
                console.warn(`[verification] Bloxlink update HTTP ${response.status}; credentials and response bodies omitted.`);
                throw new AppError('INTEGRATION_ERROR', `Bloxlink update failed (HTTP ${response.status}). Check Bloxlink before retrying.`);
            }
            const data = await response.json().catch(() => null) as Partial<BloxlinkUpdateResult> | null;
            if (!data || typeof data !== 'object') throw new AppError('INTEGRATION_ERROR', 'Bloxlink returned an unreadable update response. Check the member in Bloxlink.');
            this.store.assertAuthorized(guild);
            const roleNames = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean))].slice(0, 20) : [];
            this.observed('bloxlink', guild, true, 'Member update completed.');
            return { addedRoles: roleNames(data.addedRoles), removedRoles: roleNames(data.removedRoles), nickname: typeof data.nickname === 'string' ? data.nickname : null };
        });
    }

    clearGuild(id: string) {
        this.http.clearPrefix(`${id}:`);
        for (const provider of ['rover','bloxlink']) {this.observations.delete(`${provider}:${id}`);this.providerCooldown.delete(`${provider}:${id}`);}
    }

    async sync(member: GuildMember): Promise<string> {
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
                throw new AppError('INTEGRATION_ERROR', 'A security administrator must configure /security setup verified_role first.');
            const fresh = await member.guild.members.fetch({ user: member.id, force: true });
            const role = await member.guild.roles.fetch(s.verifiedRoleId);
            if (!role || role.managed || !role.editable || dangerous(role.permissions.bitfield))
                throw new AppError('INTEGRATION_ERROR', 'The verified role is missing, above the bot, managed, or grants moderation/administrative permissions.');
            const configured = (['rover', 'bloxlink'] as const).filter(p => (p === 'rover' ? config.roverKey : config.bloxlinkKey) && this.store.get('SELECT enabled FROM provider_config WHERE guild_id=? AND provider=?', member.guild.id, p)?.enabled !== 0);
            if (!configured.length)
                throw new AppError('INTEGRATION_ERROR', 'Set a RoVer or Bloxlink API key in .env first.');
            const lookups = await Promise.all(configured.map(p => this.lookup(p, member.guild.id, member.id)));
            const result = decideLinks(lookups);
            if (result.kind === 'unavailable') {
                const rejected = configured.filter((_, i) => lookups[i]!.kind === 'error' && (lookups[i] as {
                    rejected?: boolean;
                }).rejected);
                if (rejected.length)
                    throw new AppError('INTEGRATION_ERROR', `${rejected.map(p => PROVIDER_NAMES[p]).join(' and ')} rejected the bot's API key for this server. `
                        + 'Existing roles were preserved. A server admin should check the key in .env and its access in the provider dashboard.');
                throw new AppError('INTEGRATION_ERROR', 'Verification providers are unavailable or misconfigured. Existing roles were preserved; try again later.');
            }
            if (result.kind === 'conflict')
                throw new AppError('INTEGRATION_ERROR', 'RoVer and Bloxlink returned different Roblox accounts. Make both links agree, then retry.');
            this.store.assertAuthorized(member.guild.id);
            if (result.kind === 'absent') {
                if (s.revokeOnUnlink && fresh.roles.cache.has(role.id))
                    await fresh.roles.remove(role, 'Roblox account no longer linked');
                this.store.run('DELETE FROM links WHERE guild_id=? AND user_id=?', member.guild.id, member.id);
                return 'No linked Roblox account was found. Link through https://rover.link or https://blox.link, then run /verify again.';
            }
            this.store.assertAuthorized(member.guild.id);
            const response = await this.http.get(`${member.guild.id}:profile:${result.id}`, `https://users.roblox.com/v1/users/${result.id}`);
            if (!response.ok)
                throw new AppError('INTEGRATION_ERROR', `Roblox profile lookup failed (HTTP ${response.status}). Existing roles were preserved.`);
            const profile = await response.json() as {
                name: string;
                created: string;
                isBanned: boolean;
            };
            if (typeof profile.name !== 'string' || typeof profile.created !== 'string')
                throw new AppError('INTEGRATION_ERROR', 'Roblox returned an incomplete profile.');
            const age = ageDays(profile.created);
            const blocked = s.blockBanned && (profile.isBanned || blacklistEntry(this.store, member.guild.id, String(result.id)));
            this.store.assertAuthorized(member.guild.id);
            if (age < s.minAge || blocked) {
                if (fresh.roles.cache.has(role.id))
                    await fresh.roles.remove(role, 'Roblox verification policy failed');
                this.store.run('DELETE FROM links WHERE guild_id=? AND user_id=?', member.guild.id, member.id);
                throw new AppError('INTEGRATION_ERROR', blocked ? 'This Roblox account is banned or is on this server’s recorded Roblox blacklist.' : `Your Roblox account must be at least ${s.minAge} days old; it is ${age} days old.`);
            }
            if (!this.store.settings(member.guild.id).authorized || this.store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', member.guild.id, member.id))
                throw new AppError('INTEGRATION_ERROR', 'Verification was canceled because server authorization or quarantine status changed.');
            const checkedRole = await member.guild.roles.fetch(role.id, { force: true });
            if (!checkedRole || !checkedRole.editable || dangerous(checkedRole.permissions.bitfield))
                throw new AppError('INTEGRATION_ERROR', 'The verified role became unsafe or unavailable during verification.');
            this.store.assertAuthorized(member.guild.id);
            await fresh.roles.add(checkedRole, 'Roblox account verified');
            let nickname = '';
            if (s.nickname && fresh.nickname !== profile.name) {
                if (fresh.manageable) {
                    this.store.assertAuthorized(member.guild.id);
                    try {
                        await fresh.setNickname(profile.name.slice(0, 32), 'Roblox nickname sync');
                    } catch {
                        nickname = ' Nickname update failed; check Manage Nicknames.';
                    }
                } else
                    nickname = ' Nickname could not be changed because of role hierarchy.';
            }
            this.store.run('INSERT INTO links VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET roblox_id=excluded.roblox_id,username=excluded.username,synced=excluded.synced', member.guild.id, member.id, result.id, profile.name, Date.now());
            const ranks = await syncGroupRoles(this.store, fresh, String(result.id)).catch(() => '');
            this.logs.push(member.guild.id, embed('Roblox verification', `<@${member.id}> → **${profile.name}** (${result.id})${nickname}${ranks}`, Colors.Green));
            return `Verified as **${profile.name}** (${result.id}).${nickname}${ranks}`;
        });
    }

    async refresh(client: import('discord.js').Client, permitted: (id: string) => boolean = id => this.store.isAuthorized(id)) {
        if (this.refreshing)
            return;
        this.refreshing = true;
        try {
            for (const row of this.store.all('SELECT * FROM links WHERE synced<? ORDER BY synced LIMIT 10', Date.now() - 15 * 60000)) {
                const guild = client.guilds.cache.get(row.guild_id);
                if (!guild || !permitted(guild.id) || !this.store.isAuthorized(guild.id))
                    continue;
                let member: GuildMember | null;
                try {
                    member = await memberOrNull(guild, row.user_id);
                } catch {
                    continue;
                }
                if (member) {
                    this.store.run('UPDATE links SET synced=? WHERE guild_id=? AND user_id=?', Date.now(), row.guild_id, row.user_id);
                    await this.store.withAuthorized(guild.id, () => this.sync(member!)).catch(() => { });
                } else
                    this.store.run('DELETE FROM links WHERE guild_id=? AND user_id=?', row.guild_id, row.user_id);
            }
        } finally {
            this.refreshing = false;
        }
    }

    /**
     * The Roblox account linked to this Discord member, looked up through RoVer/Bloxlink without
     * changing any roles. Null when no provider is set up, nothing is linked or the providers disagree.
     */
    async identify(member: GuildMember): Promise<string | null> {
        const configured = (['rover', 'bloxlink'] as const).filter(p => (p === 'rover' ? config.roverKey : config.bloxlinkKey) && this.store.get('SELECT enabled FROM provider_config WHERE guild_id=? AND provider=?', member.guild.id, p)?.enabled !== 0);
        if (!configured.length) return null;
        const result = decideLinks(await Promise.all(configured.map(p => this.lookup(p, member.guild.id, member.id))));
        return result.kind === 'found' ? String(result.id) : null;
    }

    rememberBan(guildId: string, userId: string) {
        const row = this.store.get('SELECT roblox_id FROM links WHERE guild_id=? AND user_id=?', guildId, userId);
        // A temporary ban stays local: partners should not inherit a ban that ends by itself.
        const temporary = !!this.store.get('SELECT 1 FROM tempbans WHERE guild_id=? AND user_id=?', guildId, userId);
        if (row)
            temporary ? this.store.run('INSERT OR REPLACE INTO blocked_accounts VALUES(?,?,?)', guildId, row.roblox_id, `Linked Discord account banned: ${userId}`)
                : addToBlacklist(this.store, guildId, String(row.roblox_id), `Linked Discord account banned: ${userId}`, 'Banned member', userId);
    }
}
