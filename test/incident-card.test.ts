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
    assert.match(incidentCard({ ...base, rule: rule('mass_ban'), result: 'Executor cannot be banned; check role hierarchy.' }).toJSON().description!, /could \*\*not\*\* be banned/);
    assert.match(incidentCard({ ...base, mode: 'observe', rule: rule('mass_kick'), result: 'Observed only; no Discord actions taken.' }).toJSON().description!, /would have been \*\*banned\*\*.*watch-only/);
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
