import { config } from './config.js';

/**
 * Start-up used to say nothing until the whole banner was ready. On a slow host, or when Discord does
 * not answer, that looked exactly like a bot that was not running. These lines show which step the bot
 * is on, and a reminder repeats every 30 seconds while one step is still going.
 */
export const REMINDER_MS = 30_000;

export interface StartupProgress {
    /** A new step begins. It is printed at once, and a step that runs long is reminded about every 30 seconds. */
    step(text: string, whenSlow?: string): void;
    /** More about the current step, such as "2 of 3". Shown in reminders and never printed on its own. */
    detail(text: string): void;
    /** Start-up is over: no more reminders. */
    done(): void;
}

export function createStartupProgress(print: (line: string) => void = line => console.log(line), options: { json?: boolean; reminderMs?: number } = {}): StartupProgress {
    const json = options.json ?? config.logFormat === 'json';
    const reminderMs = options.reminderMs ?? REMINDER_MS;
    let current: { text: string; whenSlow?: string; detail?: string; since: number } | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let finished = false;

    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    const remind = () => {
        if (!current) return;
        const seconds = Math.round((Date.now() - current.since) / 1000);
        if (json)
            print(JSON.stringify({ timestamp: new Date().toISOString(), event: 'startup_slow', step: current.text, ...(current.detail ? { detail: current.detail } : {}), waitedSeconds: seconds }));
        else
            print(`⚠ Still waiting after ${seconds} s on "${current.text}"${current.detail ? ` (${current.detail})` : ''}.${current.whenSlow ? ` ${current.whenSlow}` : ''}`);
    };

    return {
        step(text, whenSlow) {
            if (finished) return;
            stop();
            current = { text, whenSlow, since: Date.now() };
            if (json) print(JSON.stringify({ timestamp: new Date().toISOString(), event: 'startup_progress', step: text }));
            else print(`› ${text}`);
            timer = setInterval(remind, reminderMs);
            // Reminders must never keep the process alive on their own.
            timer.unref?.();
        },
        detail(text) {
            if (current) current.detail = text;
        },
        done() {
            finished = true;
            current = null;
            stop();
        },
    };
}
