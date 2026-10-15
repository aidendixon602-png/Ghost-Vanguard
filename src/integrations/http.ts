import { setTimeout as pause } from 'node:timers/promises';
// Only idempotent GETs are retried. Discord mutation retries are owned by discord.js.

export class HttpReads {
    private active = 0;
    private controllers = new Map<string, AbortController>();
    private waiters: (() => void)[] = [];
    private inflight = new Map<string, Promise<Response>>();
    private cache = new Map<string, {
        until: number;
        response: Response;
    }>();

    clearPrefix(prefix: string) {
        for (const key of this.cache.keys())
            if (key.startsWith(prefix))
                this.cache.delete(key);
        for (const [key, controller] of this.controllers)
            if (key.startsWith(prefix)) {
                this.inflight.delete(key);
                this.controllers.delete(key);
                controller.abort();
            }
    }

    async get(key: string, url: string, headers?: Record<string, string>): Promise<Response> {
        for (const [key, row] of this.cache)
            if (row.until <= Date.now())
                this.cache.delete(key);
        const cached = this.cache.get(key);
        if (cached && cached.until > Date.now())
            return cached.response.clone();
        const existing = this.inflight.get(key);
        if (existing)
            return (await existing).clone();
        const controller = new AbortController();
        this.controllers.set(key, controller);
        const run = async () => {
            if (this.active >= 4) {
                if (this.waiters.length >= 100)
                    throw new Error('Integration request queue is full');
                await new Promise<void>((resolve, reject) => {
                    const ready = () => {
                        controller.signal.removeEventListener('abort', cancel);
                        resolve();
                    };
                    const cancel = () => {
                        const index = this.waiters.indexOf(ready);
                        if (index >= 0)
                            this.waiters.splice(index, 1);
                        reject(controller.signal.reason);
                    };
                    controller.signal.throwIfAborted();
                    this.waiters.push(ready);
                    controller.signal.addEventListener('abort', cancel, { once: true });
                });
            } else
                this.active++;
            try {
                let response!: Response;
                for (let attempt = 0; attempt < 3; attempt++) {
                    controller.signal.throwIfAborted();
                    response = await fetch(url, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
                    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2)
                        break;
                    const retryAfter = Number(response.headers.get('retry-after'));
                    const ms = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 200;
                    // A long provider backoff is handled by the caller's circuit breaker.
                    if (ms > 10000)
                        break;
                    await response.body?.cancel();
                    await pause(ms, undefined, { signal: controller.signal });
                }
                controller.signal.throwIfAborted();
                if (response.ok || response.status === 404) {
                    if (this.cache.size >= 5000)
                        this.cache.delete(this.cache.keys().next().value!);
                    this.cache.set(key, { until: Date.now() + 30000, response: response.clone() });
                }
                return response;
            } finally {
                const next = this.waiters.shift();
                if (next)
                    next();
                else
                    this.active--;
            }
        };
        const pending = run();
        this.inflight.set(key, pending);
        try {
            return (await pending).clone();
        } finally {
            // An older canceled request may finish after a replacement has started.
            if (this.controllers.get(key) === controller) {
                this.inflight.delete(key);
                this.controllers.delete(key);
            }
        }
    }
}
