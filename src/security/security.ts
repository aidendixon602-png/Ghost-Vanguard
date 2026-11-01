import { isBotPermissionRole } from './role-policy.js';
import { isBlacklisted } from './role-blacklist.js';
import { consumeApprovedRoleChange } from './role-authorizations.js';
import { ActionRowBuilder, AuditLogEvent, PermissionFlagsBits, ButtonBuilder, ButtonStyle, Colors, Guild, GuildAuditLogsEntry, GuildMember, type EmbedBuilder } from 'discord.js';
import { dangerous, escalationAdded, KeyedQueue, overrideRule, ruleFor, RULES, WARN_FIRST, WARNING_MEMORY_MS, KNOWN_ROLE_BOTS, type Rule } from '../core.js';
import type { Store } from '../database/db.js';
import { developers } from '../bot/developers.js';
import { isTrustedBot, isWhitelistedPerson, TRUSTED_BOTS } from '../bot/trusted-bots.js';
import { AppError } from '../errors.js';
import type { LogQueue } from '../logging.js';
import { noteThreat } from './threat-board.js';
import { embed, memberOrNull } from '../ui/ui.js';
import { incidentCard } from '../ui/incident-card.js';
import { alertExempt } from '../bot/env-rules.js';
import { scopeName } from '../ui/antinuke-panel.js';
import { dmGlobalAlert, sendGlobalAlert, snapshotMember, type GlobalAlertInfo } from './global-alert.js';
import { recentJoiners, switchOnRaid } from './raid-waves.js';
import { handleRaidJoin, raidState } from './raidmode.js';
import { logRoute } from '../audit/log-setup.js';

type Change = {
    key: string;
    old?: any;
    new?: any;
};

/** How far back an incident alert looks for channels and roles the actor deleted. */
const DELETION_LOOKBACK_MS = 10 * 60 * 1000;
const ruleByKey = (key: string) => RULES.find(r => r.key === key)!;
const changesOf = (entry: GuildAuditLogsEntry) => (entry.changes ?? []) as Change[];

/** Roles added to a member by this entry that carry escalation permissions. */
/** Administrator and Manage Server: still checked for whitelisted role managers (Manage Server can add bots). */
const ALWAYS_STRICT = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild;

/** Escalation permissions a member role grant really adds: what the new roles give that the member's other roles did not. */
function memberEscalation(entry: GuildAuditLogsEntry, guild: Guild): { roles: string[]; bits: bigint } {
    if (entry.action !== AuditLogEvent.MemberRoleUpdate)
        return { roles: [], bits: 0n };
    const added = ((changesOf(entry).find(c => c.key === '$add')?.new ?? []) as { id: string }[]).map(r => r.id);
    const member = entry.targetId ? guild.members?.cache?.get(entry.targetId) : undefined;
    let before = 0n;
    for (const [id, role] of member?.roles?.cache ?? [])
        if (!added.includes(String(id))) before |= toBigInt((role as any)?.permissions?.bitfield ?? guild.roles?.cache?.get(String(id))?.permissions?.bitfield);
    let bits = 0n;
    const roles: string[] = [];
    for (const id of added) {
        const role = guild.roles?.cache?.get(id);
        if (!role || role.managed) continue;
        const gain = escalationAdded(before, role.permissions.bitfield);
        if (gain !== 0n) { roles.push(id); bits |= gain; }
    }
    return { roles, bits };
}

function escalatingRolesAdded(entry: GuildAuditLogsEntry, guild: Guild): string[] {
    return memberEscalation(entry, guild).roles;
}

function toBigInt(value: unknown): bigint {
    try { return value === undefined || value === null ? 0n : BigInt(value as any); } catch { return 0n; }
}

