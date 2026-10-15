import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'vg-launch-recovery-'));
    for (const dir of ['dist', 'scripts', 'node_modules/discord.js', 'data/database-backups'])
        mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(new URL('../launch.js', import.meta.url), join(root, 'launch.js'));
    const helper = new URL('../scripts/recover-database.mjs', import.meta.url);
    if (existsSync(helper)) copyFileSync(helper, join(root, 'scripts/recover-database.mjs'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'dist/index.js'), "import { writeFileSync } from 'node:fs'; writeFileSync('bot-started', 'yes'); process.exit(0);");
    const backups = join(root, 'data/database-backups');
    function backup(at: number, value: string, directory = backups) {
        mkdirSync(directory, { recursive: true });
        const path = join(directory, `${at}-${randomUUID()}.db`);
        const db = new DatabaseSync(path);
        db.exec('CREATE TABLE saved(value TEXT); PRAGMA user_version=3;');
        db.prepare('INSERT INTO saved VALUES(?)').run(value);
        db.close();
        const bytes = readFileSync(path);
        writeFileSync(path + '.json', JSON.stringify({ at, status: 'verified', verified: true, size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') }));
        utimesSync(path, at / 1000, at / 1000);
        return path;
    }
    function run(env: Record<string, string> = {}) {
        const inherited = { ...process.env };
        delete inherited.DATABASE_PATH;
        delete inherited.DATABASE_BACKUP_DIRECTORY;
        return spawnSync(process.execPath, ['launch.js'], { cwd: root, encoding: 'utf8', timeout: 5000,
            env: { ...inherited, UPDATE_REPO: '', UPDATE_TOKEN: '', ...env } });
    }
    function restored(path = join(root, 'data/vanguard.db')) {
        const db = new DatabaseSync(path, { readOnly: true });
        try { return db.prepare('SELECT value FROM saved').get()!.value; }
        finally { db.close(); }
    }
    return { root, backups, backup, run, restored, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('launcher skips a corrupt newest backup and restores an older verified database', () => {
    const f = fixture();
    try {
        f.backup(1000, 'good');
        const corrupt = f.backup(2000, 'bad');
        writeFileSync(corrupt, 'corrupt database');
        utimesSync(corrupt, 2, 2);
        const run = f.run();
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(f.restored(), 'good');
        assert.equal(readFileSync(corrupt, 'utf8'), 'corrupt database');
        if (process.platform !== 'win32') assert.equal(statSync(join(f.root, 'data/vanguard.db')).mode & 0o777, 0o600);
    } finally { f.close(); }
});

test('launcher refuses invalid metadata, checksum mismatches and non-SQLite backups without starting empty', () => {
    for (const mode of ['metadata', 'checksum', 'sqlite', 'foreign-key']) {
        const f = fixture();
        try {
            const path = f.backup(1000, 'bad');
            if (mode === 'metadata') writeFileSync(path + '.json', '{}');
            if (mode === 'checksum') writeFileSync(path, 'changed');
            if (mode === 'sqlite' || mode === 'foreign-key') {
                if (mode === 'sqlite') writeFileSync(path, 'not SQLite');
                else {
                    const db = new DatabaseSync(path);
                    db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id REFERENCES parent(id)); INSERT INTO child VALUES(42);');
                    db.close();
                }
                const bytes = readFileSync(path);
                writeFileSync(path + '.json', JSON.stringify({ at: 1000, status: 'verified', verified: true, size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') }));
            }
            const run = f.run();
            assert.notEqual(run.status, 0, mode);
            assert.equal(existsSync(join(f.root, 'data/vanguard.db')), false, mode);
            assert.equal(existsSync(join(f.root, 'bot-started')), false, mode);
            assert.equal(readdirSync(join(f.root, 'data')).some(name => name.includes('.recovery-')), false, mode);
        } finally { f.close(); }
    }
});

test('launcher selects backups by creation timestamp even when copying changes file modification times', () => {
    const f = fixture();
    try {
        const old = f.backup(1000, 'old');
        f.backup(2000, 'new');
        utimesSync(old, 5, 5);
        const run = f.run();
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(f.restored(), 'new');
    } finally { f.close(); }
});

test('launcher recovery honors configured database and backup locations from .env', () => {
    const f = fixture();
    try {
        f.backup(1000, 'custom', join(f.root, 'custom/backups'));
        f.backup(2000, 'wrong default');
        writeFileSync(join(f.root, '.env'), 'DATABASE_PATH=./custom/state/bot.db\nDATABASE_BACKUP_DIRECTORY=./custom/backups\n');
        const run = f.run();
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(f.restored(join(f.root, 'custom/state/bot.db')), 'custom');
        assert.equal(existsSync(join(f.root, 'data/vanguard.db')), false);
    } finally { f.close(); }
});

test('launcher preserves an existing database and allows a genuinely fresh installation', () => {
    const f = fixture();
    try {
        assert.equal(f.run().status, 0);
        const original = f.backup(1000, 'existing');
        copyFileSync(original, join(f.root, 'data/vanguard.db'));
        const before = readFileSync(join(f.root, 'data/vanguard.db'));
        f.backup(2000, 'newer');
        assert.equal(f.run().status, 0);
        assert.deepEqual(readFileSync(join(f.root, 'data/vanguard.db')), before);
    } finally { f.close(); }
});
