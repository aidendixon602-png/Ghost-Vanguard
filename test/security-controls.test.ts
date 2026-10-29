import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { authorize } from './helpers.js';
import { readiness } from '../src/security/readiness.js';
import { Registry } from '../src/bot/registry.js';
import { registerDangerConfirm } from '../src/ui/danger-ui.js';
import { registerAntinukePanel, changeTrust, TRUST_PRESETS, scopeName } from '../src/ui/antinuke-panel.js';
import { catchUp } from '../src/audit/downtime.js';
import enable from '../src/commands/antinuke/enable.js';
import trust from '../src/commands/security/trust.js';
import { saveTrust, clearTrust, trustPanel, panelFor, kindsFor, registerTrustPanel } from '../src/ui/trust-panel.js';
import { config } from '../src/config.js';

function setup() {
 const store=new Store(':memory:');authorize(store);const s=store.settings('g');s.enabled=true;s.mode='enforce';s.logChannelId='log';store.save(s);
 const logs:any[]=[];const security=new Security(store,{push:(_g:any,e:any)=>logs.push(e)} as any);
 const guild:any={id:'g',name:'Test Guild',ownerId:'owner',client:{user:{id:'bot'}},members:{me:{permissions:{has:()=>true},roles:{highest:{id:'botrole',position:10}}},cache:new Collection()},roles:{cache:new Collection()},channels:{cache:new Collection([['log',{isTextBased:()=>true,permissionsFor:()=>({has:()=>true})}]]),fetch:async()=>null}};
 const actor:any={id:'owner',guild,roles:{cache:new Collection()},permissions:{has:()=>true}};
 guild.members.fetchMe=async()=>guild.members.me;guild.members.fetch=async()=>actor;
 return {store,security,guild,logs,actor};
}

function enableInteraction(guild:any, actor:any) {
 const replies:any[]=[];
 return {inCachedGuild:()=>true,guildId:guild.id,guild,member:actor,user:{id:actor.id},options:{},replies,editReply:async(payload:any)=>{replies.push(payload);}} as any;
}

async function confirmEnable(ctx:any, source:any) {
 const registry=new Registry();registerDangerConfirm(registry);
 const customId=String(source.replies[0].components[0].components[0].data.custom_id);
 const click={...source,customId};
 await registry.components.find(c=>c.prefix==='dangerconfirm:')!.execute(ctx,click);
 return click;
}

test('readiness checks missing permissions, log overwrites and unmanaged role hierarchy',()=>{
 const {store,guild}=setup();try {
 assert.deepEqual(readiness(guild,'log',store).missing,[]);
 guild.members.me.permissions.has=(bit:bigint)=>bit!==PermissionFlagsBits.BanMembers;
 guild.channels.cache.get('log').permissionsFor=()=>({has:()=>false});
 guild.roles.cache.set('higher',{id:'higher',position:11,name:'Staff',managed:false});guild.roles.cache.set('managed',{id:'managed',position:20,name:'Integration',managed:true});
 const result=readiness(guild,'log',store);assert.ok(result.missing.includes('BanMembers'));assert.ok(result.missing.includes('Log channel: EmbedLinks'));assert.deepEqual(result.above,['Staff']);
 }finally{store.close();}
});

test('legacy disabled toggles and loosened limits cannot weaken the fixed preset',async()=>{
 const {store,security,guild}=setup();try {
 const s=store.settings('g');s.rules.mass_ban={count:50,seconds:5,enabled:false};s.ruleDefaults={count:100,seconds:5};store.save(s);
 for(const n of [1,2,3,4,5])await security.audit({id:`e${n}`,executorId:'actor',action:AuditLogEvent.MemberBanAdd,targetId:`t${n}`,createdTimestamp:Date.now()} as any,guild);
 assert.equal(store.all('SELECT * FROM incidents').length,1,'5 bans in 60s still triggers');
 }finally{store.close();}
});

