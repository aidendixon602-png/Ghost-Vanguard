import test from 'node:test';
import assert from 'node:assert/strict';
import {AuditLogEvent,Collection,PermissionFlagsBits} from 'discord.js';
import {RULES,escalationAdded} from '../src/core.js';
import {Security} from '../src/security/security.js';
import {Store} from '../src/database/db.js';
import {Guard} from '../src/bot/guard.js';
import {authorize} from './helpers.js';
import antinuke from '../src/commands/antinuke/antinuke.js';
import { antinukeStatus } from '../src/ui/antinuke-status.js';

test('status embed shows per-server rule limits and only active anti-nuke bypasses in this guild',()=>{
 const {store}=fixture();
 try {
  const s=store.settings('g');s.rules.mass_ban={count:7,seconds:120};store.save(s);
  store.grant('g','111','trust','owner');store.grant('g','222','bot','owner');store.grant('g','333','trust','owner');
  store.run('UPDATE grants SET expires=? WHERE guild_id=? AND user_id=?',Date.now()-1,'g','333');
  const status=antinukeStatus(store,'g').toJSON();
  assert.equal(status.title,'Antinuke Status');assert.equal(status.color,0x57F287);
  assert.match(status.description!,/`Ban` – \*\*7 in 120s → strip\*\* `\[revert\]`/);assert.match(status.description!,/Tune thresholds or turn a rule off with/);
  assert.match(status.description!,/<@111>/);assert.doesNotMatch(status.description!,/<@222>|<@333>/);
  assert.match(status.description!,/manage_webhooks/);assert.ok(status.description!.length<=3900);
  s.enabled=false;store.save(s);assert.equal(antinukeStatus(store,'g').toJSON().color,0xED4245);
  s.enabled=true;s.mode='observe';store.save(s);assert.match(antinukeStatus(store,'g').toJSON().description!,/observe mode/);
 } finally {store.close();}
});

test('status and rules commands send the status embed without pinging trusted users',async()=>{
 const {store}=fixture();
 try {
  for(const sub of ['status','rules']) {
   let reply:any;await antinuke.execute({store,actor:{id:'owner'}} as any,{guildId:'g',user:{id:'owner'},options:{getSubcommand:()=>sub},editReply:async(value:any)=>{reply=value;}} as any);
   assert.equal(reply.embeds[0].toJSON().title,'Antinuke Status');assert.deepEqual(reply.allowedMentions,{parse:[]});
  }
 } finally {store.close();}
});

test('/antinuke rule saves per-server thresholds and toggles; reset restores shipped defaults',async()=>{
 const {store}=fixture();
 try {
  const logs:any[]=[];
  const options=(sub:string,threshold:number|null,enabled:boolean|null)=>({getSubcommand:()=>sub,getString:()=> 'mass_ban',getInteger:(name:string)=>name==='threshold'?threshold:null,getBoolean:()=>enabled});
  const ctx:any={store,logs:{push:(_guild:string,card:any)=>logs.push(card)}};
  await antinuke.execute(ctx,{guildId:'g',user:{id:'owner'},options:options('rule',9,false)} as any);
  assert.deepEqual(store.settings('g').rules.mass_ban,{count:9,seconds:60,enabled:false});
  assert.equal(logs.at(-1).toJSON().title,'Anti-nuke rule updated');
  await antinuke.execute(ctx,{guildId:'g',user:{id:'owner'},options:options('reset',null,null)} as any);
  assert.equal(store.settings('g').rules.mass_ban,undefined);
  assert.equal(store.settings('g').rules.bot_add,undefined,'reset only affects the selected rule');
 } finally {store.close();}
});

test('Discord Administrators can read anti-nuke status/check and enable enforcement, but cannot disable it on that permission alone',()=>{
 const {store}=fixture();
 try {
  const member:any={id:'admin',guild:{id:'g',ownerId:'different-owner'},roles:{cache:new Collection()},permissions:{has:(permission:bigint)=>permission===PermissionFlagsBits.Administrator}};
  const guard=new Guard(store);const policy=antinuke.metadata;
  assert.equal(guard.allowed(policy,'g','admin',member,undefined,'antinuke/status'),true);
  assert.equal(guard.allowed(policy,'g','admin',member,undefined,'antinuke/check'),true);
  assert.equal(guard.allowed(policy,'g','admin',member,undefined,'antinuke/enable'),true);
  assert.equal(guard.allowed(policy,'g','admin',member,undefined,'antinuke/disable'),false,'weakening protection remains restricted');
 } finally {store.close();}
});

