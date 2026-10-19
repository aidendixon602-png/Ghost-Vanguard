import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, copyFile, rename, unlink, mkdir, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const args=process.argv.slice(2), option=name=>args[args.indexOf(name)+1];
const id=args.includes('--id')?option('--id'):null;
if(!id || !/^[a-f0-9-]{36}$/i.test(id) || option('--confirm')!==`RESTORE-${id}`)throw Error('Stop the bot first. Usage: npm run database:restore -- --id BACKUP_UUID --confirm RESTORE-BACKUP_UUID');
const path=resolve(process.env.DATABASE_PATH||'./data/vanguard.db'),directory=resolve(process.env.DATABASE_BACKUP_DIRECTORY||'./data/database-backups');
let manifestName,manifest;
for(const name of await readdir(directory)){
    if(!name.endsWith('.db.json'))continue;
    try{const value=JSON.parse(await readFile(join(directory,name),'utf8'));if(value.id===id){manifestName=name;manifest=value;break;}}catch{}
}
if(!manifestName||!manifest)throw Error('Backup metadata not found.');
const source=join(directory,manifestName.slice(0,-5));
if(manifest.id!==id || !manifest.verified || manifest.status!=='verified')throw Error('Backup is not marked verified.');
const bytes=await readFile(source);if(createHash('sha256').update(bytes).digest('hex')!==manifest.checksum)throw Error('Backup checksum mismatch.');
const check=new DatabaseSync(source,{readOnly:true});
try{if(check.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok' || check.prepare('PRAGMA foreign_key_check').all().length)throw Error('Backup integrity or foreign-key verification failed.');}finally{check.close();}
let live;
try{live=new DatabaseSync(path,{readOnly:true});if(live.prepare("SELECT 1 FROM sqlite_master WHERE name='leases'").get()&&live.prepare('SELECT 1 FROM leases WHERE name=? AND until>?').get('bot',Date.now()))throw Error('Bot is still running or its process lease has not expired. Stop it and wait 30 seconds.');}
catch(error){if(!args.includes('--allow-corrupt') || String(error).includes('still running'))throw error;console.warn('Restoring over an unreadable database; --allow-corrupt assumes the bot is stopped.');}
finally{live?.close();}
await mkdir(dirname(path),{recursive:true});
const staged=path+'.restore-'+randomUUID(),rollback=path+'.before-restore-'+Date.now();
await copyFile(source,staged);await chmod(staged,0o600);
// Verify and clear runtime leases on the staged copy before touching the live files.
const restored=new DatabaseSync(staged);
try{restored.exec('DELETE FROM leases;');if(restored.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok' || restored.prepare('PRAGMA foreign_key_check').all().length)throw Error('Staged database failed verification.');}
finally{restored.close();}
const moved=[];
try{
    for(const suffix of ['', '-wal', '-shm']){
        try{await rename(path+suffix,rollback+suffix);moved.push(suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    await rename(staged,path);
}catch(error){
    for(const suffix of moved.reverse())await rename(rollback+suffix,path+suffix).catch(()=>{});
    await unlink(staged).catch(()=>{});throw error;
}
console.log(`Database restored from verified backup ${id}. Previous database retained at ${rollback}. Start the bot normally.`);
