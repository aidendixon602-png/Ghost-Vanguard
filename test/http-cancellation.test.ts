import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { HttpReads } from '../src/integrations/http.js';

test('revocation rejects queued reads before unrelated requests finish', async () => {
    const original = fetch;
    const releases: (() => void)[] = [];
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        await new Promise<void>(resolve => releases.push(resolve));
        return Response.json({});
    };
    const h = new HttpReads();
    const blockers = Array.from({ length: 4 }, (_, n) => h.get(`other:${n}`, 'https://example.test'));
    let canceled = false;
    const queued = h.get('revoked:profile', 'https://example.test').then(
        () => assert.fail('Revoked read succeeded'),
        error => { assert.equal(error.name, 'AbortError'); canceled = true; },
    );
    try {
        h.clearPrefix('revoked:');
        await setImmediate();
        assert.equal(canceled, true);
        assert.equal(calls, 4);
    } finally {
        releases.forEach(release => release());
        await Promise.allSettled([...blockers, queued]);
        globalThis.fetch = original;
    }
});

test('fresh reads replace revoked requests and retain their own cancellation handle', async () => {
    const original = fetch;
    const releases: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    // Delay completion even after abort to exercise overlapping request cleanup.
    globalThis.fetch = async (_url, options) => {
        signals.push(options!.signal!);
        await new Promise<void>(resolve => releases.push(resolve));
        return Response.json({});
    };
    const h = new HttpReads();
    const first = h.get('g:profile', 'https://example.test');
    const firstResult = assert.rejects(first, { name: 'AbortError' });
    h.clearPrefix('g:');
    const second = h.get('g:profile', 'https://example.test');
    const secondResult = assert.rejects(second, { name: 'AbortError' });
    try {
        assert.equal(signals.length, 2);
        releases[0]!();
        await firstResult;
        h.clearPrefix('g:');
        assert.equal(signals[1]!.aborted, true);
    } finally {
        h.clearPrefix('g:');
        releases.forEach(release => release());
        await Promise.allSettled([firstResult, secondResult]);
        globalThis.fetch = original;
    }
});
