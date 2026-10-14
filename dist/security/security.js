import { consumeApprovedRoleChange } from './role-authorizations.js';
import { ActionRowBuilder, AuditLogEvent, PermissionFlagsBits, ButtonBuilder, ButtonStyle, Colors } from 'discord.js';
import { dangerous, escalationAdded, KeyedQueue, overrideRule, ruleFor, RULES, WARN_FIRST, WARNING_MEMORY_MS, KNOWN_ROLE_BOTS } from '../core.js';
import { developers } from '../bot/developers.js';
import { autoRaid } from '../features/antinuke-plus.js';
import { AppError } from '../errors.js';
import { embed, memberOrNull } from '../ui/ui.js';
import { incidentCard } from '../ui/incident-card.js';
/** How far back an incident alert looks for channels and roles the actor deleted. */
const DELETION_LOOKBACK_MS = 10 * 60 * 1000;
const ruleByKey = (key) => RULES.find(r => r.key === key);
const changesOf = (entry) => (entry.changes ?? []);
/** Roles added to a member by this entry that carry escalation permissions. */
/** Administrator and Manage Server: still checked for whitelisted role managers (Manage Server can add bots). */
const ALWAYS_STRICT = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild;
/** Escalation permissions a member role grant really adds: what the new roles give that the member's other roles did not. */
function memberEscalation(entry, guild) {
    if (entry.action !== AuditLogEvent.MemberRoleUpdate)
        return { roles: [], bits: 0n };
    const added = (changesOf(entry).find(c => c.key === '$add')?.new ?? []).map(r => r.id);
    const member = entry.targetId ? guild.members?.cache?.get(entry.targetId) : undefined;
    let before = 0n;
    for (const [id, role] of member?.roles?.cache ?? [])
        if (!added.includes(String(id)))
            before |= toBigInt(role?.permissions?.bitfield ?? guild.roles?.cache?.get(String(id))?.permissions?.bitfield);
    let bits = 0n;
    const roles = [];
    for (const id of added) {
        const role = guild.roles?.cache?.get(id);
        if (!role || role.managed)
            continue;
        const gain = escalationAdded(before, role.permissions.bitfield);
        if (gain !== 0n) {
            roles.push(id);
            bits |= gain;
        }
    }
    return { roles, bits };
}
function escalatingRolesAdded(entry, guild) {
    return memberEscalation(entry, guild).roles;
}
function toBigInt(value) {
    try {
        return value === undefined || value === null ? 0n : BigInt(value);
    }
    catch {
        return 0n;
    }
}
/** Escalation permissions this entry hands out: a role gaining them, a new role created with them, or a member given a role with them. */
function escalationBits(entry, guild) {
    if (entry.action === AuditLogEvent.RoleUpdate) {
        const change = changesOf(entry).find(c => c.key === 'permissions');
        return change ? escalationAdded(change.old, change.new) : 0n;
    }
    if (entry.action === AuditLogEvent.RoleCreate) {
        const change = changesOf(entry).find(c => c.key === 'permissions');
        return change ? escalationAdded(0n, change.new) : 0n;
    }
    return memberEscalation(entry, guild).bits;
}
/**
 * Who an audit entry should be counted against. Bans and kicks done through /mod are
 * executed by the bot, which is otherwise exempt, but the bot records the moderator's ID at the
 * start of the reason ("<id>: <reason>"). Counting those against the moderator stops a
 * compromised moderator from mass-banning through the bot. The bot's own restores and
 * containment use other reason text and stay exempt.
 */
