import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Recover only a missing database. Never modify the source backup or an existing database. */
export function recoverDatabase(path, directory, notify = () => {}) {
    if (existsSync(path) || !existsSync(directory)) return null;
    const files = readdirSync(directory).filter(file => /^\d+-[\w-]+\.db$/.test(file))
        .sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
    for (const file of files) {
        let bytes;
        try {
            const manifest = JSON.parse(readFileSync(join(directory, file + '.json'), 'utf8'));
            bytes = readFileSync(join(directory, file));
            if (manifest.verified !== true || manifest.status !== 'verified' || manifest.size !== bytes.length
                || !/^[a-f0-9]{64}$/.test(manifest.checksum ?? '')
                || createHash('sha256').update(bytes).digest('hex') !== manifest.checksum)
                throw new Error('Backup metadata or checksum verification failed.');
        } catch {
            notify(`Skipping unusable database backup (${file}).`);
            continue;
        }

        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const staged = path + `.recovery-${randomUUID()}.partial`;
        try {
            writeFileSync(staged, bytes, { flag: 'wx', mode: 0o600 });
            try {
                const check = new DatabaseSync(staged, { readOnly: true });
                try {
                    if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
                        || check.prepare('PRAGMA foreign_key_check').all().length)
                        throw new Error('Backup integrity or foreign-key verification failed.');
                } finally { check.close(); }
            } catch {
                notify(`Skipping unusable database backup (${file}).`);
                continue;
            }
            // Publish atomically without overwriting a database created by another process.
            linkSync(staged, path);
            return { file, at: Number(file.split('-')[0]) };
        } finally {
            if (existsSync(staged)) unlinkSync(staged);
        }
    }
    if (files.length)
        throw new Error('No valid database backup could be recovered. The bot was not started; check the backups before retrying.');
    return null;
}
