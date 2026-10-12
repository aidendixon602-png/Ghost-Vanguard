import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpReads } from '../src/integrations/http.js';

test('identical reads deduplicate, cache successful responses and return independent bodies', async () => {
    const original = fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return Response.json({ id: 123 });
    };
    try {
        const h = new HttpReads();
        const [a, b] = await Promise.all([h.get('g:profile', 'https://example.test'), h.get('g:profile', 'https://example.test')]);
        assert.deepEqual(await a.json(), { id: 123 });
        assert.deepEqual(await b.json(), { id: 123 });
        await h.get('g:profile', 'https://example.test');
        assert.equal(calls, 1);
        h.clearPrefix('g:');
        await h.get('g:profile', 'https://example.test');
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = original;
    }
});

test('integration concurrency never exceeds four', async () => {
    const original = fetch;
    let active = 0, max = 0;
    globalThis.fetch = async () => {
        active++;
        max = Math.max(max, active);
        await new Promise<void>(resolve => setImmediate(resolve));
        active--;
        return Response.json({});
    };
    try {
        const h = new HttpReads();
        await Promise.all(Array.from({ length: 12 }, (_, n) => h.get(`g:${n}`, 'https://example.test')));
        assert.equal(max, 4);
    } finally {
        globalThis.fetch = original;
    }
});

test('revocation cancels in-flight server integration reads', async () => {
    const original = fetch;
    globalThis.fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('canceled'))));
    try {
        const h = new HttpReads(), pending = h.get('g:provider', 'https://example.test');
        h.clearPrefix('g:');
        await assert.rejects(pending, /canceled/);
    } finally {
        globalThis.fetch = original;
    }
});