function fixture(mode:'observe'|'enforce'='enforce') {
 const store=new Store(':memory:');authorize(store);
 const s=store.settings('g');s.enabled=true;s.mode=mode;store.save(s);
 const security=new Security(store,{push:()=>{}} as any);
 const guild:any={id:'g',ownerId:'owner',client:{user:{id:'vanguard'}}};
 const entry=(id:string,targetId:string,action=AuditLogEvent.MemberBanAdd,changes:any[]=[],at=Date.now())=>({id,targetId,action,changes,executorId:'actor',createdTimestamp:at} as any);
 return {store,security,guild,entry};
}

test('startup preserves per-server rule settings for an already-enforcing server',async()=>{
 const {store}=fixture();
 try {
  const settings=store.settings('g');settings.enabled=true;settings.mode='enforce';settings.logChannelId='log';settings.rules.mass_ban={count:9,seconds:90,enabled:false};store.save(settings);
  const {guild}=readinessGuild({id:'g'});
  assert.equal(await applyDefaultAntinuke(store,guild,{push:()=>{}} as any),'unchanged');
  assert.deepEqual(store.settings('g').rules.mass_ban,{count:9,seconds:90,enabled:false});
 } finally {store.close();}
});

test('the twelve requested preset limits, actions and revert flags are exact',()=>{
 const expected:any={mass_ban:[5,60,'strip',true],bot_add:[1,60,'strip',true],channel_create:[6,120,'strip',true],channel_delete:[3,120,'strip',false],mass_kick:[5,120,'strip',false],dangerous_grant:[1,60,'strip',true],role_create:[8,120,'strip',true],role_delete:[5,120,'strip',false],role_grant:[8,60,'strip',true],guild_update:[5,120,'strip',false],timeout:[10,120,'strip',true],webhook_change:[3,60,'strip',true]};
 for(const [key,values] of Object.entries(expected)) {const r=RULES.find(r=>r.key===key)!;assert.deepEqual([r.count,r.seconds,r.punishment,r.revert],values);}
});

test('Permission Grant detects exactly the requested six permission bits',()=>{
 for(const bit of [PermissionFlagsBits.Administrator,PermissionFlagsBits.BanMembers,PermissionFlagsBits.KickMembers,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageGuild,PermissionFlagsBits.ManageWebhooks])assert.equal(escalationAdded(0n,bit),bit);
 assert.equal(escalationAdded(0n,PermissionFlagsBits.ManageRoles),0n);
});

function readinessGuild({ id = 'g', actorId = 'owner', missing = new Set<bigint>(), above = [] as any[] } = {}) {
 const bot:any={permissions:{has:(permission:bigint)=>!missing.has(permission)},roles:{highest:{id:'botrole',position:50}}};
 const roles=new Collection<string,any>();
 roles.set(id,{id,position:0,managed:false});
 roles.set('botrole',{id:'botrole',name:'Ghost Vanguard',position:50,managed:false});
 for(const role of above)roles.set(role.id,role);
 const log={id:'log',isTextBased:()=>true,permissionsFor:()=>({has:()=>true})};
 const guild:any={id,name:'Test Guild',ownerId:actorId,members:{me:bot,fetchMe:async()=>bot},roles:{cache:roles},channels:{cache:new Collection([['log',log]]),fetch:async(channelId:string)=>channelId==='log'?log:null}};
 const actor:any={id:actorId,guild,roles:{cache:new Collection()},permissions:{has:()=>true}};
 guild.members.fetch=async()=>actor;
 return {guild,actor,missing,roles};
}

function commandInteraction(guild:any, actor:any, subcommand='enable') {
 const replies:any[]=[];
 return {inCachedGuild:()=>true,guildId:guild.id,guild,member:actor,user:{id:actor.id},options:{getSubcommand:()=>subcommand},replies,customId:'',editReply:async(payload:any)=>{replies.push(payload);}} as any;
}

async function clickDangerConfirmation(ctx:any, source:any) {
 const {Registry}=await import('../src/bot/registry.js');
 const {registerDangerConfirm}=await import('../src/ui/danger-ui.js');
 const registry=new Registry();registerDangerConfirm(registry);
 const customId=String(source.replies[0].components[0].components[0].data.custom_id);
 const click={...source,customId};
 await registry.components.find(c=>c.prefix==='dangerconfirm:')!.execute(ctx,click);
 return click;
}