export function responsibleActor(entry, guild) {
    const executor = entry.executorId;
    // Every action Vanguard performs for a staff member (/mod, /mod role, /security slowmode, /mod nick, /mod massban...)
    // starts its audit reason with "<staff ID>: ", so it counts against that person, never the exempt bot.
    if (executor && executor === guild.client.user?.id)
        return /^(\d{17,20}): /.exec(entry.reason ?? '')?.[1] ?? executor;
    return executor;
}
/** An AutoMod rule was switched off (deletions are matched by the rule's audit action). */
function disablesAutoMod(entry) {
    return entry.action === AuditLogEvent.AutoModerationRuleUpdate
        && changesOf(entry).some(c => c.key === 'enabled' && c.old === true && c.new === false);
}
export class Security {
    store;
    logs;
    queue = new KeyedQueue();
    constructor(store, logs) {
        this.store = store;
        this.logs = logs;
    }
    trusted(guild, id, ignoreRoles = []) {
        return id === guild.ownerId || id === guild.client.user?.id || developers.has(id) || this.store.hasGrant(guild.id, id, 'trust') || [...(guild.members?.cache?.get(id)?.roles.cache.keys() ?? [])].some(role => !ignoreRoles.includes(role) && this.store.hasGrant(guild.id, role, 'trust_role'));
    }
    /** Rule-only whitelist: the user (kind "trust:<rule>") or one of their roles ("trust_role:<rule>") skips just that rule. */
    trustedFor(guild, id, rule, ignoreRoles = []) {
        return this.store.hasGrant(guild.id, id, `trust:${rule}`) || [...(guild.members?.cache?.get(id)?.roles.cache.keys() ?? [])].some(role => !ignoreRoles.includes(role) && this.store.hasGrant(guild.id, role, `trust_role:${rule}`));
    }
    async audit(entry, guild) {
        return this.queue.run(guild.id, async () => {
            const s = this.store.settings(guild.id);
            // A change approved through /role (this exact member, role and operation, made by Vanguard) is not an attack.
            if (consumeApprovedRoleChange(entry, guild))
                return;
            const actor = responsibleActor(entry, guild);
            if (actor && this.store.get("SELECT 1 FROM grants WHERE guild_id=? AND (kind='trust_role' OR kind LIKE 'trust_role:%') AND (expires IS NULL OR expires>?)", guild.id, Date.now()))
                await memberOrNull(guild, actor).catch(() => null);
            const newlyAssigned = entry.action === AuditLogEvent.MemberRoleUpdate && entry.targetId === actor ? (changesOf(entry).find(c => c.key === '$add')?.new ?? []).map((r) => r.id) : [];
            if (!s.authorized || !actor || this.trusted(guild, actor, newlyAssigned))
                return;
            if (entry.action === AuditLogEvent.MemberRoleUpdate && entry.targetId && entry.targetId !== actor)
                await memberOrNull(guild, entry.targetId).catch(() => null);
            for (const { rule, eventId } of this.rulesFor(entry, guild, actor, newlyAssigned))
                // A role the actor just gave themselves cannot exempt that same action.
                if (!this.trustedFor(guild, actor, rule.key, newlyAssigned))
                    await this.evaluate(entry, guild, actor, rule, eventId);
        });
    }
    /** Every rule this audit entry counts toward, each with its own observation id. */
    rulesFor(entry, guild, actor, newlyAssigned = []) {
        const found = [];
        const primary = ruleFor(entry.action);
        // The verification bot exemption covers ordinary member-role updates only, never dangerous grants.
        const verificationBot = entry.action === AuditLogEvent.MemberRoleUpdate && (this.store.hasGrant(guild.id, actor, 'bot') || (actor in KNOWN_ROLE_BOTS && !this.store.hasGrant(guild.id, actor, 'bot_denied')));
        const addsRole = entry.action !== AuditLogEvent.MemberRoleUpdate || changesOf(entry).some(c => c.key === '$add' && c.new?.length);
        if (primary && !verificationBot && addsRole)
            found.push({ rule: primary, eventId: entry.id });
        let escalation = escalationBits(entry, guild);
        // Staff whitelisted to manage roles can hand out moderator-level roles (ban, kick, channels, webhooks);
        // Administrator and Manage Server are still checked for everyone without a full bypass.
        const roleRule = entry.action === AuditLogEvent.MemberRoleUpdate ? 'role_grant' : entry.action === AuditLogEvent.RoleCreate ? 'role_create' : 'role_update';
        if (escalation && this.trustedFor(guild, actor, roleRule, newlyAssigned))
            escalation &= ALWAYS_STRICT;
        if (escalation)
            found.push({ rule: ruleByKey('dangerous_grant'), eventId: `${entry.id}:dangerous_grant` });
        if (disablesAutoMod(entry))
            found.push({ rule: ruleByKey('automod_tamper'), eventId: `${entry.id}:automod_tamper` });
        if (entry.action === AuditLogEvent.MemberUpdate && changesOf(entry).some(c => c.key === 'communication_disabled_until' && c.new && Date.parse(String(c.new)) > Date.now()))
            found.push({ rule: ruleByKey('timeout'), eventId: `${entry.id}:timeout` });
        return found;
    }
    async evaluate(entry, guild, actor, rule, eventId) {
        const s = this.store.settings(guild.id);
        const now = Date.now();
        const at = entry.createdTimestamp;
        const active = overrideRule(rule, s.rules, s.ruleDefaults);
        if (active.enabled === false)
            return;
        if (!this.store.observe(eventId, guild.id, actor, rule.key, entry.targetId, at))
            return;
        this.store.run('INSERT INTO antinuke_event_payloads(guild_id,id,json) VALUES(?,?,?)', guild.id, eventId, JSON.stringify({ id: entry.id, action: entry.action, targetId: entry.targetId, changes: changesOf(entry) }));
        if (!s.enabled || now - at > 120000 || at > now + 10000)
            return;
        const count = this.store.count(guild.id, actor, rule.key, now - active.seconds * 1000);
        if (count < active.count)
            return;
        if (this.store.get("SELECT 1 FROM incidents WHERE guild_id=? AND actor_id=? AND rule=? AND at>? AND mode<>'warn'", guild.id, actor, rule.key, now - active.seconds * 1000))
            return;
        // Everyday rules warn first (people, not bots); a second offence within the hour gets the real punishment.
        const warnOnly = s.mode === 'enforce' && WARN_FIRST.has(rule.key)
            && !this.store.get("SELECT 1 FROM incidents WHERE guild_id=? AND actor_id=? AND mode='warn' AND at>?", guild.id, actor, now - WARNING_MEMORY_MS)
            && !(await memberOrNull(guild, actor).catch(() => null))?.user?.bot;
        // Write evidence before trying any Discord mutation.
        const incident = this.store.incident(guild.id, actor, rule.key, warnOnly ? 'warn' : s.mode, 'Pending');
        let result = 'Observed only; no Discord actions taken.';
        const progress = { completed: 0, failed: 0, skipped: 0 };
        if (s.mode === 'enforce') {
            if (warnOnly) {
                result = 'Warning: no roles were removed. Doing this again within an hour gets the normal punishment.';
                void this.warnActor(guild, actor, active.title);
            }
            else
                try {
                    const ignoreRoles = entry.action === AuditLogEvent.MemberRoleUpdate && entry.targetId === actor ? (changesOf(entry).find(c => c.key === '$add')?.new ?? []).map((r) => r.id) : [];
                    result = await this.punish(guild, actor, active.punishment ?? 'strip', ignoreRoles);
                }
                catch {
                    result = 'Containment failed. Check role hierarchy and Manage Roles.';
                }
            if (active.revert) {
                const events = this.store.all('SELECT p.json FROM antinuke_event_payloads p JOIN observations o ON o.id=p.id AND o.guild_id=p.guild_id WHERE o.guild_id=? AND o.actor_id=? AND o.rule=? AND o.at>=? ORDER BY o.at DESC', guild.id, actor, rule.key, now - active.seconds * 1000);
                let processed = 0;
                for (const event of events) {
                    try {
                        const detail = await this.revert(JSON.parse(event.json), guild, active);
                        const outcome = /kept|skipped|absent|protected|No automatic|no roles|Removed 0 /i.test(detail) ? 'skipped' : /^(Removed|Banned|Deleted|Restored) /i.test(detail) ? 'completed' : 'failed';
                        progress[outcome]++;
                        result += ` [${outcome}] ${detail}`;
                    }
                    catch {
                        progress.failed++;
                        result += ' [failed] Revert failed; check bot permissions and role hierarchy.';
                    }
                    this.store.run('UPDATE incidents SET result=? WHERE guild_id=? AND id=?', `${result} Reverts: ${progress.completed} completed, ${progress.failed} failed, ${progress.skipped} skipped.`, guild.id, incident);
                    processed++;
                    if (events.length > 5 && (processed === 1 || processed % 10 === 0))
                        this.logs.push(guild.id, embed(`Incident #${incident} · Revert progress`, `${processed}/${events.length} reviewed · ${progress.completed} completed · ${progress.failed} failed · ${progress.skipped} skipped`, Colors.Orange));
                }
            }
        }
        result += ` Reverts: ${progress.completed} completed, ${progress.failed} failed, ${progress.skipped} skipped.`;
        this.store.run('UPDATE incidents SET result=? WHERE guild_id=? AND id=?', result, guild.id, incident);
        const deleted = this.recentDeletions(guild.id, actor, now);
        const buttons = [];
        // A strip that removed roles can be undone in one click if it was a false alarm (owner and developers only).
        if (s.mode === 'enforce' && (active.punishment ?? 'strip') === 'strip' && /^Removed [1-9]\d* dangerous role/.test(result))
            buttons.push(new ButtonBuilder().setCustomId(`incident:undo:${incident}`).setLabel('Undo strip').setEmoji('↩️').setStyle(ButtonStyle.Success));
        if (deleted.channels || deleted.roles)
            buttons.push(new ButtonBuilder().setCustomId(`incident:restore:${incident}`).setLabel('Review restore').setStyle(ButtonStyle.Secondary));
        const rows = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];
        this.logs.push(guild.id, incidentCard({ incident, actor, rule: active, mode: warnOnly ? 'warn' : s.mode, count, result, progress, deleted, targetId: entry.targetId ?? null }), rows);
    }
    /** Tell someone privately that anti-nuke warned them, so a staff member doing normal work knows to slow down or ask for a whitelist. */
    async warnActor(guild, actor, what) {
        try {
            const member = await memberOrNull(guild, actor);
            if (!member || member.user?.bot)
                return false;
            await member.send({ embeds: [embed('⚠️ Anti-nuke warning', [
                        `In **${guild.name ?? 'the server'}**, you triggered anti-nuke (**${what}**) by doing it too many times too quickly, so the change was undone.`,
                        '',
                        '**Nothing else happened this time.** If it happens again within the next hour, your staff roles will be removed.',
                        'If this is part of your job, ask the server owner to add you with `/antinuke whitelist add`.',
                    ].join('\n'), Colors.Yellow)] });
            return true;
        }
        catch {
            return false;
        }
    }
    async punish(guild, actor, action, ignoreRoles = []) {
        this.store.assertAuthorized(guild.id);
        if (this.trusted(guild, actor, ignoreRoles))
            return 'Protected executor; no action taken.';
        if (action === 'strip')
            return this.contain(guild, actor, true, ignoreRoles);
        const member = await memberOrNull(guild, actor);
        if (!member || !(action === 'ban' ? member.bannable : member.kickable))
            return 'Executor cannot be ' + (action === 'ban' ? 'banned' : 'kicked') + '; check membership, permissions and role hierarchy.';
        this.store.assertAuthorized(guild.id);
        if (action === 'ban')
            await member.ban({ reason: 'Midtown Vanguard: anti-nuke rule triggered', deleteMessageSeconds: 0 });
        else
            await member.kick('Midtown Vanguard: anti-nuke rule triggered');
        return action === 'ban' ? 'Banned the executor.' : 'Kicked the executor.';
    }
    async revert(entry, guild, rule) {
        this.store.assertAuthorized(guild.id);
        const id = entry.targetId;
        if (!id)
            return 'Revert target is unavailable.';
        if (rule.key === 'dangerous_grant')
            return this.revertGrant(entry, guild);
        if (rule.key === 'mass_ban') {
            await guild.bans.remove(id, 'Midtown Vanguard: revert anti-nuke bans');
            return 'Removed ban for ' + id + '.';
        }
        if (rule.key === 'bot_add') {
            if (this.trusted(guild, id))
                return 'Added bot is trusted; kept it.';
            const member = await memberOrNull(guild, id);
            if (!member?.user.bot || !member.bannable)
                return 'Added bot cannot be removed; check role hierarchy.';
            this.store.assertAuthorized(guild.id);
            await member.ban({ reason: 'Midtown Vanguard: revert unauthorized bot addition', deleteMessageSeconds: 0 });
            return 'Banned the added bot.';
        }
        if (rule.key === 'channel_create') {
            const channel = await guild.channels.fetch(id);
            if (!channel)
                return 'Created channel is already absent.';
            this.store.assertAuthorized(guild.id);
            await channel.delete('Midtown Vanguard: revert channel creation');
            return 'Deleted created channel ' + id + '.';
        }
        if (rule.key === 'role_create') {
            const role = await guild.roles.fetch(id);
            if (!role)
                return 'Created role is already absent.';
            if (role.managed || !role.editable)
                return 'Created role is managed or above Vanguard; kept it.';
            this.store.assertAuthorized(guild.id);
            await role.delete('Midtown Vanguard: revert role creation');
            return 'Deleted created role ' + id + '.';
        }
        if (rule.key === 'role_grant') {
            const target = await memberOrNull(guild, id);
            const added = changesOf(entry).find(c => c.key === '$add')?.new ?? [];
            if (!target || this.trusted(guild, id, added.map((r) => r.id)))
                return 'Role recipient is absent or protected; no roles changed.';
            const ids = added.map((r) => r.id).filter((id) => guild.roles.cache.get(id)?.editable && !guild.roles.cache.get(id)?.managed && target.roles.cache.has(id));
            this.store.assertAuthorized(guild.id);
            if (ids.length)
                await target.roles.remove(ids, 'Midtown Vanguard: revert role assignment');
            return 'Removed ' + ids.length + ' assigned role(s).';
        }
        if (rule.key === 'timeout') {
            const target = await memberOrNull(guild, id);
            const change = changesOf(entry).find(c => c.key === 'communication_disabled_until');
            if (!target || !target.moderatable || target.communicationDisabledUntilTimestamp !== Date.parse(String(change?.new)))
                return 'Timeout has changed or cannot be managed; kept current state.';
            const old = change?.old ? Date.parse(String(change.old)) : NaN;
            this.store.assertAuthorized(guild.id);
            await target.disableCommunicationUntil(Number.isFinite(old) && old > Date.now() ? old : null, 'Midtown Vanguard: revert unauthorized timeout');
            return 'Restored previous timeout for ' + id + '.';
        }
        if (rule.key === 'webhook_change') {
            if (entry.action !== AuditLogEvent.WebhookCreate)
                return 'Webhook edit/deletion cannot be exactly undone without its previous credentials; manual review required.';
            const hooks = await guild.fetchWebhooks();
            const hook = hooks.get(id);
            if (!hook)
                return 'Created webhook is already absent.';
            this.store.assertAuthorized(guild.id);
            await hook.delete('Midtown Vanguard: revert webhook creation');
            return 'Deleted created webhook ' + id + '.';
        }
        return 'No automatic revert available for this event.';
    }
    /** Channels and roles this actor deleted recently, from recorded audit events. */
    recentDeletions(guildId, actor, now = Date.now()) {
        const rows = this.store.all("SELECT rule, COUNT(*) AS n FROM observations WHERE guild_id=? AND actor_id=? AND rule IN ('channel_delete','role_delete') AND at>=? GROUP BY rule", guildId, actor, now - DELETION_LOOKBACK_MS);
        const count = (key) => Number(rows.find(r => r.rule === key)?.n ?? 0);
        return { channels: count('channel_delete'), roles: count('role_delete') };
    }
    /** Undo the grant behind a dangerous_grant incident: strip the new permissions from the role, or the new roles from the member. */
    async revertGrant(entry, guild) {
        this.store.assertAuthorized(guild.id);
        if (entry.action === AuditLogEvent.RoleCreate) {
            const role = entry.targetId ? await guild.roles.fetch(entry.targetId).catch(() => null) : null;
            if (!role)
                return 'The new role is already gone.';
            if (role.managed || !role.editable)
                return 'The new role is managed or above Vanguard; kept it.';
            this.store.assertAuthorized(guild.id);
            await role.delete('Midtown Vanguard: new role created with dangerous permissions');
            return `Deleted the new role ${role.name}, which was created with dangerous permissions.`;
        }
        if (entry.action === AuditLogEvent.RoleUpdate) {
            const change = changesOf(entry).find(c => c.key === 'permissions');
            const role = entry.targetId ? await guild.roles.fetch(entry.targetId).catch(() => null) : null;
            if (!role || role.managed || !role.editable)
                return 'The permission grant could not be undone (role missing, managed, or above Vanguard).';
            const added = escalationAdded(change?.old, change?.new);
            this.store.assertAuthorized(guild.id);
            await role.setPermissions(role.permissions.bitfield & ~added, 'Midtown Vanguard: undo dangerous permission grant');
            return `Removed the newly granted permissions from role ${role.name}.`;
        }
        const roles = escalatingRolesAdded(entry, guild);
        const target = entry.targetId ? await memberOrNull(guild, entry.targetId) : null;
        if (!target || !roles.length)
            return 'The role grant could not be undone (member no longer present).';
        if (this.trusted(guild, target.id, (changesOf(entry).find(c => c.key === '$add')?.new ?? []).map((r) => r.id)))
            return 'The recipient is protected; the granted roles were kept.';
        const removable = roles.filter(id => guild.roles.cache.get(id)?.editable);
        if (!removable.length)
            return 'The granted roles are above Vanguard and could not be removed.';
        this.store.assertAuthorized(guild.id);
        await target.roles.remove(removable, 'Midtown Vanguard: undo dangerous role grant');
        return `Removed ${removable.length} newly granted role(s) from <@${target.id}>.`;
    }
    async join(member) {
        return this.queue.run(member.guild.id, async () => {
            const s = this.store.settings(member.guild.id);
            if (!s.authorized || !s.enabled)
                return;
            const rule = overrideRule(RULES.find(r => r.key === 'join_flood'), s.rules, s.ruleDefaults);
            if (rule.enabled === false)
                return;
            const now = Date.now();
            if (!this.store.observe(`join:${member.guild.id}:${member.id}:${member.joinedTimestamp}`, member.guild.id, 'joins', rule.key, member.id, now))
                return;
            const count = this.store.count(member.guild.id, 'joins', rule.key, now - rule.seconds * 1000);
            if (count < rule.count || this.store.get('SELECT 1 FROM incidents WHERE guild_id=? AND actor_id=? AND rule=? AND at>?', member.guild.id, 'joins', rule.key, now - rule.seconds * 1000))
                return;
            const raid = autoRaid(this.store, member.guild.id, now);
            const id = this.store.incident(member.guild.id, 'joins', rule.key, s.mode, `Join flood. ${raid}`);
            this.logs.push(member.guild.id, embed(`Incident #${id} · Join flood`, `${count} joins in ${rule.seconds}s.\n${raid}`, Colors.Orange));
        });
    }
    async contain(guild, userId, fromIncident = false, ignoreRoles = []) {
        this.store.assertAuthorized(guild.id);
        if (this.trusted(guild, userId, ignoreRoles))
            return 'Protected executor; not contained.';
        const member = await memberOrNull(guild, userId);
        const me = await guild.members.fetchMe();
        if (!member)
            return 'Executor is no longer a member; no roles changed.';
        // Optional: during an automatic incident, remove an offending bot outright instead of stripping its roles.
        if (fromIncident && member.user?.bot && this.store.kickBots(guild.id) && member.kickable) {
            this.store.assertAuthorized(guild.id);
            await member.kick('Midtown Vanguard containment: bot triggered anti-nuke');
            return 'Removed the bot from the server (bot containment is set to kick).';
        }
        if (!member.manageable)
            return 'Executor is above the bot or cannot be managed; containment unavailable.';
        this.store.assertAuthorized(guild.id);
        await guild.roles.fetch();
        const current = member.roles.cache.filter(r => r.id !== guild.id && !r.managed).map(r => r.id);
        const old = this.store.get('SELECT * FROM backups WHERE guild_id=? AND user_id=?', guild.id, userId);
        const saved = [...new Set([...current, ...(old ? JSON.parse(old.roles) : [])])];
        this.store.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1) ON CONFLICT(guild_id,user_id) DO UPDATE SET roles=excluded.roles,active=1', guild.id, userId, JSON.stringify(saved), Date.now());
        const removable = member.roles.cache.filter(r => r.id !== guild.id && !r.managed && dangerous(r.permissions.bitfield) && me.roles.highest.comparePositionTo(r) > 0);
        this.store.assertAuthorized(guild.id);
        if (removable.size)
            await member.roles.remove([...removable.keys()], 'Midtown Vanguard containment');
        const qId = this.store.settings(guild.id).quarantineRoleId;
        const q = qId ? guild.roles.cache.get(qId) : null;
        this.store.assertAuthorized(guild.id);
        if (q && !q.managed && !dangerous(q.permissions.bitfield) && q.editable)
            await member.roles.add(q, 'Midtown Vanguard quarantine');
        const fresh = await guild.members.fetch({ user: userId, force: true });
        const remaining = dangerous(fresh.permissions.bitfield);
        return `Removed ${removable.size} dangerous role(s). ${remaining ? 'Dangerous guild permissions remain; containment is incomplete.' : 'No dangerous guild permissions remain.'} Channel-specific overwrites and managed roles may still grant access.`;
    }
    async reconcile(member) {
        if (!this.store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', member.guild.id, member.id))
            return;
        const s = this.store.settings(member.guild.id);
        if (!s.authorized || !s.enabled || s.mode !== 'enforce')
            return;
        if (!member.roles.cache.some(r => !r.managed && r.id !== member.guild.id && dangerous(r.permissions.bitfield)))
            return;
        await this.queue.run(member.guild.id, async () => {
            // A trusted person (owner, developer, whitelisted admin) handing a quarantined member a staff role
            // on purpose is a release decision, not something to undo.
            const by = await this.grantedByTrusted(member);
            if (by) {
                this.store.run('UPDATE backups SET active=0 WHERE guild_id=? AND user_id=?', member.guild.id, member.id);
                const q = this.store.settings(member.guild.id).quarantineRoleId;
                if (q && member.roles.cache.has(q))
                    await member.roles.remove(q, `Midtown Vanguard: quarantine lifted by ${by}`).catch(() => null);
                this.logs.push(member.guild.id, embed('Quarantine lifted', `<@${by}> gave <@${member.id}> a staff role, so Vanguard ended their quarantine instead of removing it.\nTo quarantine them again use \`/security quarantine\`.`, Colors.Green));
                return;
            }
            const result = await this.contain(member.guild, member.id);
            if (/^Removed [1-9]/.test(result))
                this.logs.push(member.guild.id, embed('Quarantine still active', `<@${member.id}> is quarantined from an earlier anti-nuke incident, so Vanguard removed the staff role they were given. ${result}\nTo let them keep staff roles, use \`/security release\` (or have a whitelisted admin give the role).`, Colors.Orange));
        });
    }
    /** The trusted person who just added roles to this member, if the latest audit entry shows one. */
    async grantedByTrusted(member) {
        const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 10 }).catch(() => null);
        const entry = logs?.entries.find(e => e.targetId === member.id && Date.now() - e.createdTimestamp < 30_000 && changesOf(e).some(c => c.key === '$add' && c.new?.length));
        if (!entry)
            return null;
        const actor = responsibleActor(entry, member.guild);
        if (!actor || actor === member.id || actor === member.guild.client.user?.id)
            return null;
        return this.trusted(member.guild, actor) ? actor : null;
    }
    async release(guild, userId, privileged) {
        this.store.assertAuthorized(guild.id);
        const row = this.store.get('SELECT * FROM backups WHERE guild_id=? AND user_id=?', guild.id, userId);
        if (!row)
            throw new AppError('VALIDATION_ERROR', 'No role backup exists for this user.');
        const member = await guild.members.fetch({ user: userId, force: true });
        this.store.assertAuthorized(guild.id);
        await guild.roles.fetch();
        const restored = [], skipped = [];
        for (const id of JSON.parse(row.roles)) {
            const role = guild.roles.cache.get(id);
            if (!role || role.managed || !role.editable || (!privileged && dangerous(role.permissions.bitfield))) {
                skipped.push(id);
                continue;
            }
            restored.push(id);
        }
        // Stop persistent quarantine enforcement before restoring roles. Failed operations retain the backup.
        this.store.run('UPDATE backups SET active=0 WHERE guild_id=? AND user_id=?', guild.id, userId);
        this.store.assertAuthorized(guild.id);
        if (restored.length)
            await member.roles.add(restored, 'Midtown Vanguard authorized role restoration');
        const q = this.store.settings(guild.id).quarantineRoleId;
        this.store.assertAuthorized(guild.id);
        this.store.assertAuthorized(guild.id);
        if (q && member.roles.cache.has(q))
            await member.roles.remove(q, 'Midtown Vanguard release');
        if (!skipped.length)
            this.store.run('DELETE FROM backups WHERE guild_id=? AND user_id=?', guild.id, userId);
        return `Restored ${restored.length} role(s); skipped ${skipped.length}. ${skipped.length ? 'Backup retained for another restoration attempt.' : 'Backup cleared.'}`;
    }
}
