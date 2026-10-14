import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { incidentCard } from '../src/ui/incident-card.js';
import { permissionDiff, renderEvent } from '../src/audit/event-log.js';
import { RULES } from '../src/core.js';

const rule = (key: string) => RULES.find(r => r.key === key)!;
const base = { incident: 7, actor: '111', mode: 'enforce', count: 1, progress: { completed: 1, failed: 0, skipped: 0 }, deleted: { channels: 0, roles: 0 }, targetId: '222' };

test('anti-nuke card says who was stripped and for what', () => {
    const e = incidentCard({ ...base, rule: rule('dangerous_grant'), result: 'Removed 1 dangerous role(s). No dangerous guild permissions remain. [completed] Removed the newly granted permissions from role Owen.' }).toJSON();
    assert.equal(e.title, 'Anti-nuke Triggered');
    assert.equal(e.description, '<@111> was **stripped** for triggering anti-nuke.');
    const f = Object.fromEntries(e.fields!.map(x => [x.name, x.value]));
    assert.equal(f.Action, 'Permission Grant'); assert.equal(f.Punishment, 'Strip'); assert.equal(f['Changes reverted'], '1 undone');
    assert.match(f.Details!, /• Removed the newly granted permissions/);
    assert.equal(e.footer!.text, 'Incident #7 · User ID: 111');
});

test('anti-nuke card is honest when the punishment failed or only observed', () => {
    assert.match(incidentCard({ ...base, rule: rule('mass_ban'), result: 'Executor cannot be banned; check role hierarchy.' }).toJSON().description!, /could \*\*not\*\* be stripped/);
    assert.match(incidentCard({ ...base, mode: 'observe', rule: rule('mass_kick'), result: 'Observed only; no Discord actions taken.' }).toJSON().description!, /would have been \*\*stripped\*\*.*watch-only/);
});

test('role permission changes list each permission granted or revoked', () => {
    const F = PermissionsBitField.Flags;
    const before = F.SendMessages, after = F.SendMessages | F.Administrator | F.KickMembers | F.ManageGuild;
    assert.equal(permissionDiff(before.toString(), after.toString()), '`kick members` granted, `administrator` granted, `manage server` granted');
    assert.equal(permissionDiff(after.toString(), before.toString()), '`kick members` revoked, `administrator` revoked, `manage server` revoked');
    assert.equal(permissionDiff('1', '1'), null);
    const e = renderEvent({ category: 'roles', action: 'Role Updated', actorId: '9', actorLabel: 'Updated By', targetLabel: 'Role', target: '<@&5>', targetId: '5', details: [`🔐 **Permissions:** ${permissionDiff('0', F.BanMembers.toString())}`] }).toJSON();
    assert.equal(e.description, '🔐 **Permissions:** `ban members` granted');
    assert.deepEqual(e.fields!.map(x => x.name), ['Role', 'Updated By']);
    assert.match(e.footer!.text, /^Role ID: 5/);
});

import { AuditLogEvent } from 'discord.js';
import { describeAudit } from '../src/audit/event-log.js';
const F = PermissionsBitField.Flags;
const guild: any = { id: 'g', client: { user: { id: 'bot' }, users: { cache: new Map() } }, members: { cache: new Map() }, ownerId: 'o' };
const audit = (action: number, changes: any[]) => describeAudit({ id: '1', action, executorId: 'owen', targetId: '555', createdTimestamp: Date.now(), changes, target: { name: 'x' } } as any, guild)!;

test('a new role shows only its notable permissions and who created it', () => {
    const ev = audit(AuditLogEvent.RoleCreate, [{ key: 'permissions', new: (F.Administrator | F.SendMessages | F.ViewChannel).toString() }]);
    assert.equal(ev.details![0], '🔐 **Permissions:** `administrator` + 2 everyday permissions');
    assert.equal(ev.actorLabel, 'Created By');
    assert.equal(audit(AuditLogEvent.RoleDelete, []).actorLabel, 'Deleted By');
});

test('channel permission changes give one clear state per permission', () => {
    const flip = audit(AuditLogEvent.ChannelOverwriteUpdate, [{ key: 'allow', old: '0', new: F.SendMessages.toString() }, { key: 'deny', old: F.SendMessages.toString(), new: '0' }]);
    assert.deepEqual(flip.details!.filter(l => l.startsWith('🔐')), ['🔐 **Permissions:** `send messages` allowed']);
    const create = audit(AuditLogEvent.ChannelOverwriteCreate, [{ key: 'allow', new: F.ViewChannel.toString() }, { key: 'deny', new: F.SendMessages.toString() }]);
    assert.equal(create.details![0], '🔐 **Permissions:** `view channel` allowed, `send messages` denied');
    const removed = audit(AuditLogEvent.ChannelOverwriteDelete, [{ key: 'allow', old: F.ViewChannel.toString() }, { key: 'deny', old: '0' }]);
    assert.equal(removed.details![0], '🔐 **Permissions:** `view channel` reset');
    assert.equal(audit(AuditLogEvent.RoleUpdate, [{ key: 'permissions', old: 'abc', new: '1' }]).details!.length, 0, 'bad data is skipped, not crashed on');
});
