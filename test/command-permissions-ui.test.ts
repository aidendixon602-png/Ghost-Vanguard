import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder, Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Registry, defineCommand, defaults } from '../src/bot/registry.js';
import { authorize } from './helpers.js';
import { helpCategories, helpPage } from '../src/ui/help-ui.js';
import { confirmDanger, registerDangerConfirm } from '../src/ui/danger-ui.js';
import { Guard } from '../src/bot/guard.js';

function fixture() {
 const store=new Store(':memory:');authorize(store);const registry=new Registry();
 const member:any={id:'moderator',guild:{id:'g',ownerId:'owner'},permissions:new PermissionsBitField(PermissionFlagsBits.BanMembers),roles:{cache:new Collection()}};
 const ctx:any={store,registry,actor:member,lifecycle:{isReady:()=>true},policy:{...defaults,category:'moderation',requiredPermissions:[PermissionFlagsBits.BanMembers],botPermissions:[PermissionFlagsBits.BanMembers]},actionKey:'moderation/ban'};
 let reply:any;const i:any={id:'i',inCachedGuild:()=>true,guildId:'g',user:{id:'moderator'},member,guild:{members:{me:{permissions:new PermissionsBitField(PermissionFlagsBits.BanMembers)},fetch:async()=>member}},editReply:async(p:any)=>{reply=p;}};
 return {store,registry,ctx,i,member,getReply:()=>reply};
}
test('moderator can confirm their permitted ban, but permission revocation blocks execution',async()=>{
 const {store,registry,ctx,i,member,getReply}=fixture();try {
 registerDangerConfirm(registry);let ran=0;const spec={title:'Ban',summary:'Target',consequences:['Ban target'],label:'Ban',reversal:'Unban',run:async()=>{ran++;return 'Done';}};
 await confirmDanger(ctx,i,spec);i.customId=getReply().components[0].components[0].data.custom_id;
 await registry.components.find(c=>c.prefix==='dangerconfirm:')!.execute(ctx,i);assert.equal(ran,1);
 await confirmDanger(ctx,i,spec);i.customId=getReply().components[0].components[0].data.custom_id;member.permissions=new PermissionsBitField();
 await assert.rejects(registry.components.find(c=>c.prefix==='dangerconfirm:')!.execute(ctx,i),/permission/);assert.equal(ran,1);
 }finally{store.close();}
});
test('help categories show allowed subcommands and omit disabled commands and inaccessible actions',()=>{
 const {store,registry,ctx,member}=fixture();try {
 registry.add(defineCommand(new SlashCommandBuilder().setName('tools').setDescription('Tools').addSubcommand(o=>o.setName('ban').setDescription('Ban')).addSubcommand(o=>o.setName('kick').setDescription('Kick')),{category:'moderation'},async()=>{}, {subcommands:{ban:{requiredPermissions:[PermissionFlagsBits.BanMembers]},kick:{requiredPermissions:[PermissionFlagsBits.KickMembers]}}}),'test');
 const groups=helpCategories(ctx,'g',member.id);assert.equal(groups[0]!.lines.length,1);assert.match(groups[0]!.lines[0]!,/tools ban/);
 const home=helpPage(ctx,'g',member.id);const detail=helpPage(ctx,'g',member.id,'moderation');
 assert.equal(home.components.length,1,'overview: category menu');assert.equal(detail.components.length,2,'category: menu and page buttons');
 assert.match(home.embeds[0]!.data.description!,/Choose a category/);assert.doesNotMatch(home.embeds[0]!.data.description!,/\/dev|\/genreban/);
 assert.match(detail.embeds[0]!.data.description!,/tools ban/);assert.doesNotMatch(detail.embeds[0]!.data.description!,/tools kick/);
 assert.deepEqual(detail.components[1]!.toJSON().components.map((b:any)=>b.label),['Overview','Previous','Next']);
 store.run('INSERT INTO command_settings(guild_id,command,enabled,cooldown_ms) VALUES(?,?,?,?)','g','tools',0,0);assert.equal(helpCategories(ctx,'g',member.id).length,0);
 }finally{store.close();}
});
test('anti-nuke buttons honor the parent command disable setting',async()=>{
 const {store,i,member}=fixture();try {
 store.run('INSERT INTO command_settings(guild_id,command,enabled,cooldown_ms) VALUES(?,?,?,?)','g','antinuke',0,0);
 // The anti-nuke panel is Server Owner and Developers only, so only they reach the on/off check.
 await assert.rejects(new Guard(store).check(i,{...defaults},'anpanel/',false),/permission/i);
 member.id='owner';member.guild={id:'g',ownerId:'owner'};i.user={id:'owner'};
 await assert.rejects(new Guard(store).check(i,{...defaults},'anpanel/',false),/disabled/);
 }finally{store.close();}
});

test('archive deletion requires server owner access even for a ranked Admin', async () => {
 const {store,ctx,member}=fixture();
 try {
  const {default:logs}=await import('../src/commands/configuration/logs.js');
  const policy={...logs.metadata,...logs.subcommands?.['cleanup-archive']};
  member.permissions=new PermissionsBitField(PermissionFlagsBits.Administrator);
  const guard=new Guard(store);
  assert.equal(guard.allowed(policy,'g',member.id,member,'logs','logs/cleanup-archive'),false);
  member.id='owner';
  assert.equal(guard.allowed(policy,'g','owner',member,'logs','logs/cleanup-archive'),true);
 }finally{store.close();}
});