test('role whitelist uses current membership and expiry; whitelisted people are watched but never punished',async()=>{
 const {store,security,guild}=setup();try {
 const member:any={id:'actor',roles:{cache:new Collection([['staff',{}]])}};
 guild.members.cache.set('actor',member);guild.members.fetch=async()=>member;
 store.grant('g','staff','trust_role','owner',1);
 assert.equal(security.trusted(guild,'actor'),true);
 let punished=0;security.punish=async()=>{punished++;return 'Removed 1 dangerous role(s).';};
 for(const n of [1,2,3,4,5])await security.audit({id:'e'+n,executorId:'actor',action:AuditLogEvent.MemberBanAdd,targetId:'target'+n,createdTimestamp:Date.now()} as any,guild);
 assert.equal(store.all('SELECT * FROM observations').length,5,'still watched');assert.deepEqual(store.all('SELECT mode FROM incidents').map(r=>r.mode),['exempt'],'alerted');assert.equal(punished,0,'never punished');
 store.run('UPDATE grants SET expires=? WHERE guild_id=?',Date.now()-1,'g');assert.equal(security.trusted(guild,'actor'),false);
 }finally{store.close();}
});

test('whitelist changes cannot grant the acting administrator their own bypass',()=>{
 const {store}=setup();try {
 const ctx:any={store,actor:{id:'actor',roles:{cache:new Collection([['staff',{}]])}},logs:{push:()=>{}}};
 assert.throws(()=>changeTrust(ctx,'g','actor',false,true),/Another/);assert.throws(()=>changeTrust(ctx,'g','staff',true,true),/Another/);
 changeTrust(ctx,'g','other',true,true,24);assert.equal(store.hasGrant('g','other','trust_role'),true);
 changeTrust(ctx,'g','other',true,false);assert.equal(store.hasGrant('g','other','trust_role'),false);
 }finally{store.close();}
});

test('panel rejects controls copied to another user or guild',async()=>{
 const registry=new Registry();registerAntinukePanel(registry);const handler=registry.components[0]!;
 await assert.rejects(handler.execute({} as any,{customId:'anpanel:111111111111111111:222222222222222222:refresh',guildId:'333333333333333333',user:{id:'222222222222222222'}} as any),/another user or server/);
});

test('startup reports saved protection and permission readiness without changing enabled state',async()=>{
 const {store,guild,logs}=setup();try {
 await catchUp(guild,store,{push:(_g:any,e:any)=>logs.push(e)} as any,()=>false,null);
 assert.ok(logs.some(e=>e.toJSON().title==='Saved protection loaded'));
 assert.equal(store.settings('g').enabled,true);
 }finally{store.close();}
});

test('enable rejects missing permissions before saving a snapshot, then requires confirmation and warns about hierarchy',async()=>{
 const {store,guild,actor}=setup();try {
 let snapshots=0;const ctx:any={store,actor,snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>{snapshots++;return 1;}},logs:{push:()=>{}},policy:enable.metadata,actionKey:'enable'};
 const i=enableInteraction(guild,actor);
 guild.members.me.permissions.has=()=>false;
 await assert.rejects(enable.execute(ctx,i),/Enforcement remains off/);assert.equal(snapshots,0);
 guild.members.me.permissions.has=()=>true;guild.roles.cache.set('higher',{id:'higher',position:12,name:'Staff',managed:false});
 await enable.execute(ctx,i);
 assert.equal(snapshots,0,'the command only arms a confirmation');
 assert.match(JSON.stringify(i.replies[0]),/Unprotected roles at or above Vanguard/);
 await confirmEnable(ctx,i);
 assert.equal(snapshots,1);assert.equal(store.settings('g').mode,'enforce');
 }finally{store.close();}
});
test('incident report counts completed, failed and skipped reverts separately',async()=>{
 const {store,security,guild,logs}=setup();try {
 security.punish=async()=> 'Executor banned.';
 const outcomes=['Removed ban for target.','Created channel is already absent.','Webhook edit/deletion cannot be exactly undone; manual review required.','Created channel is already absent.','Created channel is already absent.'];
 security.revert=async()=>outcomes.shift()!;
 for(let n=0;n<5;n++)await security.audit({id:'e'+n,executorId:'actor',targetId:'target'+n,createdTimestamp:Date.now(),action:AuditLogEvent.MemberBanAdd} as any,guild);
 assert.match(store.get('SELECT result FROM incidents WHERE guild_id=?','g')!.result,/1 completed, 1 failed, 3 skipped/);
 const card=logs.at(-1).toJSON();assert.equal(card.description,'<@actor> was **stripped** for triggering anti-nuke.');assert.equal(card.fields.find((f:any)=>f.name==='Changes reverted').value,'1 undone · 1 failed · 3 skipped');assert.equal(card.fields.find((f:any)=>f.name==='Target').value,'`target4`');
 }finally{store.close();}
});

