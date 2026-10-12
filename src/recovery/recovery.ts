import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { Store } from '../database/db.js';
import { AppError } from '../errors.js';
import { MAX_RATE_LIMIT_WAIT_MS } from './limits.js';

export const BUSY_MESSAGE = 'A server recovery operation is already running.\nPlease wait for it to finish before starting another one.';
export const COMPONENTS = ['roles', 'categories', 'channels', 'permissions', 'settings'] as const;

export type Component = typeof COMPONENTS[number];

export function selectComponents(values: readonly string[] = ['all']): Component[] {
    if (!values.length || values.some(v => v !== 'all' && !COMPONENTS.includes(v as Component)))
        throw new AppError('VALIDATION_ERROR', 'Select supported restore components.');
    return values.includes('all') ? [...COMPONENTS] : COMPONENTS.filter(v => values.includes(v));
}

export class RecoveryLocks {
    private held = new Set<string>();

    constructor(private store: Store) { }

    busy(id: string) {
        return this.held.has(id) || !!this.store.get('SELECT 1 FROM leases WHERE name=? AND until>?', `recovery:${id}`, Date.now());
    }

    async run<T>(ids: string[], fn: (check: () => void) => Promise<T>): Promise<T> {
        const keys = [...new Set(ids)].sort(), owner = randomUUID();
        const generations = new Map(keys.map(id => [id, this.store.authorization(id)?.generation]));
        this.store.transaction(() => {
            if (keys.some(id => this.busy(id)))
                throw new AppError('VALIDATION_ERROR', BUSY_MESSAGE);
            for (const id of keys) {
                this.store.run('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,until=excluded.until', `recovery:${id}`, owner, Date.now() + 120000);
            }
        });
        for (const id of keys)
            this.held.add(id);
        const check = () => {
            for (const id of keys) {
                const lease = this.store.get('SELECT owner,until FROM leases WHERE name=?', `recovery:${id}`);
                if (lease?.owner !== owner || lease.until <= Date.now())
                    throw new AppError('VALIDATION_ERROR', 'Recovery lock was lost. Stop and review the restore report before retrying.');
                // Check authorization inside the proper guild scope, including after revocation.
                if (!this.store.isAuthorized(id) || this.store.authorization(id)?.generation !== generations.get(id))
                    throw new AppError('AUTHORIZATION_ERROR', 'A participating server is no longer authorized.');
            }
        };
        const heartbeat = setInterval(() => {
            try {
                for (const id of keys)
                    this.store.run('UPDATE leases SET until=? WHERE name=? AND owner=?', Date.now() + 120000, `recovery:${id}`, owner);
            } catch { /* Mutation checks abort if the lease cannot be renewed. */ }
        }, 10000);
        heartbeat.unref();
        try {
            check();
            return await fn(check);
        } finally {
            clearInterval(heartbeat);
            for (const id of keys) {
                this.held.delete(id);
                // Cleanup must succeed even when authorization is revoked mid-operation.
                this.store.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(`recovery:${id}`, owner);
            }
        }
    }
}

/** Retry hint (in ms) from a 429 that discord.js surfaced as an error, or undefined if we shouldn't retry it. */
function surfacedRetryDelay(error: any): number | undefined {
    if ((error?.status ?? error?.httpStatus) !== 429)
        return undefined;
    const seconds = Number(error?.rawError?.retry_after ?? error?.data?.retry_after ?? error?.retry_after);
    const milliseconds = Number(error?.retryAfter);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
        : Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds
            : NaN;
    return Number.isFinite(delay) && delay <= MAX_RATE_LIMIT_WAIT_MS ? delay : undefined;
}

/**
 * Runs restore actions one at a time. discord.js already queues requests per
 * rate-limit bucket, so this only adds an optional gap between actions
 * (SNAPSHOT_ACTION_DELAY_MS, off by default) and retries a 429 that reaches us
 * as an error. Waits longer than MAX_RATE_LIMIT_WAIT_MS are rethrown.
 */
export class ActionPacer {
    private static readonly MAX_RETRIES = 5;
    private lastFinishedAt?: number;

    constructor(readonly delay: number, private check: () => void, private sleep: (ms: number) => Promise<unknown> = wait, private now = Date.now) { }

    async run<T>(action: () => Promise<T>): Promise<T> {
        for (let attempt = 0;; attempt++) {
            this.check();
            await this.waitForGap();
            // The lock or authorization can change while we sleep.
            this.check();
            try {
                const result = await action();
                this.lastFinishedAt = this.now();
                return result;
            } catch (error: any) {
                this.lastFinishedAt = this.now();
                const retryMs = surfacedRetryDelay(error);
                if (retryMs === undefined || attempt >= ActionPacer.MAX_RETRIES)
                    throw error;
                await this.sleep(Math.ceil(retryMs));
            }
        }
    }

    private async waitForGap() {
        if (this.delay <= 0 || this.lastFinishedAt === undefined)
            return;
        const remaining = this.delay - (this.now() - this.lastFinishedAt);
        if (remaining > 0)
            await this.sleep(remaining);
    }
}
