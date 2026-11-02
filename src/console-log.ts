import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redact } from './audit/redact.js';
import { PRODUCT_NAME } from './branding.js';
import { config, VERSION } from './config.js';

/**
 * A copy of everything the bot prints, kept where it can be read without the host's console tab:
 * the newest lines in memory for `/dev logs`, and a file next to the database for the host's file
 * manager. The console itself is untouched; every write still goes to it exactly as before.
 *
 * startup.ts imports this first, so it only pulls in modules that are already loaded by then.
 */

/** Colour codes, cursor moves and window titles: what a terminal acts on, not text anyone needs to read. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const MAX_LINE = 2000;

export interface ConsoleLine { at: number; text: string }

export interface ConsoleLogOptions {
    /** Where lines are also kept on disk. Leave out to keep them in memory only. */
    file?: string;
    /** Newest lines kept in memory. */
    maxLines?: number;
    /** The file moves to `<name>.old.log` once it grows past this many bytes. */
    maxBytes?: number;
    /** First line written to the file, to tell one run from the next. */
    header?: string;
    /** Exact values to mask, asked for on every line so a changed key is covered too. */
    secrets?: () => (string | undefined)[];
    now?: () => number;
}

interface Hookable { write: (...args: any[]) => boolean }

export class ConsoleLog {
    readonly startedAt: number;
    private readonly ring: ConsoleLine[] = [];
    private readonly queue: string[] = [];
    private readonly partial = new Map<string, string>();
    private readonly decoders = new Map<string, StringDecoder>();
    private readonly undo: (() => void)[] = [];
    private timer: NodeJS.Timeout | null = null;
    private toFile: boolean;

    constructor(private readonly options: ConsoleLogOptions = {}) {
        this.startedAt = (options.now ?? Date.now)();
        this.toFile = !!options.file;
        if (this.toFile && options.header) this.queue.push(options.header);
    }

    /** Copy everything written to `stream` into the log. The stream keeps working exactly as before. */
    attach(stream: Hookable, source: string) {
        const original = stream.write;
        const log = this;
        stream.write = function (chunk: unknown, ...rest: unknown[]) {
            try { log.write(source, chunk); } catch { /* the log must never break the console */ }
            return original.call(stream, chunk, ...rest);
        };
        const hooked = stream.write;
        this.undo.push(() => { if (stream.write === hooked) stream.write = original; });
    }

    /** Take text as it was written. A line that has no newline yet waits for the rest of it. */
    write(source: string, chunk: unknown) {
        let text: string;
        if (typeof chunk === 'string') text = chunk;
        else if (chunk instanceof Uint8Array) {
            const decoder = this.decoders.get(source) ?? new StringDecoder('utf8');
            this.decoders.set(source, decoder);
            text = decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } else return;
        const parts = ((this.partial.get(source) ?? '') + text).split('\n');
        this.partial.set(source, parts.pop() ?? '');
        for (const part of parts) this.add(part);
        if (this.queue.length >= 200) this.flush();
        else if (this.toFile && this.queue.length && !this.timer) {
            this.timer = setTimeout(() => this.flush(), 1000);
            this.timer.unref();
        }
    }

    private add(raw: string) {
        // A progress line that redraws itself with \r shows only its last state.
        const text = raw.replace(/\r+$/, '').split('\r').pop()!.replace(ANSI, '').trimEnd();
        if (!text.trim()) return;
        let line = text;
        for (const secret of this.options.secrets?.() ?? []) if (secret && secret.length >= 8) line = line.split(secret).join('[hidden]');
        line = redact(line);
        if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE - 1)}…`;
        const at = (this.options.now ?? Date.now)();
        this.ring.push({ at, text: line });
        if (this.ring.length > (this.options.maxLines ?? 500)) this.ring.shift();
        if (this.toFile) this.queue.push(`${stamp(at)} ${line}`);
    }

    /** The newest `count` lines, oldest first. */
    tail(count: number): ConsoleLine[] {
        return count > 0 ? this.ring.slice(-count) : [];
    }

    /** Write the waiting lines to the file now. `final` also takes a last line that never got its newline. */
    flush(final = false) {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (final) for (const [source, rest] of this.partial) { this.partial.set(source, ''); if (rest) this.add(rest); }
        const file = this.options.file;
        if (!this.queue.length || !this.toFile || !file) { this.queue.length = 0; return; }
        const text = this.queue.splice(0).join('\n') + '\n';
        try {
            mkdirSync(dirname(file), { recursive: true });
            if (existsSync(file) && statSync(file).size > (this.options.maxBytes ?? 1_000_000))
                renameSync(file, file.replace(/(\.log)?$/, '.old.log'));
            appendFileSync(file, text);
        } catch {
            // A full disk or a read-only folder only costs the file; the console and /dev logs carry on.
            this.toFile = false;
        }
    }

    /** Put every hooked stream back the way it was. */
    detach() {
        for (const undo of this.undo.splice(0)) undo();
        this.flush(true);
    }

    /** The file lines are being kept in, or null when there is none (or it stopped working). */
    get filePath(): string | null { return this.toFile ? this.options.file ?? null : null; }
}

/** `2026-11-02 02:14:33`, in UTC. */
export const stamp = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');

/** The lines as `/dev logs` shows them: UTC time, then the text. */
export const formatTail = (lines: ConsoleLine[]) => lines.map(l => `${new Date(l.at).toISOString().slice(11, 19)} ${l.text}`).join('\n');

let active: ConsoleLog | null = null;
let onExit: (() => void) | null = null;
export const currentConsoleLog = () => active;

/** Start copying the console. Call it once, first thing; a second call returns the same log. */
export function startConsoleLog(streams: { stdout: Hookable; stderr: Hookable } = { stdout: process.stdout, stderr: process.stderr }, file = join(dirname(config.dbPath), 'console.log')): ConsoleLog {
    if (active) return active;
    const log = new ConsoleLog({
        file,
        header: `===== ${PRODUCT_NAME} v${VERSION} started ${stamp(Date.now())} UTC, process ${process.pid} =====`,
        secrets: () => [config.token, config.roverKey, config.bloxlinkKey, config.openaiKey],
    });
    log.attach(streams.stdout, 'out');
    log.attach(streams.stderr, 'err');
    onExit = () => log.flush(true);
    process.once('exit', onExit);
    active = log;
    return log;
}

/** For tests: stop copying and forget the log. */
export function stopConsoleLog() {
    if (onExit) process.removeListener('exit', onExit);
    onExit = null;
    active?.detach();
    active = null;
}