test('permission revert retains pre-existing dangerous bits and later unrelated permission changes',async()=>{
 const {store,security,guild}=setup();try {
 const old=PermissionFlagsBits.ManageChannels, added=PermissionFlagsBits.Administrator, later=PermissionFlagsBits.BanMembers;
 let restored=0n;const role:any={editable:true,managed:false,name:'Staff',permissions:{bitfield:old|added|later},setPermissions:async(value:bigint)=>{restored=value;}};
 guild.roles.fetch=async()=>role;
 await security.revertGrant({action:AuditLogEvent.RoleUpdate,targetId:'role',changes:[{key:'permissions',old:String(old),new:String(old|added)}]} as any,guild);
 assert.equal(restored,old|later);
 }finally{store.close();}
});

test('a newly self-assigned bypass role does not exempt its own assignment',async()=>{
 const {store,security,guild}=setup();try {
 const s=store.settings('g');s.mode='observe';store.save(s);
 const member:any={id:'actor',roles:{cache:new Collection([['staff',{}]])}};guild.members.cache.set('actor',member);guild.members.fetch=async()=>member;
 guild.roles.cache.set('staff',{id:'staff',managed:false,permissions:{bitfield:0n}});store.grant('g','staff','trust_role','owner');
 await security.audit({id:'selfgrant',executorId:'actor',targetId:'actor',createdTimestamp:Date.now(),action:AuditLogEvent.MemberRoleUpdate,changes:[{key:'$add',new:[{id:'staff'}]}]} as any,guild);
 assert.equal(store.all("SELECT * FROM observations WHERE guild_id=? AND rule='role_grant'",'g').length,1);
 }finally{store.close();}
});

test('role grant revert removes a newly assigned bypass from a previously untrusted recipient',async()=>{
 const {store,security,guild}=setup();try {
 let removed:string[]=[];
 const member:any={id:'recipient',roles:{cache:new Collection([['staff',{}]]),remove:async(ids:string[])=>{removed=ids;}}};guild.members.cache.set('recipient',member);guild.members.fetch=async()=>member;
 guild.roles.cache.set('staff',{id:'staff',editable:true,managed:false});store.grant('g','staff','trust_role','owner');
 await security.revert({targetId:'recipient',changes:[{key:'$add',new:[{id:'staff'}]}]} as any,guild,{key:'role_grant'} as any);
 assert.deepEqual(removed,['staff']);
 }finally{store.close();}
});

test('punishment ignores the bypass role newly granted by the triggering self-assignment',async()=>{
 const {store,security,guild}=setup();try {
 guild.members.cache.set('actor',{roles:{cache:new Collection([['staff',{}]])}});store.grant('g','staff','trust_role','owner');
 let called=false;security.contain=async(_guild,_actor,_automatic,ignored)=>{called=true;assert.deepEqual(ignored,['staff']);return 'Contained.';};
 assert.equal(await security.punish(guild,'actor','strip',['staff']),'Contained.');assert.equal(called,true);
 }finally{store.close();}
});


test('readiness excludes only active guild-specific role bypasses and reports them separately',()=>{
 const {store,guild}=setup();try {
 guild.roles.cache.set('higher',{id:'higher',position:12,name:'Ownership',managed:false});
 store.grant('g','higher','trust_role','owner',1);
 const ready=readiness(guild,'log',store);
 assert.deepEqual(ready.above,[]);assert.deepEqual(ready.bypassed,['Ownership']);assert.match(ready.text,/Bypassed roles above Vanguard/);
 store.run('UPDATE grants SET expires=? WHERE guild_id=?',Date.now()-1,'g');
 assert.deepEqual(readiness(guild,'log',store).above,['Ownership']);
 store.grant('g','higher','trust','owner');store.grant('g','higher','bot','owner');
 authorize(store,'other');store.grant('other','higher','trust_role','owner');
 assert.deepEqual(readiness(guild,'log',store).above,['Ownership']);
 store.grant('g','higher','trust_role','owner');store.revokeGrant('g','higher','trust_role','owner');
 assert.deepEqual(readiness(guild,'log',store).above,['Ownership']);
 }finally{store.close();}
});

