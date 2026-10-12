// Regenerates docs/commands.md from the live command definitions: npx tsx scripts/commands-doc.ts
import { writeFileSync } from 'node:fs';
import { Registry } from '../src/bot/registry.js';
import { HELP_SECTIONS } from '../src/ui/help-ui.js';
import { displayPath, RETIRED, treeJson } from '../src/bot/command-tree.js';
const r = new Registry(); await r.load();
const top = treeJson(r).map((c: any) => `\`/${c.name}\``).join(' ');
const out = ['# Midtown Vanguard commands', '', `Type \`/\` in Discord and pick Midtown Vanguard. The main commands are: ${top}.`, '', 'Grouped the same way as `/help`. Generated from the code by `scripts/commands-doc.ts`.', ''];
for (const section of HELP_SECTIONS) {
    const lines: string[] = [];
    for (const name of section.commands) {
        if (RETIRED.includes(name)) continue;
        const d: any = [...r.commands.values()].find(c => c.data.name === name)?.data;
        if (!d) continue;
        const subs = (d.options ?? []).filter((o: any) => o.type === 1);
        if (!subs.length) lines.push(`| \`${displayPath(name)}\` | ${d.description} |`);
        for (const s of subs) lines.push(`| \`${displayPath(name, s.name)}\` | ${s.description} |`);
    }
    if (lines.length) out.push(`## ${section.emoji} ${section.label}`, '', `_${section.blurb}_`, '', '| Command | What it does |', '| --- | --- |', ...lines, '');
}
writeFileSync('docs/commands.md', out.join('\n'));
console.log('docs/commands.md written');