test('/antinuke enable leaves observe mode unchanged until a ready owner confirms, and warns about roles above Vanguard',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const high={id:'high',name:'High Staff',position:60,managed:false};
  const {guild,actor}=readinessGuild({above:[high]});
  const s=store.settings('g');s.enabled=true;s.mode='observe';s.logChannelId='log';s.ruleDefaults={count:99,seconds:5};s.rules.mass_ban={count:90,seconds:5};store.save(s);
  let snapshots=0;const events:any[]=[];
  const ctx:any={store,actor,snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>{snapshots++;return 1;}},logs:{push:(_g:any,e:any)=>events.push(e)},policy:{...antinuke.metadata,...antinuke.subcommands?.enable},actionKey:'antinuke/enable'};
  const i=commandInteraction(guild,actor);
  await antinuke.execute(ctx,i);
  assert.equal(store.settings('g').mode,'observe');assert.equal(snapshots,0,'nothing is saved or enabled before confirmation');
  assert.match(JSON.stringify(i.replies[0]),/High Staff/,'the role-hierarchy limitation is part of the review prompt');
  await clickDangerConfirmation(ctx,i);
  const result=store.settings('g');assert.equal(result.enabled,true);assert.equal(result.mode,'enforce');assert.equal(result.ruleDefaults,undefined);assert.deepEqual(result.rules,{mass_ban:{count:90,seconds:5}});
  assert.equal(snapshots,1);assert.equal(store.antinukeStaffDisabled('g'),false);
  assert.match(JSON.stringify(i.replies.at(-1)),/High Staff|cannot be contained/);
  assert.equal(events.length,1);
 } finally {store.close();}
});

test('/antinuke enable rechecks missing permissions on confirmation and refuses before the baseline',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const missing=new Set<bigint>();const {guild,actor}=readinessGuild({missing});
  const s=store.settings('g');s.enabled=true;s.mode='observe';s.logChannelId='log';store.save(s);
  let snapshots=0;const ctx:any={store,actor,snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>{snapshots++;return 1;}},logs:{push:()=>{}},policy:{...antinuke.metadata,...antinuke.subcommands?.enable},actionKey:'antinuke/enable'};
  const i=commandInteraction(guild,actor);await antinuke.execute(ctx,i);
  missing.add(PermissionFlagsBits.BanMembers);
  await assert.rejects(()=>clickDangerConfirmation(ctx,i),/readiness changed|not enabled/i);
  assert.equal(snapshots,0);assert.equal(store.settings('g').mode,'observe');assert.equal(store.antinukeStaffDisabled('g'),false);
 } finally {store.close();}
});

test('/antinuke enable repeats readiness after saving the baseline and still refuses if permissions changed',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const missing=new Set<bigint>();const {guild,actor}=readinessGuild({missing});
  const s=store.settings('g');s.enabled=true;s.mode='observe';s.logChannelId='log';store.save(s);
  let snapshots=0;const ctx:any={store,actor,snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>{snapshots++;missing.add(PermissionFlagsBits.BanMembers);return 1;}},logs:{push:()=>{}},policy:{...antinuke.metadata,...antinuke.subcommands?.enable},actionKey:'antinuke/enable'};
  const i=commandInteraction(guild,actor);await antinuke.execute(ctx,i);
  await assert.rejects(()=>clickDangerConfirmation(ctx,i),/baseline was saved.*enforcement was not enabled/i);
  assert.equal(snapshots,1);assert.equal(store.settings('g').mode,'observe');assert.equal(store.antinukeStaffDisabled('g'),false);
 } finally {store.close();}
});

test('/antinuke enable invalidates a confirmation if role hierarchy changes before the click',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const high={id:'high',name:'High Staff',position:60,managed:false};const {guild,actor}=readinessGuild({above:[high]});
  const s=store.settings('g');s.enabled=true;s.mode='observe';s.logChannelId='log';store.save(s);
  let snapshots=0;const ctx:any={store,actor,snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>{snapshots++;return 1;}},logs:{push:()=>{}},policy:{...antinuke.metadata,...antinuke.subcommands?.enable},actionKey:'antinuke/enable'};
  const i=commandInteraction(guild,actor);await antinuke.execute(ctx,i);
  high.name='Changed Staff Hierarchy';
  await assert.rejects(()=>clickDangerConfirmation(ctx,i),/role hierarchy changed/i);
  assert.equal(snapshots,0);assert.equal(store.settings('g').mode,'observe');
 } finally {store.close();}
});