test('enable lists bypassed high roles separately from ordinary high roles and confirms both',async()=>{
 const {store,guild,actor}=setup();try {
 let snapshots=0;guild.channels.fetch=async()=>null;
 const ctx:any={store,actor,snapshots:{numberOf:(_g:any,id:number)=>id,save:async()=>{snapshots++;return 1;}},logs:{push:()=>{}},policy:enable.metadata,actionKey:'enable'};
 guild.roles.cache.set('higher',{id:'higher',position:12,name:'Ownership',managed:false});
 store.grant('g','higher','trust_role','owner');
 const first=enableInteraction(guild,actor);await enable.execute(ctx,first);
 assert.equal(snapshots,0);assert.match(JSON.stringify(first.replies[0]),/Explicitly bypassed roles at or above Vanguard: Ownership/);
 await confirmEnable(ctx,first);assert.equal(snapshots,1);assert.equal(store.settings('g').enabled,true);
 guild.roles.cache.set('ordinary',{id:'ordinary',position:12,name:'Staff',managed:false});
 const second=enableInteraction(guild,actor);await enable.execute(ctx,second);
 const prompt=JSON.stringify(second.replies[0]);assert.match(prompt,/Unprotected roles at or above Vanguard cannot be contained: Staff/);assert.match(prompt,/Explicitly bypassed roles at or above Vanguard: Ownership/);
 await confirmEnable(ctx,second);assert.equal(snapshots,2);
 }finally{store.close();}
});

test('configured bot owner and developers can manage their own role and user bypasses',async()=>{
 const {store}=setup();const dev='123456789012345678';const wasDeveloper=config.developers.has(dev);config.developers.add(dev);
 try {
  for(const id of [config.ownerId,dev]) {
   const ctx:any={store,actor:{id,roles:{cache:new Collection([['staff',{}]])}},logs:{push:()=>{}}};
   changeTrust(ctx,'g','staff',true,true);assert.equal(store.hasGrant('g','staff','trust_role'),true);
   changeTrust(ctx,'g','staff',true,false);assert.equal(store.hasGrant('g','staff','trust_role'),false);
   changeTrust(ctx,'g',id,false,true);assert.equal(store.hasGrant('g',id,'trust'),true);
   changeTrust(ctx,'g',id,false,false);assert.equal(store.hasGrant('g',id,'trust'),false);
   saveTrust(ctx,'g',id,false,['all'],0);assert.equal(store.hasGrant('g',id,'trust'),true);
   clearTrust(ctx,'g',id,false);assert.equal(store.hasGrant('g',id,'trust'),false);
  }
  const actor='ordinary';const ctx:any={store,actor:{id:actor,roles:{cache:new Collection([['staff',{}]])}},logs:{push:()=>{}}};
  assert.throws(()=>saveTrust(ctx,'g',actor,false,['all'],0),/Another security administrator/);
  assert.throws(()=>saveTrust(ctx,'g','staff',true,['preset:moderation'],0),/Another security administrator/);
  assert.throws(()=>changeTrust(ctx,'g','staff',true,true),/Another security administrator/);
 }finally{if(!wasDeveloper)config.developers.delete(dev);store.close();}
});

