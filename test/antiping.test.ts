import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { processStaffMention } from '../src/security/antiping.js';

test('native mention protection replies before deleting and ignores duplicate events', async () => {
    const seen = new Set(), calls: string[] = [];
    const ctx: any = { store: { assertAuthorized() { }, get() {
                return { enabled: 1, rule_id: 'native-public' };
            }, all() {
                return [{ kind: 'user', target_id: '123456789012345678' }];
            }, observe(id: string) {
                if (seen.has(id))
                    return false;
                seen.add(id);
                return true;
            } }, security: { queue: { run: async (_: any, fn: any) => fn() }, trusted: () => false }, logs: { push() { } }, client: {} };
    const m: any = { id: 'message', guild: { id: 'guild', members: { cache: new Collection() } }, author: { id: 'actor', bot: false }, member: { roles: { cache: new Collection() } }, mentions: { roles: new Collection(), users: new Collection([['123456789012345678', {}]]), members: new Collection() }, reply: async (p: any) => {
            assert.equal(p.embeds[0].data.title, '🔕 Mentions Disabled');
            assert.equal(p.allowedMentions.repliedUser, false);
            calls.push('reply');
        }, delete: async () => calls.push('delete'), channelId: 'channel' };
    await processStaffMention(ctx, m);
    await processStaffMention(ctx, m);
    assert.deepEqual(calls, ['reply', 'delete']);
    ctx.security.trusted = () => true;
    m.id = 'trusted';
    await processStaffMention(ctx, m);
    assert.equal(calls.length, 2);
});
