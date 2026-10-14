import test from 'node:test';
import assert from 'node:assert/strict';
import {AuditLogEvent,Collection,PermissionFlagsBits} from 'discord.js';
import {RULES,escalationAdded} from '../src/core.js';
import {Security} from '../src/security/security.js';
import {Store} from '../src/database/db.js';
import {authorize} from './helpers.js';
import enable from '../src/commands/antinuke/enable.js';
import antinuke from '../src/commands/antinuke/antinuke.js';
import { antinukeStatus } from '../src/ui/antinuke-status.js';

test('status embed shows the fixed limits (saved custom limits are ignored) and only active anti-nuke bypasses in this guild',()=>{
 const {store}=fixture();
 try {
  const s=store.settings('g');s.rules.mass_ban={count:7,seconds:120};store.save(s);
  store.grant('g','111','trust','owner');store.grant('g','222','bot','owner');store.grant('g','333','trust','owner');
  store.run('UPDATE grants SET expires=? WHERE guild_id=? AND user_id=?',Date.now()-1,'g','333');
  const status=antinukeStatus(store,'g').toJSON();
  assert.equal(status.title,'Antinuke Status');assert.equal(status.color,0x57F287);
  assert.match(status.description!,/`Ban` – \*\*3 in 60s → ban\*\* `\[revert\]`/);assert.match(status.description!,/preset is fixed/);
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

function fixture(mode:'observe'|'enforce'='enforce') {
 const store=new Store(':memory:');authorize(store);
 const s=store.settings('g');s.enabled=true;s.mode=mode;store.save(s);
 const security=new Security(store,{push:()=>{}} as any);
 const guild:any={id:'g',ownerId:'owner',client:{user:{id:'vanguard'}}};
 const entry=(id:string,targetId:string,action=AuditLogEvent.MemberBanAdd,changes:any[]=[],at=Date.now())=>({id,targetId,action,changes,executorId:'actor',createdTimestamp:at} as any);
 return {store,security,guild,entry};
}

test('the twelve requested preset limits, actions and revert flags are exact',()=>{
 const expected:any={mass_ban:[3,60,'ban',true],bot_add:[1,60,'ban',true],channel_create:[4,120,'kick',true],channel_delete:[2,120,'ban',false],mass_kick:[3,120,'ban',false],dangerous_grant:[1,60,'strip',true],role_create:[5,120,'strip',true],role_delete:[5,120,'strip',false],role_grant:[6,60,'strip',true],guild_update:[3,120,'strip',false],timeout:[8,120,'strip',true],webhook_change:[1,60,'kick',true]};
 for(const [key,values] of Object.entries(expected)) {const r=RULES.find(r=>r.key===key)!;assert.deepEqual([r.count,r.seconds,r.punishment,r.revert],values);}
});

test('Permission Grant detects exactly the requested six permission bits',()=>{
 for(const bit of [PermissionFlagsBits.Administrator,PermissionFlagsBits.BanMembers,PermissionFlagsBits.KickMembers,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageGuild,PermissionFlagsBits.ManageWebhooks])assert.equal(escalationAdded(0n,bit),bit);
 assert.equal(escalationAdded(0n,PermissionFlagsBits.ManageRoles),0n);
});

test('/enable reloads the preset, clears shared limits, captures a baseline and persists enforce mode',async()=>{
 const {store,guild}=fixture();
 try {
  const s=store.settings('g');s.enabled=false;s.mode='observe';s.logChannelId='log';s.ruleDefaults={count:99,seconds:5};s.rules.mass_ban={count:90,seconds:5};store.save(s);
  let snapshots=0;const ctx:any={store,actor:{id:'actor'},snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>{snapshots++;return 1;}},logs:{push:()=>{}}};
  guild.members={me:{permissions:{has:()=>true},roles:{highest:{id:'botrole',position:99}}}};guild.roles={cache:new Collection()};guild.channels={cache:new Collection([['log',{isTextBased:()=>true,permissionsFor:()=>({has:()=>true})}]]),fetch:async()=>null};
  const i:any={guildId:'g',guild,user:{id:'actor'},options:{getSubcommand:()=>{throw new Error('Alias must choose enable.');}}};
  await enable.execute(ctx,i);
  const result=store.settings('g');assert.equal(result.enabled,true);assert.equal(result.mode,'enforce');assert.equal(result.ruleDefaults,undefined);assert.deepEqual(result.rules,{});assert.equal(snapshots,1);
  assert.equal(store.antinukeStaffDisabled('g'),false);
 } finally {store.close();}
});

test('three bans in sixty seconds ban the executor and revert every observed ban in that window',async()=>{
 const {store,security,guild,entry}=fixture();
 try {
  const undone:string[]=[];let banned=0;
  guild.members={fetch:async()=>({id:'actor',bannable:true,ban:async()=>{banned++;}})};
  guild.bans={remove:async(id:string)=>{undone.push(id);}};
  await security.audit(entry('old','older',AuditLogEvent.MemberBanAdd,[],Date.now()-61000),guild);
  for(let n=1;n<=3;n++)await security.audit(entry(String(n),'target'+n),guild);
  assert.equal(banned,1);assert.deepEqual(undone.sort(),['target1','target2','target3']);
  assert.equal(store.all('SELECT * FROM incidents').length,1);
 } finally {store.close();}
});

test('observe mode never bans an executor or undoes their bans',async()=>{
 const {store,security,guild,entry}=fixture('observe');
 try {security.punish=async()=>{throw new Error('Must not punish');};security.revert=async()=>{throw new Error('Must not revert');};for(let n=1;n<=3;n++)await security.audit(entry(String(n),'t'+n),guild);assert.match(store.get('SELECT result FROM incidents')!.result,/Observed only/);}finally{store.close();}
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

test('Timeout fires on the eighth imposed timeout and preserves a subsequently changed timeout',async()=>{
 const {store,security,guild,entry}=fixture();
 try {
  const until=new Date(Date.now()+600000).toISOString();let restored=0;
  guild.members={fetch:async({user}:any)=>({id:user,moderatable:true,communicationDisabledUntilTimestamp:user==='t5'?Date.now()+500000:Date.parse(until),disableCommunicationUntil:async()=>{restored++;}})};
  security.punish=async()=> 'Stripped actor.';
  for(let n=1;n<=8;n++)await security.audit(entry(String(n),'t'+n,AuditLogEvent.MemberUpdate,[{key:'communication_disabled_until',old:null,new:until}]),guild);
  assert.equal(restored,7);assert.equal(store.all("SELECT * FROM incidents WHERE rule='timeout'").length,1);
 }finally{store.close();}
});

test('role creation reverts skip managed roles and hierarchy-protected roles',async()=>{
 const {store,security,guild,entry}=fixture();
 try {let deleted=0;guild.roles={fetch:async()=>({managed:true,editable:true,delete:async()=>{deleted++;}})};assert.match(await security.revert(entry('a','role',AuditLogEvent.RoleCreate),guild,RULES.find(r=>r.key==='role_create')!),/managed/);assert.equal(deleted,0);}finally{store.close();}
});

import { applyDefaultAntinuke, antinukeOptedOut } from '../src/security/locked-antinuke.js';
test('every authorized server gets the fixed preset enabled in enforce mode automatically, with a baseline',async()=>{
 const store=new Store(':memory:');authorize(store);
 try {
  const s=store.settings('g');s.enabled=false;s.mode='observe';s.rules.mass_ban={count:90,seconds:5,enabled:false};store.save(s);store.setKickBots('g',true);
  const alerts:any[]=[];let baselines=0;const logs:any={push:(_g:any,e:any)=>alerts.push(e.toJSON())};
  assert.equal(await applyDefaultAntinuke(store,{id:'g'} as any,logs,async()=>++baselines),'enabled');
  const r=store.settings('g');assert.equal(r.enabled,true);assert.equal(r.mode,'enforce');assert.deepEqual(r.rules,{});assert.equal(store.kickBots('g'),false);
  assert.equal(baselines,1);assert.match(JSON.stringify(alerts[0]),/"name":"Rules","value":"17"/);
  assert.equal(await applyDefaultAntinuke(store,{id:'g'} as any,logs,async()=>++baselines),'unchanged');assert.equal(baselines,1);assert.equal(alerts.length,1);
  authorize(store,'other');store.run("UPDATE guild_authorization SET state='DEAUTHORIZED' WHERE guild_id='other'");
  assert.equal(await applyDefaultAntinuke(store,{id:'other'} as any,logs),'unchanged');assert.equal(store.settings('other').enabled,false);
 } finally {store.close();}
});
test('/disable is remembered across restarts and /enable switches it back on',async()=>{
 const store=new Store(':memory:');authorize(store);
 const {config}=await import('../src/config.js');const DEV='1277709272041394187';config.developers.add(DEV);
 const {Registry}=await import('../src/bot/registry.js');const {registerDangerConfirm}=await import('../src/ui/danger-ui.js');
 try {
  const logs:any={push:()=>{}};
  await applyDefaultAntinuke(store,{id:'g'} as any,logs);assert.equal(store.settings('g').enabled,true);
  const member:any={id:DEV,guild:{id:'g',ownerId:DEV},roles:{cache:new Map()},permissions:{has:()=>true}};
  const mk=()=>{const replies:any[]=[];return {inCachedGuild:()=>true,member,guild:{name:'Test',members:{me:{permissions:{has:()=>true}},fetch:async()=>member}},user:{id:DEV},guildId:'g',customId:'',replies,options:{getSubcommand:()=> 'disable'},editReply:async(p:any)=>void replies.push(p)} as any;};
  const ctx:any={store,actor:{id:DEV},logs};
  const i=mk();await antinuke.execute(ctx,i);
  assert.equal(store.settings('g').enabled,true,'nothing changes before the confirmation click');
  const registry=new Registry();registerDangerConfirm(registry);
  const click=mk();click.customId=String(i.replies[0].components[0].components[0].data.custom_id);
  await registry.components.find(c=>c.prefix==='dangerconfirm:')!.execute(ctx,click);
  assert.equal(store.settings('g').enabled,false);assert.equal(antinukeOptedOut(store,'g'),true);
  // A restart must not switch it back on.
  assert.equal(await applyDefaultAntinuke(store,{id:'g'} as any,logs),'opted-out');assert.equal(store.settings('g').enabled,false);
  // /enable records the choice; the next restart keeps it on.
  const g:any={id:'g',members:{me:{permissions:{has:()=>true},roles:{highest:{id:'botrole',position:99}}}},roles:{cache:new Collection()},channels:{cache:new Collection([['log',{isTextBased:()=>true,permissionsFor:()=>({has:()=>true})}]]),fetch:async()=>null}};
  const s=store.settings('g');s.logChannelId='log';store.save(s);
  await enable.execute({store,actor:{id:DEV},snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>1},logs} as any,{guildId:'g',guild:g,user:{id:DEV},options:{}} as any);
  assert.equal(antinukeOptedOut(store,'g'),false);assert.equal(await applyDefaultAntinuke(store,{id:'g'} as any,logs),'unchanged');assert.equal(store.settings('g').enabled,true);
 } finally {store.close();}
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

test('Role Invite allows normal role giving: five grants pass, the sixth warns, the seventh strips',async()=>{
 const {store,security,guild,entry}=fixture();
 try {
  guild.roles={cache:new Collection()};let punished=0;security.punish=async()=>{punished++;return 'Stripped actor.';};security.revert=async()=>'Removed 1 assigned role(s).';
  for(let n=1;n<=5;n++)await security.audit(entry('g'+n,'m'+n,AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
  assert.equal(punished,0);assert.equal(store.all("SELECT * FROM incidents WHERE rule='role_grant'").length,0);
  await security.audit(entry('g6','m6',AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
  assert.equal(punished,0,'first time over the limit is a warning');assert.equal(store.get("SELECT mode FROM incidents WHERE rule='role_grant'")!.mode,'warn');
  await security.audit(entry('g7','m7',AuditLogEvent.MemberRoleUpdate,[{key:'$add',new:[{id:'r'}]}]),guild);
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

test('warnings: undone and logged, dangerous rules and bots get no warning, and the warning lasts an hour',async()=>{
 const pushed:any[]=[];
 const store=new Store(':memory:');authorize(store);const st=store.settings('g');st.enabled=true;st.mode='enforce';store.save(st);
 const security=new Security(store,{push:(_g:string,e:any)=>{pushed.push(e.toJSON());}} as any);
 const members=new Map<string,any>([['person',{id:'person',user:{bot:false},send:async()=>{dms++;}}],['somebot',{id:'somebot',user:{bot:true}}]]);
 let dms=0;
 const guild:any={id:'g',name:'Test',ownerId:'owner',client:{user:{id:'vanguard'}},roles:{cache:new Collection()},members:{cache:new Collection(),fetch:async({user}:any)=>members.get(user)??null}};
 const e=(id:string,actor:string,action:number,changes:any[]=[])=>({id,targetId:'t'+id,action,changes,executorId:actor,createdTimestamp:Date.now()} as any);
 let punished:string[]=[];security.punish=async(_g,a)=>{punished.push(a);return 'Removed 1 dangerous role(s).';};security.revert=async()=>'Deleted created channel x.';
 try {
  for(let n=0;n<4;n++)await security.audit(e('c'+n,'person',AuditLogEvent.ChannelCreate),guild);
  assert.deepEqual(punished,[]);assert.equal(dms,1,'the person is told privately');
  const card=pushed.at(-1);assert.equal(card.title,'Anti-nuke Warning');assert.match(card.description,/got a \*\*warning\*\*.*undone.*\*\*kicked\*\*/);
  assert.match(card.fields.find((f:any)=>f.name==='Changes reverted').value,/4 undone/);
  for(let n=0;n<4;n++)await security.audit(e('b'+n,'somebot',AuditLogEvent.ChannelCreate),guild);
  assert.deepEqual(punished,['somebot'],'bots are punished straight away');
  for(let n=0;n<3;n++)await security.audit(e('k'+n,'person',AuditLogEvent.MemberKick),guild);
  assert.deepEqual(punished,['somebot','person'],'mass kicks never warn');
  store.run("UPDATE incidents SET at=? WHERE mode='warn'",Date.now()-2*3600000);
  store.run('DELETE FROM observations');punished=[];
  for(let n=0;n<4;n++)await security.audit(e('d'+n,'person',AuditLogEvent.ChannelCreate),guild);
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