test('admins may remove their own bypass; the server owner may grant their own; bot roles can be listed or removed',async()=>{
 const {store}=setup();try {
 const admin:any={store,actor:{id:'actor',guild:{ownerId:'owner'},roles:{cache:new Collection([['staff',{}]])}},logs:{push:()=>{}}};
 store.grant('g','staff','trust_role','someone-else');store.grant('g','actor','trust','someone-else');
 changeTrust(admin,'g','staff',true,false);assert.equal(store.hasGrant('g','staff','trust_role'),false,'removing a held role is allowed');
 changeTrust(admin,'g','actor',false,false);assert.equal(store.hasGrant('g','actor','trust'),false,'removing your own bypass is allowed');
 assert.throws(()=>changeTrust(admin,'g','staff',true,true),/server owner/,'granting yourself is still blocked');
 const owner:any={store,actor:{id:'owner',guild:{ownerId:'owner'},roles:{cache:new Collection([['staff',{}]])}},logs:{push:()=>{}}};
 changeTrust(owner,'g','staff',true,true);assert.equal(store.hasGrant('g','staff','trust_role'),true,'server owner may grant a role they hold');
 saveTrust(admin,'g','botrole',true,['all'],0);assert.equal(store.hasGrant('g','botrole','trust_role'),true,'managed bot roles can be whitelisted');
 }finally{store.close();}
});

test('whitelist panel: pick a duration, re-selecting changes the duration, and removal works for bot roles',async()=>{
 const {store}=setup();
 const GUILD='123456789012345678',USER='223456789012345678',ROLE='323456789012345678';
 const {authorize}=await import('./helpers.js');authorize(store,GUILD);
 try {
  const registry=new Registry();registerAntinukePanel(registry);
  const panel=registry.components.find(c=>c.prefix==='anpanel:')!;
  let last:any;const actor={id:USER,guild:{ownerId:'owner'},roles:{cache:new Collection()}};
  const ctx:any={store,actor,logs:{push:()=>{}}};
  const click=(customId:string,values?:string[])=>panel.execute(ctx,{customId,values,guildId:GUILD,user:{id:USER},guild:{roles:{fetch:async(id:string)=>({id,managed:true})}},editReply:async(p:any)=>{last=p;}} as any);
  const p=`anpanel:${GUILD}:${USER}:`;
  await click(p+'whitelist');
  const ids=()=>last.components.flatMap((r:any)=>r.toJSON().components.map((c:any)=>c.custom_id));
  assert.ok(ids().some((id:string)=>id.startsWith(`tp:${GUILD}:${USER}:`)),'Manage Whitelist opens the new panel');
  await click(p+'duration',['0']);assert.ok(ids().includes(p+'addrole:0'),'permanent selected');
  await click(p+'addrole:0',[ROLE]);
  assert.equal(store.get('SELECT expires FROM grants WHERE guild_id=? AND user_id=?',GUILD,ROLE).expires,null,'permanent');
  await click(p+'addrole:168',[ROLE]);
  const exp=store.get('SELECT expires FROM grants WHERE guild_id=? AND user_id=?',GUILD,ROLE).expires;
  assert.ok(exp>Date.now()+6.9*86400000&&exp<Date.now()+7.1*86400000,'changed to 7 days');
  await assert.rejects(click(p+'addrole:5',[ROLE]),/listed durations/);
  await click(p+'removerole',[ROLE]);assert.equal(store.hasGrant(GUILD,ROLE,'trust_role'),false,'managed role removed');
 } finally {store.close();}
});

test('a rule-only whitelist stops punishment for just that rule (still alerted); every other rule still punishes',async()=>{
 const {store,security,guild}=setup();try {
 const now=Date.now();
 store.grant('g','mod','trust:mass_ban','owner');
 for(const n of [1,2,3,4,5])await security.audit({id:`b${n}`,executorId:'mod',action:AuditLogEvent.MemberBanAdd,targetId:`t${n}`,createdTimestamp:now} as any,guild);
 assert.deepEqual(store.all('SELECT rule,mode FROM incidents').map(r=>`${r.rule}:${r.mode}`),['mass_ban:exempt'],'bans: alert only, not punished');
 for(const n of [1,2,3,4,5])await security.audit({id:`k${n}`,executorId:'mod',action:AuditLogEvent.MemberKick,targetId:`k${n}`,createdTimestamp:now} as any,guild);
 assert.deepEqual(store.all("SELECT rule FROM incidents WHERE mode<>'exempt'").map(r=>r.rule),['mass_kick'],'kicks are still punished');
 }finally{store.close();}
});

