import { RANKS } from '../bot/ranks.js';
import { displayPath, RETIRED } from '../bot/command-tree.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, StringSelectMenuBuilder } from 'discord.js';
import { isAdminRestricted, RANK_LABEL, rankName, requiredRank } from '../bot/ranks.js';
import type { Policy } from '../bot/registry.js';
import { Guard } from '../bot/guard.js';
import { defaults, type CommandContext, type Registry } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { embed } from './ui.js';

/** Sections in the order staff need them, and the order of commands inside each section. */
export const HELP_SECTIONS: { key: string; label: string; emoji: string; blurb: string; commands: string[] }[] = [
    { key: 'antinuke', label: 'Anti-nuke', emoji: '🛡️', blurb: 'Stops raids and nukes; manage the whitelist', commands: ['antinuke', 'antinuke-plus', 'trust'] },
    { key: 'moderation', label: 'Moderation', emoji: '🔨', blurb: 'Ban, kick, timeout, cases, notes and appeals', commands: ['moderation', 'tempban', 'softban', 'massban', 'role', 'bans', 'case', 'warnings', 'note', 'appeals', 'nick'] },
    { key: 'security', label: 'Security', emoji: '🚨', blurb: 'Automod, raid mode, lockdowns and scam links', commands: ['security', 'emergency', 'automod', 'raidmode', 'newaccounts', 'lockdown', 'unlock', 'slowmode', 'scam', 'antiping', 'webhooks', 'health'] },
    { key: 'tickets', label: 'Tickets', emoji: '🎫', blurb: 'Support desk: the panel, staff tools and transcripts', commands: ['ticket', 'ticket-setup', 'ticket-panel', 'ticket-type', 'ticket-settings', 'ticket-stats'] },
    { key: 'configuration', label: 'Server Setup', emoji: '⚙️', blurb: 'Staff ranks, welcome, logs and permissions', commands: ['panel', 'staff', 'welcome', 'logs', 'guild-config', 'perm', 'config-history'] },
    { key: 'recovery', label: 'Backups', emoji: '💾', blurb: 'Save and restore the server layout', commands: ['snapshot', 'backup', 'copylayout'] },
    { key: 'verification', label: 'Roblox', emoji: '🎮', blurb: 'Verification, lookups, blacklist and group ranks', commands: ['verify', 'roblox'] },
    { key: 'utility', label: 'Information', emoji: 'ℹ️', blurb: 'Look up users, roles, the server and the bot', commands: ['help', 'userinfo', 'roleinfo', 'server-info', 'bot-info', 'ping', 'ask'] },
    { key: 'developer', label: 'Developer', emoji: '🧰', blurb: 'Bot-wide staff; the risky tools are Developer only', commands: ['dev', 'database', 'autoreact', 'authserver', 'serverauth', 'authorizedservers', 'deauthserver', 'banserver', 'unbanserver', 'genreban', 'ungenreban', 'hardban', 'unhardban', 'netexception'] },
];
/** Who can use a command, shown next to it in /help. */
export function accessLabel(policy:Policy,key:string):string {
    // Developer tools that a bot-wide rank also unlocks (Bot Manager, Overseer) say so.
    if(policy.developerOnly){const need=requiredRank(key);return need===undefined||need>RANKS.supreme?'Developer':`${RANK_LABEL[rankName(need)!]}+`;}
    if(policy.access==='owner')return 'Owner';
    const need=requiredRank(key);
    const perms=policy.requiredPermissions.length?new PermissionsBitField(policy.requiredPermissions).toArray().map(p=>p.replace(/([a-z])([A-Z])/g,'$1 $2')).join(', '):'';
    const rank=need!==undefined?RANK_LABEL[rankName(need)!]:'';
    if(isAdminRestricted(key))return `Owner or ${rank||'Head Admin'}`;
    if(policy.access==='security')return rank?`${rank}+`:'Owner or Head Admin';
    return [rank&&`${rank}+`,perms].filter(Boolean).join(' or ')||'Everyone';
}

const labels:Record<string,string>=Object.fromEntries(HELP_SECTIONS.map(s=>[s.key,s.label]));
const sectionOf=(name:string,fallback:string)=>HELP_SECTIONS.find(s=>s.commands.includes(name))?.key??fallback;
const rank=(name:string)=>{for(const s of HELP_SECTIONS){const n=s.commands.indexOf(name);if(n>=0)return n;}return 999;};

