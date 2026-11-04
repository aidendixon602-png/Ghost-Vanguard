import { config } from './config.js';
/**
 * Start-up used to say nothing until the whole banner was ready. On a slow host, or when Discord does
 * not answer, that looked exactly like a bot that was not running. These lines show which step the bot
 * is on, and a reminder repeats every 30 seconds while one step is still going.
 */
export const REMINDER_MS = 30_000;
/**
 * The bot used to stop without a word, so a restart looked the same whether it was asked to stop,
 * crashed or was killed. These two lines are the trail: why it is stopping, then that it finished.
 * A kill (SIGKILL, out of memory) prints neither, which is itself the answer.
 */
export function announceStopping(reason, print = line => console.log(line), json = config.logFormat === 'json') {
    print(json ? JSON.stringify({ timestamp: new Date().toISOString(), event: 'shutdown_started', reason }) : `› Stopping: ${reason}`);
}
export function announceStopped(code, print = line => console.log(line), json = config.logFormat === 'json') {
    print(json ? JSON.stringify({ timestamp: new Date().toISOString(), event: 'shutdown_finished', code }) : `› Stopped · exit code ${code}`);
}
/**
 * Resolves once what was already written to the given streams has been handed over, or after `timeoutMs`,
 * whichever comes first. process.exit() drops writes that are still queued, and on a POSIX pipe the
 * reader may be slow to empty it, so the last line could go missing. Never rejects.
 */
export function drained(streams = [process.stdout, process.stderr], timeoutMs = 1000) {
    return new Promise(resolve => {
        let waiting = streams.length;
        if (!waiting)
            return resolve();
        const timer = setTimeout(resolve, timeoutMs);
        const one = () => { if (--waiting === 0) {
            clearTimeout(timer);
            resolve();
        } };
        for (const stream of streams) {
            try {
                stream.write('', one);
            }
            catch {
                one();
            }
        }
    });
}
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