test('a rule-only role whitelist works through role membership, and changeTrust/status show the scope',async()=>{
 const {store,security,guild}=setup();try {
 store.grant('g','staffrole','trust_role:mass_ban','owner');
 guild.members.cache.set('mod',{id:'mod',roles:{cache:new Collection([['staffrole',{}]])}});
 assert.equal(security.trustedFor(guild,'mod','mass_ban'),true);
 assert.equal(security.trustedFor(guild,'mod','mass_kick'),false);
 assert.equal(security.trustedFor(guild,'mod','mass_ban',['staffrole']),false,'a role just self-assigned does not count');
 assert.equal(security.trusted(guild,'mod'),false,'not a full bypass');
 const ctx:any={store,actor:{id:'owner',guild:{ownerId:'owner'},roles:{cache:new Collection()}},logs:{push:()=>{}}};
 changeTrust(ctx,'g','someone',false,true,undefined,'timeout');assert.equal(store.hasGrant('g','someone','trust:timeout'),true);
 assert.throws(()=>changeTrust(ctx,'g','someone',false,true,undefined,'not_a_rule'),/Unknown anti-nuke rule/);
 const { antinukeStatus } = await import('../src/ui/antinuke-status.js');
 const d=antinukeStatus(store,'g').toJSON().description!;assert.match(d,/Some rules only:/);assert.match(d,/<@&staffrole> · Ban only/);assert.match(d,/<@someone> · Timeout only/);
 }finally{store.close();}
});

test('whitelist presets grant only their rules, are named in the log, and are removed together',async()=>{
 const {store}=setup();try {
 const logs:any[]=[];const ctx:any={store,actor:{id:'owner',guild:{ownerId:'owner'},roles:{cache:new Collection()}},logs:{push:(_g:any,e:any)=>logs.push(e)}};
 changeTrust(ctx,'g','mod',false,true,undefined,'preset:moderation');
 for(const r of TRUST_PRESETS.moderation!.rules)assert.equal(store.hasGrant('g','mod',`trust:${r}`),true);
 assert.equal(store.hasGrant('g','mod','trust'),false,'a preset is never a full bypass');
 assert.equal(store.hasGrant('g','mod','trust:channel_delete'),false);
 assert.match(JSON.stringify(logs.at(-1)),/Basic moderation/);
 changeTrust(ctx,'g','admins',true,true,24,'preset:administrator');
 for(const risky of ['bot_add','dangerous_grant','member_prune'])assert.equal(store.hasGrant('g','admins',`trust_role:${risky}`),false);
 let reply:any;const i:any={guildId:'g',user:{id:'owner'},editReply:async(r:any)=>{reply=r;},options:{getSubcommand:()=>'list',getBoolean:()=>false,getInteger:()=>null}};
 await trust.execute({...ctx,actor:ctx.actor},i);const list=reply.embeds[0].toJSON().description as string;
 assert.deepEqual(reply.components[0].toJSON().components.map((b:any)=>b.label),['< Prev','Refresh','Next >'],'the list has paging and a refresh button');
 assert.match(list,/<@mod> · \*\*Basic moderation/);assert.match(list,/<@&admins> · \*\*Administrator/);
 changeTrust(ctx,'g','mod',false,false,undefined,'preset:moderation');
 for(const r of TRUST_PRESETS.moderation!.rules)assert.equal(store.hasGrant('g','mod',`trust:${r}`),false);
 assert.equal(scopeName(['mass_ban']),'Ban members only');
 changeTrust(ctx,'g','admins',true,false);assert.equal(store.all("SELECT 1 FROM grants WHERE user_id='admins'").length,0,'empty rule removes every bypass');
 assert.throws(()=>changeTrust(ctx,'g','admins',true,false),/no anti-nuke bypass/);
 }finally{store.close();}
});