test('mass bans warn and revert first, then strip and revert on a same-rule repeat within an hour',async()=>{
 const {store,security,guild,entry}=fixture();
 try {
  const undone:string[]=[];let stripped=0;
  security.punish=async()=>{stripped++;return 'Removed 1 dangerous role(s).';};
  guild.bans={remove:async(id:string)=>{undone.push(id);}};
  await security.audit(entry('old','older',AuditLogEvent.MemberBanAdd,[],Date.now()-61000),guild);
  for(let n=1;n<=5;n++)await security.audit(entry(String(n),'target'+n),guild);
  assert.equal(stripped,0,'the first mass-ban threshold does not strip');
  assert.equal(store.get('SELECT mode FROM incidents')!.mode,'warn');
  assert.deepEqual(undone.sort(),['target1','target2','target3','target4','target5'],'bans are still safely reverted');
  store.run('DELETE FROM observations');
  for(let n=6;n<=10;n++)await security.audit(entry(String(n),'repeat'+n),guild);
  assert.equal(stripped,1,'a repeat of the same rule escalates');
  assert.deepEqual(undone.filter(id=>id.startsWith('repeat')).sort(),['repeat10','repeat6','repeat7','repeat8','repeat9']);
  assert.equal(store.all('SELECT * FROM incidents').length,2);
 } finally {store.close();}
});

test('observe mode never bans an executor or undoes their bans',async()=>{
 const {store,security,guild,entry}=fixture('observe');
 try {security.punish=async()=>{throw new Error('Must not punish');};security.revert=async()=>{throw new Error('Must not revert');};for(let n=1;n<=5;n++)await security.audit(entry(String(n),'t'+n),guild);assert.match(store.get('SELECT result FROM incidents')!.result,/Observed only/);}finally{store.close();}
});

test('kick punishment respects hierarchy and trusted accounts',async()=>{
 const {store,security,guild}=fixture();
 try {let kicked=0;guild.members={fetch:async()=>({kickable:false,kick:async()=>{kicked++;}})};assert.match(await security.punish(guild,'actor','kick'),/cannot/);assert.equal(kicked,0);store.grant('g','actor','trust','owner');assert.match(await security.punish(guild,'actor','ban'),/Protected/);assert.equal(kicked,0);}finally{store.close();}
});

