import { config } from './config.js';
/**
 * Start-up used to say nothing until the whole banner was ready. On a slow host, or when Discord does
 * not answer, that looked exactly like a bot that was not running. These lines show which step the bot
 * is on, and a reminder repeats every 30 seconds while one step is still going.
 */
export const REMINDER_MS = 30_000;
export function createStartupProgress(print = line => console.log(line), options = {}) {
    const json = options.json ?? config.logFormat === 'json';
    const reminderMs = options.reminderMs ?? REMINDER_MS;
    let current = null;
    let timer = null;
    let finished = false;
    const stop = () => { if (timer)
        clearInterval(timer); timer = null; };
    const remind = () => {
        if (!current)
            return;
        const seconds = Math.round((Date.now() - current.since) / 1000);
        if (json)
            print(JSON.stringify({ timestamp: new Date().toISOString(), event: 'startup_slow', step: current.text, ...(current.detail ? { detail: current.detail } : {}), waitedSeconds: seconds }));
        else
            print(`⚠ Still waiting after ${seconds} s on "${current.text}"${current.detail ? ` (${current.detail})` : ''}.${current.whenSlow ? ` ${current.whenSlow}` : ''}`);
    };
    return {
        step(text, whenSlow) {
            if (finished)
                return;
            stop();
            current = { text, whenSlow, since: Date.now() };
            if (json)
                print(JSON.stringify({ timestamp: new Date().toISOString(), event: 'startup_progress', step: text }));
            else
                print(`› ${text}`);
            timer = setInterval(remind, reminderMs);
            // Reminders must never keep the process alive on their own.
            timer.unref?.();
        },
        detail(text) {
            if (current)
                current.detail = text;
        },
        done() {
            finished = true;
            current = null;
            stop();
        },
    };
}