test('trust panel: save replaces what they had, presets expand, Everything wins, and the panel reloads saved choices',async()=>{
 const {store}=setup();try {
 const logs:any[]=[];const ctx:any={store,actor:{id:'owner',guild:{ownerId:'owner'},roles:{cache:new Collection()}},logs:{push:(_g:any,e:any)=>logs.push(e)}};
 const T='444444444444444444';
 assert.deepEqual(kindsFor(['all','mass_ban'],false),['trust']);
 assert.deepEqual(kindsFor(['preset:moderation','mass_ban'],true).sort(),['trust_role:mass_ban','trust_role:mass_kick','trust_role:mass_unban','trust_role:timeout']);
 saveTrust(ctx,'g',T,false,['all'],0);assert.equal(store.hasGrant('g',T,'trust'),true);
 saveTrust(ctx,'g',T,false,['preset:moderation','role_grant'],24);
 assert.equal(store.hasGrant('g',T,'trust'),false,'saving replaces the old full bypass');
 for(const k of ['mass_ban','mass_kick','timeout','role_grant'])assert.equal(store.hasGrant('g',T,`trust:${k}`),true);
 const state=panelFor(ctx,'g',T,false);assert.equal(state.hours,24);
 const panel=trustPanel(ctx,'g','555555555555555555',state);
 const allow=(panel.components[2]!.toJSON() as any).components[0];
 assert.deepEqual(allow.options.filter((o:any)=>o.default).map((o:any)=>o.value).sort(),['preset:moderation','role_grant']);
 for(const row of panel.components)for(const c of (row.toJSON() as any).components)assert.ok(c.custom_id.length<=100,c.custom_id);
 assert.match(JSON.stringify(panel.embeds[0]!.toJSON()),/Saved right now/);
 clearTrust(ctx,'g',T,false);assert.equal(store.all('SELECT 1 FROM grants WHERE user_id=?',T).length,0);
 assert.throws(()=>clearTrust(ctx,'g',T,false),/no anti-nuke bypass/);
 assert.throws(()=>saveTrust(ctx,'g',T,false,[],0),/Tick at least one/);
 const registry=new Registry();registerTrustPanel(registry);
 await assert.rejects(registry.components[0]!.execute(ctx,{customId:`tp:111111111111111111:222222222222222222:save:u${T}:0:1`,guildId:'333333333333333333',user:{id:'222222222222222222'}} as any),/belongs to someone else/);
 }finally{store.close();}
});

test('whitelisted people are recorded quietly (no cards) unless ALERT_EXEMPT=true; a partial whitelist says what is missing',async()=>{
 const saved=process.env.ALERT_EXEMPT;
 try {
  let {store,security,guild,logs}=setup();
  store.grant('g','mod','trust','owner');
  process.env.ALERT_EXEMPT='';
  for(const n of [1,2,3,4,5])await security.audit({id:`q${n}`,executorId:'mod',action:AuditLogEvent.MemberBanAdd,targetId:`t${n}`,createdTimestamp:Date.now()} as any,guild);
  assert.deepEqual(store.all('SELECT mode FROM incidents').map(r=>r.mode),['exempt'],'still recorded');
  assert.equal(logs.length,0,'but no card in the log');
  store.close();
  ({store,security,guild,logs}=setup());
  store.grant('g','mod','trust','owner');
  process.env.ALERT_EXEMPT='true';
  for(const n of [1,2,3,4,5])await security.audit({id:`r${n}`,executorId:'mod',action:AuditLogEvent.MemberBanAdd,targetId:`t${n}`,createdTimestamp:Date.now()} as any,guild);
  assert.match(JSON.stringify(logs.at(-1).toJSON()),/not punished/,'ALERT_EXEMPT=true brings the card back');
  store.close();
  ({store,security,guild,logs}=setup());
  store.grant('g','mod','trust:mass_ban','owner');store.grant('g','mod','trust:timeout','owner');
  security.punish=async()=>'Removed 1 dangerous role(s).';
  for(const n of [1,2,3,4,5])await security.audit({id:`k${n}`,executorId:'mod',action:AuditLogEvent.MemberKick,targetId:`k${n}`,createdTimestamp:Date.now()} as any,guild);
  const card=logs.at(-1).toJSON();
  assert.equal(card.title,'Anti-nuke Triggered');
  assert.match(card.fields.find((f:any)=>f.name==='Whitelist').value,/but not for \*\*Kick\*\*/);
  store.close();
 } finally {process.env.ALERT_EXEMPT=saved??'';}
});