test('Role Invite detects additions but ignores removals and verification-bot updates',async()=>{
 const {store,security,guild,entry}=fixture('observe');
 try {
  guild.roles={cache:new Collection()};
  await security.audit(entry('remove','recipient',AuditLogEvent.MemberRoleUpdate,[{key:'$remove',new:[{id:'r'}]}]),guild);
  await security.audit(entry('add','recipient',AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
  store.grant('g','actor','bot','owner');
  await security.audit(entry('verify','recipient',AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
  assert.equal(store.all("SELECT * FROM incidents WHERE rule='role_grant'").length,0,'one ordinary role grant is below the limit');assert.equal(store.all('SELECT * FROM observations').length,1);
 }finally{store.close();}
});

test('Timeout fires on the tenth imposed timeout and preserves a subsequently changed timeout',async()=>{
 const {store,security,guild,entry}=fixture();
 try {
  const until=new Date(Date.now()+600000).toISOString();let restored=0;
  guild.members={fetch:async({user}:any)=>({id:user,moderatable:true,communicationDisabledUntilTimestamp:user==='t5'?Date.now()+500000:Date.parse(until),disableCommunicationUntil:async()=>{restored++;}})};
  security.punish=async()=> 'Stripped actor.';
  for(let n=1;n<=10;n++)await security.audit(entry(String(n),'t'+n,AuditLogEvent.MemberUpdate,[{key:'communication_disabled_until',old:null,new:until}]),guild);
  assert.equal(restored,9);assert.equal(store.all("SELECT * FROM incidents WHERE rule='timeout'").length,1);
 }finally{store.close();}
});

test('role creation reverts skip managed roles and hierarchy-protected roles',async()=>{
 const {store,security,guild,entry}=fixture();
 try {let deleted=0;guild.roles={fetch:async()=>({managed:true,editable:true,delete:async()=>{deleted++;}})};assert.match(await security.revert(entry('a','role',AuditLogEvent.RoleCreate),guild,RULES.find(r=>r.key==='role_create')!),/managed/);assert.equal(deleted,0);}finally{store.close();}
});

import { applyDefaultAntinuke, antinukeOptedOut } from '../src/security/locked-antinuke.js';
test('new authorized servers start in observe mode even when readiness passes; the choice persists without an automatic baseline',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const {guild}=readinessGuild();
  const s=store.settings('g');s.enabled=false;s.mode='observe';s.logChannelId='log';s.rules.mass_ban={count:90,seconds:5,enabled:false};store.save(s);store.setKickBots('g',true);
  const alerts:any[]=[];const logs:any={push:(_g:any,e:any)=>alerts.push(e.toJSON())};
  assert.equal(await applyDefaultAntinuke(store,guild,logs),'observing');
  const first=store.settings('g');assert.equal(first.enabled,true);assert.equal(first.mode,'observe');assert.deepEqual(first.rules,{mass_ban:{count:90,seconds:5,enabled:false}});assert.equal(first.ruleDefaults,undefined);assert.equal(store.kickBots('g'),false);
  assert.equal(alerts[0].title,'🟠 Anti-nuke observe mode');assert.match(JSON.stringify(alerts[0]),/enforcement still needs a deliberate/);
  assert.equal(await applyDefaultAntinuke(store,guild,logs),'unchanged');assert.equal(alerts.length,1);
  authorize(store,'other');store.run("UPDATE guild_authorization SET state='DEAUTHORIZED' WHERE guild_id='other'");
  assert.equal(await applyDefaultAntinuke(store,{id:'other'} as any,logs),'unchanged');assert.equal(store.settings('other').enabled,false);
 } finally {store.close();}
});

test('an already-enforced server with missing readiness fails safe into observe and stays there after repair',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const s=store.settings('g');s.enabled=true;s.mode='enforce';s.rules={};store.save(s);
  const alerts:any[]=[];const logs:any={push:(_g:any,e:any)=>alerts.push(e.toJSON())};
  assert.equal(await applyDefaultAntinuke(store,{id:'g'} as any,logs),'observing');
  assert.equal(store.settings('g').enabled,true);assert.equal(store.settings('g').mode,'observe');
  assert.equal(alerts[0].title,'⚠️ Anti-nuke switched to observe mode');assert.match(JSON.stringify(alerts[0]),/Readiness blockers/);
  const {guild}=readinessGuild();
  assert.equal(await applyDefaultAntinuke(store,guild,logs),'unchanged','repairing readiness does not silently resume enforcement');
  assert.equal(store.settings('g').mode,'observe');
 } finally {store.close();}
});

test('an established enforce preset remains enforcing across startup when readiness still passes',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const {guild}=readinessGuild();const s=store.settings('g');s.enabled=true;s.mode='enforce';s.logChannelId='log';store.save(s);
  assert.equal(await applyDefaultAntinuke(store,guild,{push:()=>{}} as any),'unchanged');
  assert.equal(store.settings('g').mode,'enforce');
 } finally {store.close();}
});

test('/disable remains a confirmed, persistent staff opt-out; /antinuke enable re-enables only after a fresh confirmation',async()=>{
 const store=new Store(':memory:');authorize(store);
 const {config}=await import('../src/config.js');const DEV='1277709272041394187';config.developers.add(DEV);
 try {
  const {guild,actor}=readinessGuild({actorId:DEV});
  const s=store.settings('g');s.logChannelId='log';store.save(s);
  const logs:any={push:()=>{}};
  assert.equal(await applyDefaultAntinuke(store,guild,logs),'observing');assert.equal(store.settings('g').mode,'observe');
  const ctx:any={store,actor,snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>1},logs,policy:antinuke.metadata,actionKey:'antinuke/disable'};
  const off=commandInteraction(guild,actor,'disable');await antinuke.execute(ctx,off);
  assert.equal(store.settings('g').enabled,true,'nothing changes before the disable confirmation');
  await clickDangerConfirmation(ctx,off);
  assert.equal(store.settings('g').enabled,false);assert.equal(antinukeOptedOut(store,'g'),true);
  assert.equal(await applyDefaultAntinuke(store,guild,logs),'opted-out');assert.equal(store.settings('g').enabled,false);

  ctx.policy={...antinuke.metadata,...antinuke.subcommands?.enable};ctx.actionKey='antinuke/enable';
  const on=commandInteraction(guild,actor);await antinuke.execute(ctx,on);
  assert.equal(store.settings('g').enabled,false,'the opt-out is preserved until the enable confirmation');
  await clickDangerConfirmation(ctx,on);
  assert.equal(antinukeOptedOut(store,'g'),false);assert.equal(store.settings('g').enabled,true);assert.equal(store.settings('g').mode,'enforce');
  assert.equal(await applyDefaultAntinuke(store,guild,logs),'unchanged');assert.equal(store.settings('g').enabled,true);
 } finally {config.developers.delete(DEV);store.close();}
});