/** Escalation permissions this entry hands out: a role gaining them, a new role created with them, or a member given a role with them. */
function escalationBits(entry: GuildAuditLogsEntry, guild: Guild): bigint {
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

/** Self-granting Administrator or Manage Server is never downgraded to a first warning. */
function isSelfAdminAssignment(entry: GuildAuditLogsEntry, guild: Guild, actor: string): boolean {
    return entry.action === AuditLogEvent.MemberRoleUpdate
        && entry.targetId === actor
        && (escalationBits(entry, guild) & ALWAYS_STRICT) !== 0n;
}

/**
 * Who an audit entry should be counted against. Bans and kicks done through /mod are
 * executed by the bot, which is otherwise exempt, but the bot records the moderator's ID at the
 * start of the reason ("<id>: <reason>"). Counting those against the moderator stops a
 * compromised moderator from mass-banning through the bot. The bot's own restores and
 * containment use other reason text and stay exempt.
 */
export function responsibleActor(entry: GuildAuditLogsEntry, guild: Guild): string | null {
    const executor = entry.executorId;
    // Every action Vanguard performs for a staff member (/mod, /mod role, /mod slowmode, /mod nick, /mod massban...)
    // starts its audit reason with "<staff ID>: ", so it counts against that person, never the exempt bot.
    if (executor && executor === guild.client.user?.id)
        return /^(\d{17,20}): /.exec(entry.reason ?? '')?.[1] ?? executor;
    return executor;
}

/** An AutoMod rule was switched off (deletions are matched by the rule's audit action). */
function disablesAutoMod(entry: GuildAuditLogsEntry): boolean {
    return entry.action === AuditLogEvent.AutoModerationRuleUpdate
        && changesOf(entry).some(c => c.key === 'enabled' && c.old === true && c.new === false);
}

export class Security {
    readonly queue = new KeyedQueue();

    constructor(readonly store: Store, readonly logs: LogQueue) { }

    private incidentLog(guildId: string, card: EmbedBuilder, rows: ActionRowBuilder<ButtonBuilder>[] = []) {
        this.logs.push(guildId, card, rows);
        const channel = logRoute(this.store, guildId, 'antinuke');
        if (channel && channel !== this.store.settings(guildId).logChannelId)
            this.logs.push(guildId, card, rows, channel);
    }

    trusted(guild: Guild, id: string, ignoreRoles: string[] = []): boolean {
        return id === guild.ownerId || id === guild.client.user?.id || developers.has(id) || isTrustedBot(id) || isWhitelistedPerson(id) || this.store.hasGrant(guild.id, id, 'trust') || [...(guild.members?.cache?.get(id)?.roles.cache.keys() ?? [])].some(role => !ignoreRoles.includes(role) && this.store.hasGrant(guild.id, role, 'trust_role'));
    }

    /**
     * Why anti-nuke must not punish this person, or null. They are still watched: when they hit a limit,
     * the alert, the global feed and the DM all go out, marked "not punished".
     */
    exemptReason(guild: Guild, id: string, ignoreRoles: string[] = []): string | null {
        if (id === guild.ownerId) return 'the server owner';
        if (developers.has(id)) return 'a Developer';
        if (isTrustedBot(id)) return `a trusted bot (${TRUSTED_BOTS.get(id)})`;
        if (isWhitelistedPerson(id)) return 'whitelisted on Ghost Vanguard';
        if (this.store.hasGrant(guild.id, id, 'trust')) return 'on the full whitelist';
        if ([...(guild.members?.cache?.get(id)?.roles.cache.keys() ?? [])].some(role => !ignoreRoles.includes(role) && this.store.hasGrant(guild.id, role, 'trust_role'))) return 'whitelisted by role';
        return null;
    }

    /**
     * The separate permission-grant whitelist: who may hand out Administrator and the other protected
     * permissions through Discord. Deliberately narrower than exemptReason — a full or role bypass and
     * every other whitelist entry leave this checked. Set it with `/antinuke whitelist admin`.
     */
    grantExemptReason(guild: Guild, id: string, ignoreRoles: string[] = []): string | null {
        if (id === guild.ownerId) return 'the server owner';
        if (developers.has(id)) return 'a Developer';
        if (isTrustedBot(id)) return `a trusted bot (${TRUSTED_BOTS.get(id)})`;
        if (isWhitelistedPerson(id)) return 'whitelisted on Ghost Vanguard';
        if (this.trustedFor(guild, id, 'dangerous_grant', ignoreRoles)) return 'on the permission-grant whitelist';
        return null;
    }

    /** Rule-only whitelist: the user (kind "trust:<rule>") or one of their roles ("trust_role:<rule>") skips just that rule. */
    trustedFor(guild: Guild, id: string, rule: string, ignoreRoles: string[] = []): boolean {
        return this.store.hasGrant(guild.id, id, `trust:${rule}`) || [...(guild.members?.cache?.get(id)?.roles.cache.keys() ?? [])].some(role => !ignoreRoles.includes(role) && this.store.hasGrant(guild.id, role, `trust_role:${rule}`));
    }

    async audit(entry: GuildAuditLogsEntry, guild: Guild) {
        return this.queue.run(guild.id, async () => {
            const s = this.store.settings(guild.id);
            // A change approved through /role (this exact member, role and operation, made by Vanguard) is not an attack.
            if (consumeApprovedRoleChange(entry, guild)) return;
            const actor = responsibleActor(entry, guild);
            if (actor && this.store.get("SELECT 1 FROM grants WHERE guild_id=? AND (kind='trust_role' OR kind LIKE 'trust_role:%') AND (expires IS NULL OR expires>?)", guild.id, Date.now())) await memberOrNull(guild, actor).catch(() => null);
            const newlyAssigned = entry.action === AuditLogEvent.MemberRoleUpdate && entry.targetId === actor ? (changesOf(entry).find(c=>c.key==='$add')?.new ?? []).map((r:{id:string})=>r.id) : [];
            // Everyone is watched except Vanguard itself (its own actions are attributed to the staff member behind them)
            // and the network's other trusted bots, whose actions are their own business (see bot/trusted-bots.ts).
            if (!s.authorized || !actor || actor === guild.client.user?.id || isTrustedBot(actor) || isWhitelistedPerson(actor))
                return;
            // Owner, Developers and whitelisted people are watched too, but never punished.
            const exempt = this.exemptReason(guild, actor, newlyAssigned);
            if (entry.action === AuditLogEvent.MemberRoleUpdate && entry.targetId && entry.targetId !== actor) await memberOrNull(guild, entry.targetId).catch(() => null);
            // Giving yourself Administrator or Manage Server is not a nuke: it is handled as self-escalation,
            // so it never creates an incident, scores on the threat board, alerts or counts toward a threshold.
            // Exempt people (owner, Developers, the permission-grant whitelist) are left alone entirely.
            if (entry.action === AuditLogEvent.MemberRoleUpdate && entry.targetId === actor && isSelfAdminAssignment(entry, guild, actor)) {
                // Only the permission-grant whitelist (and the owner/Developers) counts here: a full trust
                // bypass never covers handing out Administrator.
                if (!this.grantExemptReason(guild, actor, newlyAssigned)) await this.selfEscalation(guild, actor, newlyAssigned);
                return;
            }
            for (const { rule, eventId } of this.rulesFor(entry, guild, actor, newlyAssigned))
                // A role the actor just gave themselves cannot exempt that same action.
                // Granting protected permissions answers to its own whitelist: a full bypass and every other
                // whitelist entry leave it checked, so "whitelisted" never means "may hand out Administrator".
                await this.evaluate(entry, guild, actor, rule, eventId, rule.key === 'dangerous_grant'
                    ? this.grantExemptReason(guild, actor, newlyAssigned)
                    : exempt ?? (this.trustedFor(guild, actor, rule.key, newlyAssigned) ? 'whitelisted for this action' : null));
        });
    }

    /**
     * Self-assigned Administrator/Manage Server. The roles come straight back off and the member is
     * contained exactly as anti-nuke would have done, but this is not counted as a nuke: no observation,
     * no incident, no threat-board points, no repeat window and no global alert. Staff get one quiet card
     * and the member is told why. Works in enforce mode only; observe mode still watches and does nothing.
     */
    private async selfEscalation(guild: Guild, actor: string, assigned: string[]) {
        const s = this.store.settings(guild.id);
        if (!s.enabled || s.mode !== 'enforce') return;
        const member = await memberOrNull(guild, actor).catch(() => null);
        if (!member) return;
        const me = guild.members.me ?? (typeof guild.members.fetchMe === 'function' ? await guild.members.fetchMe().catch(() => null) : null);
        const roles = [...member.roles.cache.values()].filter(r => assigned.includes(r.id) && r.id !== guild.id && !r.managed && dangerous(r.permissions.bitfield));
        const removable = me ? roles.filter(r => me.roles.highest.comparePositionTo(r) > 0) : [];
        let removed: string[] = [];
        if (removable.length) {
            this.store.assertAuthorized(guild.id);
            removed = await member.roles.remove(removable.map(r => r.id), 'Ghost Vanguard: self-assigned protected permissions')
                .then(() => removable.map(r => r.id), () => []);
        }
        let containment: string;
        try { containment = await this.punish(guild, actor, 'strip', assigned); } catch { containment = 'Containment failed. Check role hierarchy and Manage Roles.'; }
        const names = (roles.length ? roles.map(r => `<@&${r.id}>`) : assigned.map(id => `<@&${id}>`)).join(', ');
        const answer = `${removed.length ? `Removed the self-assigned role${removed.length === 1 ? '' : 's'}.` : 'The self-assigned role could not be removed; move Vanguard\'s role above it.'} ${containment}`;
        this.store.run('INSERT INTO self_escalations(guild_id,user_id,roles,result,at) VALUES(?,?,?,?,?)', guild.id, actor, JSON.stringify(removed.length ? removed : assigned), answer, Date.now());
        this.incidentLog(guild.id, embed('Self-escalation blocked', `<@${actor}> gave themselves ${names}.\n${answer}\n-# Handled separately from anti-nuke: no incident, no threat-board score, no alert.`, Colors.Orange));
        void member.send({ embeds: [embed('Self-assigned role removed', [
            `In **${guild.name ?? 'this server'}** you gave yourself ${names}.`,
            '',
            answer,
            '',
            'Roles that carry Administrator or Manage Server are protection-relevant, so Vanguard removes them immediately. Ask the server owner or a Developer if you need one.',
        ].join('\n'), Colors.Orange)] }).catch(() => 0);
    }

    /** Every rule this audit entry counts toward, each with its own observation id. */
    private rulesFor(entry: GuildAuditLogsEntry, guild: Guild, actor: string, newlyAssigned: string[] = []): {
        rule: Rule;
        eventId: string;
    }[] {
        const found: {
            rule: Rule;
            eventId: string;
        }[] = [];
        const primary = ruleFor(entry.action);
        // The verification bot exemption covers ordinary member-role updates only, never dangerous grants.
        const verificationBot = entry.action === AuditLogEvent.MemberRoleUpdate && (this.store.hasGrant(guild.id, actor, 'bot') || (actor in KNOWN_ROLE_BOTS && !this.store.hasGrant(guild.id, actor, 'bot_denied')));
        const addsRole = entry.action !== AuditLogEvent.MemberRoleUpdate || changesOf(entry).some(c => c.key === '$add' && c.new?.length);
        if (primary && !verificationBot && addsRole)
            found.push({ rule: primary, eventId: entry.id });
        // Handing out or creating a role with protected permissions is always the Permission Grant rule,
        // however the actor is whitelisted for role work: that is what /antinuke whitelist admin is for.
        const escalation = escalationBits(entry, guild);
        if (escalation)
            found.push({ rule: ruleByKey('dangerous_grant'), eventId: `${entry.id}:dangerous_grant` });
        if (disablesAutoMod(entry))
            found.push({ rule: ruleByKey('automod_tamper'), eventId: `${entry.id}:automod_tamper` });
        if (entry.action === AuditLogEvent.MemberUpdate && changesOf(entry).some(c => c.key === 'communication_disabled_until' && c.new && Date.parse(String(c.new)) > Date.now()))
            found.push({ rule: ruleByKey('timeout'), eventId: `${entry.id}:timeout` });
        return found;
    }

    private async evaluate(entry: GuildAuditLogsEntry, guild: Guild, actor: string, rule: Rule, eventId: string, exempt: string | null = null) {
        const s = this.store.settings(guild.id);
        const now = Date.now();
        const at = entry.createdTimestamp;
        const active = overrideRule(rule, s.rules, s.ruleDefaults);
        if (active.enabled === false) return;
        if (!this.store.observe(eventId, guild.id, actor, rule.key, entry.targetId, at))
            return;
        this.store.run('INSERT INTO antinuke_event_payloads(guild_id,id,json) VALUES(?,?,?)', guild.id, eventId,
            JSON.stringify({ id: entry.id, action: entry.action, targetId: entry.targetId, changes: changesOf(entry) }));
        if (!s.enabled || now - at > 120000 || at > now + 10000)
            return;
        const count = this.store.count(guild.id, actor, rule.key, now - active.seconds * 1000);
        if (count < active.count) {
            // Still monitoring: one step before the limit, staff get a quiet heads-up (no action taken).
            if (!exempt && count === active.count - 1 && active.count >= 3 && s.mode === 'enforce') this.headsUp(guild, actor, active, count, now);
            return;
        }
        const recent = this.store.get("SELECT id,mode,result FROM incidents WHERE guild_id=? AND actor_id=? AND rule=? AND at>? AND mode<>'warn' ORDER BY id DESC LIMIT 1", guild.id, actor, rule.key, now - active.seconds * 1000);
        if (recent) {
            // Suppress repeated containment and alerts, never the reversals of a continuing attack.
            // Recheck the current mode and exemptions: an earlier incident is not authorization.
            if (s.mode === 'enforce' && recent.mode === 'enforce' && !exempt && active.revert) {
                const attempt = await this.attemptRevert(eventId, entry, guild, active);
                if (attempt) {
                    const detail = `[${attempt.outcome}] ${attempt.detail}`;
                    const base = String(recent.result).split('\nContinued protection:')[0]!.slice(0, 3000);
                    this.store.run('UPDATE incidents SET result=? WHERE guild_id=? AND id=?',
                        `${base}\nContinued protection: ${detail}`, guild.id, recent.id);
                    if (this.takeAlert(`${guild.id}:${actor}:${rule.key}:continued`, 5000, now))
                        this.incidentLog(guild.id, embed(`Incident #${recent.id} · Continued protection`,
                            `<@${actor}> continued **${active.title}** during the incident window.\n${detail.slice(0, 1500)}\nFurther outcomes are saved with the audit evidence.`, Colors.Orange));
                }
            }
            return;
        }
        if (exempt) return this.alertExempt(guild, actor, active, count, exempt, entry.targetId ?? null, s.logChannelId);
        // Most dangerous grants are reverted with a warning first; a repeat within an hour strips.
        // Self-assigning Administrator or Manage Server remains an immediate strip-and-revert.
        const immediateSelfAdmin = rule.key === 'dangerous_grant' && isSelfAdminAssignment(entry, guild, actor);
        const canWarn = rule.key === 'dangerous_grant' ? !immediateSelfAdmin : WARN_FIRST.has(rule.key);
        // Escalate only a repeat of the same rule. A warning for a legitimate channel edit must
        // not turn an unrelated later role change into an immediate strip.
        const recentWarning = this.store.get("SELECT 1 FROM incidents WHERE guild_id=? AND actor_id=? AND rule=? AND mode='warn' AND at>?", guild.id, actor, rule.key, now - WARNING_MEMORY_MS);
        const warnOnly = s.mode === 'enforce' && canWarn && !recentWarning
            && (rule.key === 'dangerous_grant' || !(await memberOrNull(guild, actor).catch(() => null))?.user?.bot);
        // Write evidence before trying any Discord mutation.
        const incident = this.store.incident(guild.id, actor, rule.key, warnOnly ? 'warn' : s.mode, 'Pending');
        // Every scored incident lands on the threat board, so one record feeds both halves:
        // the defence that happens here and the staff-led review the board supports.
        noteThreat(this.store, guild.id, actor, rule.key, `Anti-nuke ${active.title} (incident #${incident})`);
        // Who they were and which roles they held before anything is removed (for the global alert feed).
        const snapshot = snapshotMember(await memberOrNull(guild, actor).catch(() => null));
        let result = 'Observed only; no Discord actions taken.';
        const progress = {completed:0,failed:0,skipped:0};
        if (s.mode === 'enforce') {
            if (warnOnly) {
                result = `Warning: no roles were removed. ${active.revert ? 'A safe revert was attempted.' : 'The triggering change was not automatically reverted; staff should review it.'} Doing this same action again within an hour gets the normal response.`;
                void this.warnActor(guild, actor, active.title, !!active.revert);
            } else try {
                const ignoreRoles = entry.action === AuditLogEvent.MemberRoleUpdate && entry.targetId === actor ? (changesOf(entry).find(c=>c.key==='$add')?.new ?? []).map((r:{id:string})=>r.id) : [];
                result = await this.punish(guild, actor, active.punishment ?? 'strip', ignoreRoles);
            } catch {
                result = 'Containment failed. Check role hierarchy and Manage Roles.';
            }
            if (active.revert) {
                const events = this.store.all("SELECT p.id,p.json FROM antinuke_event_payloads p JOIN observations o ON o.id=p.id AND o.guild_id=p.guild_id WHERE o.guild_id=? AND o.actor_id=? AND o.rule=? AND o.at>=? AND json_extract(p.json,'$.revertAttempted') IS NULL ORDER BY o.at DESC", guild.id, actor, rule.key, now - active.seconds * 1000);
                let processed=0;
                for (const event of events) {
                    const attempt = await this.attemptRevert(event.id, JSON.parse(event.json), guild, active);
                    if (!attempt) continue;
                    progress[attempt.outcome]++;
                    result += ` [${attempt.outcome}] ${attempt.detail}`;
                    this.store.run('UPDATE incidents SET result=? WHERE guild_id=? AND id=?', `${result} Reverts: ${progress.completed} completed, ${progress.failed} failed, ${progress.skipped} skipped.`, guild.id, incident);
                    processed++;
                    if(events.length>5&&(processed===1||processed%10===0))this.incidentLog(guild.id,embed(`Incident #${incident} · Revert progress`,`${processed}/${events.length} reviewed · ${progress.completed} completed · ${progress.failed} failed · ${progress.skipped} skipped`,Colors.Orange));
                }
            }
        }
        result += ` Reverts: ${progress.completed} completed, ${progress.failed} failed, ${progress.skipped} skipped.`;
        this.store.run('UPDATE incidents SET result=? WHERE guild_id=? AND id=?', result, guild.id, incident);
        const deleted = this.recentDeletions(guild.id, actor, now);
        const buttons: ButtonBuilder[] = [];
        // A strip that removed roles can be undone in one click if it was a false alarm (owner and developers only).
        if (s.mode === 'enforce' && (active.punishment ?? 'strip') === 'strip' && /^Removed [1-9]\d* dangerous role/.test(result))
            buttons.push(new ButtonBuilder().setCustomId(`incident:undo:${incident}`).setLabel('Undo strip').setEmoji('↩️').setStyle(ButtonStyle.Success));
        if (deleted.channels || deleted.roles)
            buttons.push(new ButtonBuilder().setCustomId(`incident:restore:${incident}`).setLabel('Review restore').setStyle(ButtonStyle.Secondary));
        const rows = buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [];
        this.incidentLog(guild.id, incidentCard({ incident, actor, rule: active, mode: warnOnly ? 'warn' : s.mode, count, result, progress, deleted, targetId: entry.targetId ?? null, whitelistNote: this.partialWhitelist(guild, actor, active) }), rows);
        try {
            const info: GlobalAlertInfo = {
                guild: { id: guild.id, name: guild.name }, actor, snapshot, rule: active, mode: warnOnly ? 'warn' : s.mode, incident,
                failed: /cannot|unavailable|failed|Protected|no longer a member|not contained|incomplete/i.test(result.split(' [')[0]!),
                reverted: active.revert ? progress : null,
                whitelistNote: this.partialWhitelist(guild, actor, active),
                jumpUrl: `https://discord.com/channels/${guild.id}${s.logChannelId ? `/${s.logChannelId}` : ''}`,
            };
            sendGlobalAlert(this.store, this.logs, info, guild.client);
            // The same card by DM to the trusted people (TRUSTED_DM_IDS). Never waits on Discord here.
            void dmGlobalAlert(guild.client, this.store, info).catch(() => 0);
        } catch { /* the feed is extra; the server's own alert above is what matters */ }
    }

    /** Persist the attempt before Discord I/O so repeats and restarts cannot reapply an old undo. */
    private async attemptRevert(eventId: string, entry: GuildAuditLogsEntry, guild: Guild, rule: Rule) {
        const claimed = this.store.run("UPDATE antinuke_event_payloads SET json=json_set(json,'$.revertAttempted',true) WHERE guild_id=? AND id=? AND json_extract(json,'$.revertAttempted') IS NULL", guild.id, eventId);
        if (!claimed.changes) return null;
        let detail: string;
        let outcome: 'completed' | 'failed' | 'skipped';
        try {
            detail = await this.revert(entry, guild, rule);
            outcome = /kept|skipped|absent|protected|No automatic|no roles|Removed 0 /i.test(detail) ? 'skipped'
                : /^(Removed|Banned|Deleted|Restored) /i.test(detail) ? 'completed' : 'failed';
        } catch {
            detail = 'Revert failed; check bot permissions and role hierarchy.';
            outcome = 'failed';
        }
        this.store.run("UPDATE antinuke_event_payloads SET json=json_set(json,'$.revertOutcome',?,'$.revertDetail',?) WHERE guild_id=? AND id=?", outcome, detail, guild.id, eventId);
        return { outcome, detail };
    }

    private takeAlert(key: string, milliseconds: number, now: number): boolean {
        if ((this.headsUps.get(key) ?? 0) > now) return false;
        this.headsUps.set(key, now + milliseconds);
        if (this.headsUps.size > 5000)
            for (const [id, expiry] of this.headsUps) if (expiry <= now) this.headsUps.delete(id);
        return true;
    }

    /** Someone anti-nuke never punishes hit a limit: record it and alert everywhere, but take no action. */
    private async alertExempt(guild: Guild, actor: string, rule: Rule, count: number, reason: string, targetId: string | null, logChannelId: string | null) {
        const result = `Not punished: ${reason}. Nothing was undone.`;
        const incident = this.store.incident(guild.id, actor, rule.key, 'exempt', result);
        // Recorded either way (/antinuke incidents); cards and DMs only with ALERT_EXEMPT=true.
        if (!alertExempt()) return;
        const snapshot = snapshotMember(await memberOrNull(guild, actor).catch(() => null));
        this.incidentLog(guild.id, incidentCard({ incident, actor, rule, mode: 'exempt', exemptReason: reason, count, result, progress: { completed: 0, failed: 0, skipped: 0 }, deleted: this.recentDeletions(guild.id, actor, Date.now()), targetId }));
        try {
            const info: GlobalAlertInfo = { guild: { id: guild.id, name: guild.name }, actor, snapshot, rule, mode: 'exempt', exemptReason: reason, incident, failed: false, reverted: null,
                jumpUrl: `https://discord.com/channels/${guild.id}${logChannelId ? `/${logChannelId}` : ''}` };
            sendGlobalAlert(this.store, this.logs, info, guild.client);
            void dmGlobalAlert(guild.client, this.store, info).catch(() => 0);
        } catch { }
    }

    /**
     * Someone with whitelist entries that don't cover this rule: say what they are whitelisted for and what is
     * missing, so staff know why a "whitelisted" person was punished and how to allow it. Null when they have none.
     */
    partialWhitelist(guild: Guild, actor: string, rule: Rule): string | null {
        const ids = [actor, ...(guild.members?.cache?.get(actor)?.roles.cache.keys() ?? [])];
        const marks = ids.map(() => '?').join(',');
        const kinds = this.store.all(`SELECT kind FROM grants WHERE guild_id=? AND user_id IN (${marks}) AND (kind LIKE 'trust:%' OR kind LIKE 'trust_role:%') AND (expires IS NULL OR expires>?)`, guild.id, ...ids, Date.now())
            .map(r => String(r.kind).split(':')[1]!).filter(Boolean);
        if (!kinds.length) return null;
        const where = rule.key === 'dangerous_grant'
            ? '`/antinuke whitelist admin` (a full bypass does not cover permission grants)'
            : '`/antinuke whitelist add` (or pick "Everything")';
        return `Whitelisted for **${scopeName([...new Set(kinds)])}**, but not for **${rule.title}**. If they should be allowed to do this, add it with ${where}.`;
    }

    private readonly headsUps = new Map<string, number>();
    /** "Close to the limit" note in the security log, at most once per person, rule and window. */
    private headsUp(guild: Guild, actor: string, rule: Rule, count: number, now: number) {
        const key = `${guild.id}:${actor}:${rule.key}`;
        if (!this.takeAlert(key, rule.seconds * 1000, now)) return;
        const next = WARN_FIRST.has(rule.key) ? 'a warning' : `being ${rule.punishment === 'ban' ? 'banned' : rule.punishment === 'kick' ? 'kicked' : 'stripped'}`;
        this.incidentLog(guild.id, embed('Anti-nuke heads-up', `<@${actor}> is close to the **${rule.title}** limit: **${count} of ${rule.count}** in ${rule.seconds}s. Nothing has been done. One more gets them ${next}.\n-# If this is normal for them, whitelist them with \`/antinuke whitelist add\`.`, Colors.Blue));
    }

    /** Tell someone privately that anti-nuke warned them, so a staff member doing normal work knows to slow down or ask for a whitelist. */
    async warnActor(guild: Guild, actor: string, what: string, revertAttempted: boolean): Promise<boolean> {
        try {
            const member = await memberOrNull(guild, actor);
            if (!member || member.user?.bot) return false;
            await member.send({ embeds: [embed('⚠️ Anti-nuke warning', [
                `In **${guild.name ?? 'the server'}**, you reached the anti-nuke **${what}** limit.`,
                '',
                '**No roles were removed this time.**' + (revertAttempted ? ' A safe revert was attempted; check the security log to see whether it succeeded.' : ' This action was not automatically reverted; staff can review the security log.'),
                'Repeating the same rule within the next hour gets its normal response. If this is expected work, ask the server owner to adjust `/antinuke rule` or whitelist you for that rule.',
            ].join('\n'), Colors.Yellow)] });
            return true;
        } catch { return false; }
    }

    async punish(guild: Guild, actor: string, action: 'ban' | 'kick' | 'strip', ignoreRoles: string[] = []): Promise<string> {
        this.store.assertAuthorized(guild.id);
        if (this.trusted(guild, actor, ignoreRoles)) return 'Protected executor; no action taken.';
        if (action === 'strip') return this.contain(guild, actor, true, ignoreRoles);
        const member = await memberOrNull(guild, actor);
        if (!member || !(action === 'ban' ? member.bannable : member.kickable))
            return 'Executor cannot be ' + (action === 'ban' ? 'banned' : 'kicked') + '; check membership, permissions and role hierarchy.';
        this.store.assertAuthorized(guild.id);
        if (action === 'ban') await member.ban({reason:'Ghost Vanguard: anti-nuke rule triggered',deleteMessageSeconds:0});
        else await member.kick('Ghost Vanguard: anti-nuke rule triggered');
        return action === 'ban' ? 'Banned the executor.' : 'Kicked the executor.';
    }

    async revert(entry: GuildAuditLogsEntry, guild: Guild, rule: Rule): Promise<string> {
        this.store.assertAuthorized(guild.id);
        const id = entry.targetId;
        if (!id) return 'Revert target is unavailable.';
        if (rule.key === 'dangerous_grant') return this.revertGrant(entry, guild);
        if (rule.key === 'mass_ban') {
            await guild.bans.remove(id, 'Ghost Vanguard: revert anti-nuke bans');
            return 'Removed ban for ' + id + '.';
        }
        if (rule.key === 'mass_unban') {
            if (id === guild.ownerId || this.trusted(guild, id)) return 'The unbanned user is trusted; left unbanned.';
            await guild.bans.create(id, { reason: 'Ghost Vanguard: revert mass unban' });
            return 'Banned ' + id + ' again.';
        }
        if (rule.key === 'bot_add') {
            if (this.trusted(guild, id)) return 'Added bot is trusted; kept it.';
            const member = await memberOrNull(guild, id);
            if (!member?.user.bot || !member.bannable) return 'Added bot cannot be removed; check role hierarchy.';
            this.store.assertAuthorized(guild.id);
            await member.ban({reason:'Ghost Vanguard: revert unauthorized bot addition',deleteMessageSeconds:0});
            return 'Banned the added bot.';
        }
        if (rule.key === 'channel_create') {
            const channel = await guild.channels.fetch(id);
            if (!channel) return 'Created channel is already absent.';
            this.store.assertAuthorized(guild.id);
            await channel.delete('Ghost Vanguard: revert channel creation');
            return 'Deleted created channel ' + id + '.';
        }
        if (rule.key === 'role_create') {
            const role = await guild.roles.fetch(id);
            if (!role) return 'Created role is already absent.';
            if (role.managed || !role.editable) return 'Created role is managed or above Vanguard; kept it.';
            this.store.assertAuthorized(guild.id);
            await role.delete('Ghost Vanguard: revert role creation');
            return 'Deleted created role ' + id + '.';
        }
        if (rule.key === 'role_grant') {
            const target = await memberOrNull(guild, id);
            const added = changesOf(entry).find(c => c.key === '$add')?.new ?? [];
            if (!target || this.trusted(guild, id, added.map((r:{id:string})=>r.id))) return 'Role recipient is absent or protected; no roles changed.';
            const ids = added.map((r: {id:string}) => r.id).filter((id:string) => guild.roles.cache.get(id)?.editable && !guild.roles.cache.get(id)?.managed && target.roles.cache.has(id));
            this.store.assertAuthorized(guild.id);
            if (ids.length) await target.roles.remove(ids, 'Ghost Vanguard: revert role assignment');
            return 'Removed ' + ids.length + ' assigned role(s).';
        }
        if (rule.key === 'timeout') {
            const target = await memberOrNull(guild, id);
            const change = changesOf(entry).find(c => c.key === 'communication_disabled_until');
            if (!target || !target.moderatable || target.communicationDisabledUntilTimestamp !== Date.parse(String(change?.new)))
                return 'Timeout has changed or cannot be managed; kept current state.';
            const old = change?.old ? Date.parse(String(change.old)) : NaN;
            this.store.assertAuthorized(guild.id);
            await target.disableCommunicationUntil(Number.isFinite(old) && old > Date.now() ? old : null,'Ghost Vanguard: revert unauthorized timeout');
            return 'Restored previous timeout for ' + id + '.';
        }
        if (rule.key === 'webhook_change') {
            if (entry.action !== AuditLogEvent.WebhookCreate) return 'Webhook edit/deletion cannot be exactly undone without its previous credentials; manual review required.';
            const hooks = await guild.fetchWebhooks();
            const hook = hooks.get(id);
            if (!hook) return 'Created webhook is already absent.';
            this.store.assertAuthorized(guild.id);
            await hook.delete('Ghost Vanguard: revert webhook creation');
            return 'Deleted created webhook ' + id + '.';
        }
        return 'No automatic revert available for this event.';
    }

    /** Channels and roles this actor deleted recently, from recorded audit events. */
    recentDeletions(guildId: string, actor: string, now = Date.now()) {
        const rows = this.store.all("SELECT rule, COUNT(*) AS n FROM observations WHERE guild_id=? AND actor_id=? AND rule IN ('channel_delete','role_delete') AND at>=? GROUP BY rule", guildId, actor, now - DELETION_LOOKBACK_MS);
        const count = (key: string) => Number(rows.find(r => r.rule === key)?.n ?? 0);
        return { channels: count('channel_delete'), roles: count('role_delete') };
    }

    /** Undo the grant behind a dangerous_grant incident: strip the new permissions from the role, or the new roles from the member. */
    async revertGrant(entry: GuildAuditLogsEntry, guild: Guild): Promise<string> {
        this.store.assertAuthorized(guild.id);
        if (entry.action === AuditLogEvent.RoleCreate) {
            const role = entry.targetId ? await guild.roles.fetch(entry.targetId).catch(() => null) : null;
            if (!role) return 'The new role is already gone.';
            if (role.managed || !role.editable) return 'The new role is managed or above Vanguard; kept it.';
            this.store.assertAuthorized(guild.id);
            await role.delete('Ghost Vanguard: new role created with dangerous permissions');
            return `Deleted the new role ${role.name}, which was created with dangerous permissions.`;
        }
        if (entry.action === AuditLogEvent.RoleUpdate) {
            const change = changesOf(entry).find(c => c.key === 'permissions');
            const role = entry.targetId ? await guild.roles.fetch(entry.targetId).catch(() => null) : null;
            if (!role || role.managed || !role.editable)
                return 'The permission grant could not be undone (role missing, managed, or above Vanguard).';
            const added = escalationAdded(change?.old, change?.new);
            this.store.assertAuthorized(guild.id);
            await role.setPermissions(role.permissions.bitfield & ~added, 'Ghost Vanguard: undo dangerous permission grant');
            return `Removed the newly granted permissions from role ${role.name}.`;
        }
        const roles = escalatingRolesAdded(entry, guild);
        const target = entry.targetId ? await memberOrNull(guild, entry.targetId) : null;
        if (!target || !roles.length)
            return 'The role grant could not be undone (member no longer present).';
        if (this.trusted(guild, target.id, (changesOf(entry).find(c => c.key === '$add')?.new ?? []).map((r:{id:string})=>r.id)))
            return 'The recipient is protected; the granted roles were kept.';
        const removable = roles.filter(id => guild.roles.cache.get(id)?.editable);
        if (!removable.length)
            return 'The granted roles are above Vanguard and could not be removed.';
        this.store.assertAuthorized(guild.id);
        await target.roles.remove(removable, 'Ghost Vanguard: undo dangerous role grant');
        return `Removed ${removable.length} newly granted role(s) from <@${target.id}>.`;
    }

    async join(member: GuildMember) {
        return this.queue.run(member.guild.id, async () => {
            const s = this.store.settings(member.guild.id);
            if (!s.authorized || !s.enabled)
                return;
            const rule = overrideRule(RULES.find(r => r.key === 'join_flood')!, s.rules, s.ruleDefaults);
            if (rule.enabled === false) return;
            const now = Date.now();
            if (!this.store.observe(`join:${member.guild.id}:${member.id}:${member.joinedTimestamp}`, member.guild.id, 'joins', rule.key, member.id, now))
                return;
            const count = this.store.count(member.guild.id, 'joins', rule.key, now - rule.seconds * 1000);
            if (count < rule.count || this.store.get('SELECT 1 FROM incidents WHERE guild_id=? AND actor_id=? AND rule=? AND at>?', member.guild.id, 'joins', rule.key, now - rule.seconds * 1000))
                return;
            const wasOn = raidState(this.store, member.guild.id, now).enabled;
            let raid = await switchOnRaid(this.store, this.logs, member.guild, now, 'join flood');
            // Raid mode starts after the flood has joined: sweep the accounts that made it up too.
            if (!wasOn && raidState(this.store, member.guild.id, now).enabled) {
                const trusted = (id: string) => this.trusted(member.guild, id);
                let swept = 0;
                for (const joiner of recentJoiners(member.guild, rule.seconds * 2000, now)) {
                    const result = await handleRaidJoin(this.store, this.logs, joiner, trusted, now).catch(() => 'failed');
                    if (result === 'kicked' || result === 'timed out') swept++;
                }
                if (swept) raid += `\nSwept **${swept}** account(s) from the wave that triggered it.`;
            }
            const id = this.store.incident(member.guild.id, 'joins', rule.key, s.mode, `Join flood. ${raid}`);
            this.incidentLog(member.guild.id, embed(`Incident #${id} · Join flood`, `${count} joins in ${rule.seconds}s.\n${raid}`, Colors.Orange));
        });
    }

    async contain(guild: Guild, userId: string, fromIncident = false, ignoreRoles: string[] = []): Promise<string> {
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
            await member.kick('Ghost Vanguard containment: bot triggered anti-nuke');
            return 'Removed the bot from the server (bot containment is set to kick).';
        }
        if (!member.manageable)
            return 'Executor is above the bot or cannot be managed; containment unavailable.';
        this.store.assertAuthorized(guild.id);
        await guild.roles.fetch();
        const current = member.roles.cache.filter(r => r.id !== guild.id && !r.managed).map(r => r.id);
        const old = this.store.get('SELECT * FROM backups WHERE guild_id=? AND user_id=?', guild.id, userId);
        const saved = [...new Set([...current, ...(old ? JSON.parse(old.roles) as string[] : [])])];
        this.store.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1) ON CONFLICT(guild_id,user_id) DO UPDATE SET roles=excluded.roles,active=1', guild.id, userId, JSON.stringify(saved), Date.now());
        const removable = member.roles.cache.filter(r => r.id !== guild.id && !r.managed && dangerous(r.permissions.bitfield) && me.roles.highest.comparePositionTo(r) > 0);
        this.store.assertAuthorized(guild.id);
        if (removable.size)
            await member.roles.remove([...removable.keys()], 'Ghost Vanguard containment');
        const qId = this.store.settings(guild.id).quarantineRoleId;
        const q = qId ? guild.roles.cache.get(qId) : null;
        this.store.assertAuthorized(guild.id);
        if (q && !q.managed && !isBotPermissionRole(this.store, guild.id, q.id) && !dangerous(q.permissions.bitfield) && q.editable)
            await member.roles.add(q, 'Ghost Vanguard quarantine');
        const fresh = await guild.members.fetch({ user: userId, force: true });
        const remaining = dangerous(fresh.permissions.bitfield);
        return `Removed ${removable.size} dangerous role(s). ${remaining ? 'Dangerous guild permissions remain; containment is incomplete.' : 'No dangerous guild permissions remain.'} Channel-specific overwrites and managed roles may still grant access.`;
    }

    async reconcile(member: GuildMember) {
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
                if (q && member.roles.cache.has(q)) await member.roles.remove(q, `Ghost Vanguard: quarantine lifted by ${by}`).catch(() => null);
                this.logs.push(member.guild.id, embed('Quarantine lifted', `<@${by}> gave <@${member.id}> a staff role, so Vanguard ended their quarantine instead of removing it.\nTo quarantine them again use \`/antinuke quarantine\`.`, Colors.Green));
                return;
            }
            const result = await this.contain(member.guild, member.id);
            if (/^Removed [1-9]/.test(result))
                this.logs.push(member.guild.id, embed('Quarantine still active', `<@${member.id}> is quarantined from an earlier anti-nuke incident, so Vanguard removed the staff role they were given. ${result}\nTo let them keep staff roles, use \`/antinuke release\` (or have a whitelisted admin give the role).`, Colors.Orange));
        });
    }

    /** The trusted person who just added roles to this member, if the latest audit entry shows one. */
    private async grantedByTrusted(member: GuildMember): Promise<string | null> {
        const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 10 }).catch(() => null);
        const entry = logs?.entries.find(e => e.targetId === member.id && Date.now() - e.createdTimestamp < 30_000 && changesOf(e).some(c => c.key === '$add' && c.new?.length));
        if (!entry) return null;
        const actor = responsibleActor(entry, member.guild);
        if (!actor || actor === member.id || actor === member.guild.client.user?.id) return null;
        return this.trusted(member.guild, actor) ? actor : null;
    }

    async release(guild: Guild, userId: string, privileged: boolean, actorId?: string): Promise<string> {
        this.store.assertAuthorized(guild.id);
        const row = this.store.get('SELECT * FROM backups WHERE guild_id=? AND user_id=?', guild.id, userId);
        if (!row)
            throw new AppError('VALIDATION_ERROR', 'No role backup exists for this user.');
        const member = await guild.members.fetch({ user: userId, force: true });
        this.store.assertAuthorized(guild.id);
        await guild.roles.fetch();
        const restored: string[] = [], skipped: string[] = [];
        for (const id of JSON.parse(row.roles) as string[]) {
            const role = guild.roles.cache.get(id);
            // Blacklisted roles are never restored automatically: that would launder them past the list.
            if (!role || role.managed || !role.editable || isBlacklisted(this.store, guild.id, id) || (isBotPermissionRole(this.store, guild.id, id) && !developers.has(actorId ?? '')) || (!privileged && dangerous(role.permissions.bitfield))) {
                skipped.push(id);
                continue;
            }
            restored.push(id);
        }
        // Stop persistent quarantine enforcement before restoring roles. Failed operations retain the backup.
        this.store.run('UPDATE backups SET active=0 WHERE guild_id=? AND user_id=?', guild.id, userId);
        this.store.assertAuthorized(guild.id);
        if (restored.length)
            await member.roles.add(restored, 'Ghost Vanguard authorized role restoration');
        const q = this.store.settings(guild.id).quarantineRoleId;
        this.store.assertAuthorized(guild.id);
        this.store.assertAuthorized(guild.id);
        if (q && member.roles.cache.has(q))
            await member.roles.remove(q, 'Ghost Vanguard release');
        if (!skipped.length)
            this.store.run('DELETE FROM backups WHERE guild_id=? AND user_id=?', guild.id, userId);
        return `Restored ${restored.length} role(s); skipped ${skipped.length}. ${skipped.length ? 'Backup retained for another restoration attempt.' : 'Backup cleared.'}`;
    }
}