export function helpCategories(ctx:CommandContext,guild:string,user:string) {
    const guard=new Guard(ctx.store), groups=new Map<string,{order:number;text:string}[]>();
    for(const def of ctx.registry.commands.values()) {
        const name=def.data.name;
        if(RETIRED.includes(name))continue;
        const category=sectionOf(name,def.metadata.category);
        const add=(description:string,path='',policy=def.metadata)=>{
            if(!guard.allowed(policy,guild,user,ctx.actor,name,`${name}/${path.replaceAll(' ','/')}`))return;
            const lines=groups.get(category)??[];
            const command=(def.data.type??1)===1?displayPath(name,path):`${name} · context menu`;
            lines.push({order:rank(name)*100+lines.filter(l=>l.order>=rank(name)*100&&l.order<rank(name)*100+100).length,text:`\`${command}\` · ${description} · *${accessLabel(policy,`${name}/${path.replaceAll(' ','/')}`)}*`});groups.set(category,lines);
        };
        const visit=(options:any[],prefix='')=>{
            for(const option of options.filter(o=>o.type<=2)) {
                const path=prefix+option.name;
                if(option.type===2)visit(option.options??[],path+'/');
                else add(option.description,path.replaceAll('/',' '),{...def.metadata,...def.subcommands?.[path]});
            }
        };
        if((def.data as any).options?.some((o:any)=>o.type<=2))visit((def.data as any).options);
        else add((def.data as any).description??'Right-click a member or message to use this action.');
    }
    const sectionRank=(k:string)=>{const n=HELP_SECTIONS.findIndex(s=>s.key===k);return n<0?99:n;};
    return [...groups].sort(([a],[b])=>sectionRank(a)-sectionRank(b)).map(([key,lines])=>({key,label:labels[key]??key,lines:lines.sort((x,y)=>x.order-y.order).map(l=>l.text)}));
}

const PER_PAGE=12;
const section=(key:string)=>HELP_SECTIONS.find(s=>s.key===key);

export function helpPage(ctx:CommandContext,guild:string,user:string,requested='',requestedPage=0) {
    const groups=helpCategories(ctx,guild,user);
    if(!groups.length)return {embeds:[embed('Ghost Vanguard · Commands','No commands are available to your account in this server.')],components:[],allowedMentions:{parse:[] as never[]}};
    const prefix=`helpui:${guild}:${user}:`;
    const menu=new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(prefix+'category').setPlaceholder('Pick a category')
        .addOptions({label:'Overview',value:'home',emoji:'🏠',description:'All categories at a glance',default:!requested||requested==='home'},
            ...groups.map(g=>({label:g.label,value:g.key,emoji:section(g.key)?.emoji,description:`${section(g.key)?.blurb ?? ''} · ${g.lines.length} command${g.lines.length===1?'':'s'}`.slice(0,100),default:g.key===requested}))));
    // Overview: every category with what it is for and how many commands you can use there.
    if(!requested||requested==='home'||!groups.some(g=>g.key===requested)) {
        const total=groups.reduce((n,g)=>n+g.lines.length,0);
        const body=groups.map(g=>`${section(g.key)?.emoji ?? '•'} **${g.label}** · ${g.lines.length}\n-# ${section(g.key)?.blurb ?? ''}`).join('\n');
        return {embeds:[embed('Ghost Vanguard · Commands',`Type \`/\` and pick **Ghost Vanguard** to see the main commands:\n\`/antinuke\` \`/mod\` \`/role\` \`/security\` \`/setup\` \`/recovery\` \`/info\` \`/roblox\` \`/verify\`\n\n${body}\n\n-# ${total} commands available to you · pick a category below`)],components:[menu],allowedMentions:{parse:[] as never[]}};
    }
    const group=groups.find(g=>g.key===requested)!;
    const pages=Math.ceil(group.lines.length/PER_PAGE),page=Math.min(Math.max(0,requestedPage),pages-1);
    return {embeds:[embed(`${section(group.key)?.emoji ?? ''} ${group.label}`.trim(),`${section(group.key)?.blurb ? `-# ${section(group.key)!.blurb}\n\n` : ''}${group.lines.slice(page*PER_PAGE,page*PER_PAGE+PER_PAGE).join('\n')}\n\n-# Page ${page+1}/${pages} · only commands you can use are shown`)],components:[
        menu,
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(prefix+'home:0').setLabel('Overview').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(prefix+group.key+':'+(page-1)).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
            new ButtonBuilder().setCustomId(prefix+group.key+':'+(page+1)).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page===pages-1))
    ],allowedMentions:{parse:[] as never[]}};
}

export function registerHelpControls(registry:Registry) {
    registry.component({prefix:'helpui:',kinds:['button','select'],metadata:{...defaults,requiresAuthorization:false,responseKind:'info'},execute:async(ctx,i)=>{
        const match=/^helpui:(\d{17,20}):(\d{17,20}):([a-z_-]+)(?::(-?\d{1,4}))?$/.exec(i.customId);
        if(!match||match[1]!==i.guildId||match[2]!==i.user.id)throw new AppError('PERMISSION_ERROR','This command directory belongs to another user or server. Run /help.');
        const key=match[3]==='category'?i.values[0]:match[3];
        if(key!=='home'&&!helpCategories(ctx,i.guildId,i.user.id).some(g=>g.key===key))throw new AppError('VALIDATION_ERROR','That category is no longer available to you. Run /help.');
        await i.editReply(helpPage(ctx,i.guildId,i.user.id,key,Number(match[4]??0)));
    }});
}
