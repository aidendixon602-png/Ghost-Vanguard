import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Registry } from '../../dist/bot/registry.js';
import { registerComponents } from '../../dist/ui/components.js';
import { VERSION } from '../../dist/config.js';
let count=0;
async function walk(path='src',relative='') {
    for(const item of await readdir(path,{withFileTypes:true})) {
        const file=join(path,item.name),rel=join(relative,item.name);
        if(item.isDirectory())await walk(file,rel);
        else if(item.name.endsWith('.ts')&&!item.name.endsWith('.d.ts')) {
            await access(join('dist',rel.replace(/\.ts$/,'.js')));count++;
        }
    }
}
await walk();
const registry=new Registry();await registry.load();registerComponents(registry);
if(registry.commands.has('1:csb'))throw new Error('The removed /csb command is still present; delete the old dist/ folder and extract again.');
console.log(`Vanguard ${VERSION}: ${count} compiled modules, ${registry.commands.size} commands, ${registry.components.length} controls. No live API requests were made.`);