test('a brand-new role created with Administrator counts as a Permission Grant straight away; an ordinary new role does not',async()=>{
 const {store,security,guild,entry}=fixture('observe');
 try {
  guild.roles={cache:new Collection()};
  await security.audit(entry('plain','r1',AuditLogEvent.RoleCreate,[{key:'permissions',new:'0'}]),guild);
  assert.equal(store.all("SELECT * FROM incidents WHERE rule='dangerous_grant'").length,0);
  await security.audit(entry('admin','r2',AuditLogEvent.RoleCreate,[{key:'permissions',new:String(PermissionFlagsBits.Administrator)}]),guild);
  assert.equal(store.all("SELECT * FROM incidents WHERE rule='dangerous_grant'").length,1,'first offence, no waiting for five role creations');
  store.grant('g','actor','trust','owner');
  await security.audit(entry('trusted','r3',AuditLogEvent.RoleCreate,[{key:'permissions',new:String(PermissionFlagsBits.Administrator)}]),guild);
  assert.equal(store.all("SELECT * FROM incidents WHERE rule='dangerous_grant'").length,1,'whitelisted people are not affected');
 } finally {store.close();}
});

test('reverting that grant deletes the new role when Vanguard can, and keeps it when it cannot',async()=>{
 const {store,security,guild}=fixture();
 try {
  let deleted=0;
  guild.roles={fetch:async(id:string)=>id==='r2'?{name:'Hacker',managed:false,editable:true,delete:async()=>{deleted++;}}:{name:'Top',managed:false,editable:false,delete:async()=>{deleted++;}}};
  assert.match(await security.revertGrant({action:AuditLogEvent.RoleCreate,targetId:'r2',changes:[]} as any,guild),/^Deleted the new role Hacker/);
  assert.match(await security.revertGrant({action:AuditLogEvent.RoleCreate,targetId:'r9',changes:[]} as any,guild),/kept it/);
  assert.equal(deleted,1);
 } finally {store.close();}
});

test('Role Invite allows normal role giving: seven grants pass, the eighth warns, the ninth strips',async()=>{
 const {store,security,guild,entry}=fixture();
 try {
  guild.roles={cache:new Collection()};let punished=0;security.punish=async()=>{punished++;return 'Stripped actor.';};security.revert=async()=>'Removed 1 assigned role(s).';
  for(let n=1;n<=7;n++)await security.audit(entry('g'+n,'m'+n,AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
  assert.equal(punished,0);assert.equal(store.all("SELECT * FROM incidents WHERE rule='role_grant'").length,0);
  await security.audit(entry('g8','m8',AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
  assert.equal(punished,0,'first time over the limit is a warning');assert.equal(store.get("SELECT mode FROM incidents WHERE rule='role_grant'")!.mode,'warn');
  await security.audit(entry('g9','m9',AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
  assert.equal(punished,1,'carrying on after the warning strips');
 }finally{store.close();}
});

function staffGuild() {
 const f=fixture();const {guild}=f;
 const role=(id:string,bits:bigint)=>({id,managed:false,editable:true,permissions:{bitfield:bits}});
 guild.roles={cache:new Collection<string,any>([['mod',role('mod',PermissionFlagsBits.BanMembers|PermissionFlagsBits.KickMembers)],['admin',role('admin',PermissionFlagsBits.Administrator)],['oldmod',role('oldmod',PermissionFlagsBits.BanMembers|PermissionFlagsBits.KickMembers)],['plain',role('plain',0n)]])};
 const members=new Collection<string,any>();
 const member=(id:string,roles:string[])=>{const m={id,roles:{cache:new Collection(roles.map(r=>[r,guild.roles.cache.get(r)]))}};members.set(id,m);return m;};
 guild.members={cache:members,fetch:async({user}:any)=>members.get(user)??null};
 f.security.punish=async()=>'Stripped actor.';f.security.revert=async()=>'Removed 1 newly granted role(s).';
 const give=(id:string,target:string,role:string)=>f.security.audit(f.entry(id,target,AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:role}]}]),guild);
 const incidents=()=>f.store.all("SELECT * FROM incidents WHERE rule='dangerous_grant'").length;
 return {...f,member,give,incidents};
}

test('whitelisted role managers can promote moderators, but Administrator is still checked',async()=>{
 const {store,member,give,incidents}=staffGuild();
 try {
  member('actor',['plain']);member('newmod',['plain','mod']);member('newadmin',['plain','admin']);
  for(const r of ['role_grant','role_create','role_update','role_delete'])store.grant('g','actor',`trust:${r}`,'owner');
  await give('p1','newmod','mod');
  assert.equal(incidents(),0,'giving a Ban/Kick role is normal work for a whitelisted role manager');
  await give('p2','newadmin','admin');
  assert.equal(incidents(),1,'Administrator still needs a full bypass');
 }finally{store.close();}
});

test('Permission Grant only counts permissions the member did not already have',async()=>{
 const {store,member,give,incidents}=staffGuild();
 try {
  member('actor',['plain']);member('existing',['oldmod','mod']);member('fresh',['plain','mod']);
  await give('e1','existing','mod');
  assert.equal(incidents(),0,'they already had Ban/Kick from another role');
  await give('e2','fresh','mod');
  assert.equal(incidents(),1,'someone without the role is still a new grant, and not being whitelisted still strips');
 }finally{store.close();}
});

test('routine rules warn first, different rules do not escalate each other, and bots skip human warnings',async()=>{
 const pushed:any[]=[];
 const store=new Store(':memory:');authorize(store);const st=store.settings('g');st.enabled=true;st.mode='enforce';store.save(st);
 const security=new Security(store,{push:(_g:string,e:any)=>{pushed.push(e.toJSON());}} as any);
 const members=new Map<string,any>([['person',{id:'person',user:{bot:false},send:async()=>{dms++;}}],['somebot',{id:'somebot',user:{bot:true}}]]);
 let dms=0;
 const guild:any={id:'g',name:'Test',ownerId:'owner',client:{user:{id:'vanguard'}},roles:{cache:new Collection()},members:{cache:new Collection(),fetch:async({user}:any)=>members.get(user)??null}};
 const e=(id:string,actor:string,action:number,changes:any[]=[])=>({id,targetId:'t'+id,action,changes,executorId:actor,createdTimestamp:Date.now()} as any);
 let punished:string[]=[];security.punish=async(_g,a)=>{punished.push(a);return 'Removed 1 dangerous role(s).';};security.revert=async()=>'Deleted created channel x.';
 try {
  for(let n=0;n<6;n++)await security.audit(e('c'+n,'person',AuditLogEvent.ChannelCreate),guild);
  assert.deepEqual(punished,[]);assert.equal(dms,1,'the person is told privately');
  const card=pushed.at(-1);assert.equal(card.title,'Anti-nuke Warning');assert.match(card.description,/first-hit \*\*warning\*\*.*safe revert was attempted.*same rule.*normal response/);
  assert.match(card.fields.find((f:any)=>f.name==='Changes reverted').value,/6 undone/);
  for(let n=0;n<6;n++)await security.audit(e('b'+n,'somebot',AuditLogEvent.ChannelCreate),guild);
  assert.deepEqual(punished,['somebot'],'bots are punished straight away');
  for(let n=0;n<5;n++)await security.audit(e('k'+n,'person',AuditLogEvent.MemberKick),guild);
  assert.deepEqual(punished,['somebot'],'mass kicks warn once even after a different rule warned earlier');
  assert.equal(dms,2,'the separate mass-kick warning is delivered');
  store.run("UPDATE incidents SET at=? WHERE mode='warn'",Date.now()-2*3600000);
  store.run('DELETE FROM observations');punished=[];
  for(let n=0;n<6;n++)await security.audit(e('d'+n,'person',AuditLogEvent.ChannelCreate),guild);
  assert.deepEqual(punished,[],'an old warning (over an hour) does not count, so they get a fresh warning');
 } finally {store.close();}
});

test('well-known verification bots can give ordinary roles freely, can be switched off, and never give dangerous ones',async()=>{
 const BLOX='426537812993638400';
 const {store,security,guild}=fixture('observe');
 try {
  const role=(id:string,bits:bigint)=>({id,managed:false,editable:true,permissions:{bitfield:bits}});
  guild.roles={cache:new Collection<string,any>([['verified',role('verified',0n)],['mod',role('mod',PermissionFlagsBits.BanMembers)]])};
  guild.members={cache:new Collection(),fetch:async()=>null};
  const give=(id:string,r:string)=>security.audit({id,targetId:'m'+id,action:AuditLogEvent.MemberRoleUpdate,changes:[{key:'$add',new:[{id:r}]}],executorId:BLOX,createdTimestamp:Date.now()} as any,guild);
  for(let n=0;n<10;n++)await give('v'+n,'verified');
  assert.equal(store.all("SELECT * FROM observations WHERE rule='role_grant'").length,0,'Bloxlink giving verified roles is not counted');
  await give('d1','mod');
  assert.equal(store.all("SELECT * FROM observations WHERE rule='dangerous_grant'").length,1,'giving a Ban Members role is still checked');
  store.grant('g',BLOX,'bot_denied','owner');
  await give('x1','verified');
  assert.equal(store.all("SELECT * FROM observations WHERE rule='role_grant'").length,1,'switched off for this server');
 }finally{store.close();}
});

test('heads-up precedes a first-hit warning, and only a same-rule repeat escalates',async()=>{
 const pushed:any[]=[];
 const store=new Store(':memory:');authorize(store);const st=store.settings('g');st.enabled=true;st.mode='enforce';store.save(st);
 const security=new Security(store,{push:(_g:string,e:any)=>{pushed.push(e.toJSON());}} as any);
 const guild:any={id:'g',ownerId:'owner',client:{user:{id:'vanguard'}},roles:{cache:new Collection()},members:{cache:new Collection(),fetch:async()=>null}};
 let punished=0;security.punish=async()=>{punished++;return 'Removed 1 dangerous role(s).';};
 try {
  for(let n=0;n<2;n++)await security.audit({id:'d'+n,targetId:'c'+n,action:AuditLogEvent.ChannelDelete,executorId:'admin',createdTimestamp:Date.now()} as any,guild);
  assert.equal(punished,0);
  assert.equal(pushed.length,1);assert.equal(pushed[0].title,'Anti-nuke heads-up');assert.match(pushed[0].description,/\*\*2 of 3\*\*.*Nothing has been done.*a warning/s);
  await security.audit({id:'d2',targetId:'c2',action:AuditLogEvent.ChannelDelete,executorId:'admin',createdTimestamp:Date.now()} as any,guild);
  assert.equal(punished,0,'the third delete warns first without stripping');
  assert.equal(pushed.at(-1).title,'Anti-nuke Warning');
  store.run('DELETE FROM observations');
  for(let n=3;n<6;n++)await security.audit({id:'d'+n,targetId:'c'+n,action:AuditLogEvent.ChannelDelete,executorId:'admin',createdTimestamp:Date.now()} as any,guild);
  assert.equal(punished,1,'a same-rule repeat within the warning window is acted on');
  assert.equal(pushed.filter(p=>p.title==='Anti-nuke heads-up').length,1,'only one heads-up per window');
 } finally {store.close();}
});

test('ANTINUKE_LOCK: a server someone switched off is switched back on at start, with a notice; without the lock the choice is kept',async()=>{
 const store=new Store(':memory:');authorize(store);const saved=process.env.ANTINUKE_LOCK;
 try {
  const {guild}=readinessGuild();
  const s=store.settings('g');s.enabled=false;s.logChannelId='log';store.save(s);store.setAntinukeStaffDisabled('g',true);
  const alerts:any[]=[];const logs:any={push:(_g:any,e:any)=>alerts.push(e.toJSON())};
  process.env.ANTINUKE_LOCK='';
  assert.equal(await applyDefaultAntinuke(store,guild,logs),'opted-out','not locked: the off choice is respected');
  process.env.ANTINUKE_LOCK='true';
  assert.notEqual(await applyDefaultAntinuke(store,guild,logs),'opted-out');
  assert.equal(antinukeOptedOut(store,'g'),false);assert.equal(store.settings('g').enabled,true);
  assert.match(JSON.stringify(alerts),/Anti-nuke switched back on/);
 } finally {process.env.ANTINUKE_LOCK=saved??'';store.close();}
});
