import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { BOT_STAFF_IDS, SERVER_STAFF_IDS } from '../src/bot/access-ids.js';
import { botRank, rankOf, RANKS } from '../src/bot/ranks.js';
import { Guard } from '../src/bot/guard.js';
import { defaults } from '../src/bot/registry.js';
import { decideRoleChange } from '../src/security/role-policy.js';
import { enforceProtectedRoles } from '../src/security/protected-roles.js';
import staff from '../src/commands/configuration/staff.js';
import dev from '../src/commands/developer/dev.js';
import { previewHistory } from '../src/ui/config-history.js';

const G = '123456789012345678', U = '234567890123456789', D = '345678901234567890', ROLE = '456789012345678901';
function fixture() {
    const store = new Store(':memory:'); authorize(store, G);
    const actor: any = { id: U, guild: { id: G, ownerId: U }, permissions: new PermissionsBitField(), roles: { cache: new Collection(), highest: { comparePositionTo: () => 10 } } };
    const ctx: any = { store, actor, logs: { push: () => {} } };
    return { store, actor, ctx };
}

test('source IDs give local ranks in one server and bot ranks only when explicitly configured', () => {
    const {store, actor} = fixture();
    try {
        SERVER_STAFF_IDS[G] = { [U]: 'moderator' };
        actor.guild.ownerId = 'someone-else';
        assert.equal(rankOf(store, G, U, actor), RANKS.moderator);
        assert.equal(rankOf(store, 'another-server', U), 0);
        assert.equal(botRank(store, U), 0);
        BOT_STAFF_IDS.botmanager = [U];
        assert.equal(botRank(store, U), RANKS.botmanager);
        BOT_STAFF_IDS.developer = [D];
        assert.equal(botRank(store, D), RANKS.developer);
    } finally { delete SERVER_STAFF_IDS[G]; delete BOT_STAFF_IDS.botmanager; delete BOT_STAFF_IDS.developer; store.close(); }
});

test('bot-wide ranks, security admins and permission-role overrides stay Developer-only; server ranks do not', () => {
    const {store,actor}=fixture();
    try {
        const guard=new Guard(store);
        const can=(id:string,key:string,m:any=actor)=>guard.allowed(defaults,G,id,m,key.split('/')[0],key);
        // The server owner (and Developers) assign server ranks themselves; nobody below Head Admin can.
        assert.equal(can(U,'staff/role'),true,'the server owner may change server ranks');
        assert.equal(can(U,'staff/user'),true);
        for (const key of ['staff/global','security/admin'])
            assert.equal(can(U,key),false,`${key} stays bot management`);
        assert.equal(can(U,'guild-config/permission-role'),true,"permission-role assignments are the owner's server work");
        // A Supreme Leader is bot-wide staff, not the owner: server ranks are in reach (below their own),
        // bot management is not.
        const supreme:any={...actor,id:'supreme-users',guild:{id:G,ownerId:'someone-else'}};
        BOT_STAFF_IDS.supreme=['supreme-users'];
        assert.equal(can('supreme-users','staff/role',supreme),true,'a Supreme Leader can change server ranks');
        for (const key of ['staff/global','security/admin','guild-config/permission-role'])
            assert.equal(can('supreme-users',key,supreme),false,`Supreme Leaders cannot hand out ${key}`);
        delete BOT_STAFF_IDS.supreme;
        BOT_STAFF_IDS.developer=[D];
        for (const key of ['staff/user','staff/role','staff/global','security/admin','guild-config/permission-role'])
            assert.equal(can(D,key),true,key);
    }finally {delete BOT_STAFF_IDS.supreme;delete BOT_STAFF_IDS.developer;store.close();}
});

test('direct user-ID command replaces and removes only the local direct rank, and nobody assigns at or above their own rank', async () => {
    const {store,ctx}=fixture();
    const i:any={guildId:G,user:{id:U},client:{users:{fetch:async(id:string)=>({id,bot:false})}},options:{getSubcommand:()=> 'user',getString:(key:string)=>key==='user_id'?U:'admin'}};
    try {
        // A Head Admin may hand out Admin (below them) but never Head Admin or higher.
        const head:any={...ctx.actor,id:'head',guild:{id:G,ownerId:U},roles:{cache:new Collection([['r-head',{}]]),highest:{}}};
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'headadmin')",G,'r-head');
        ctx.actor=head;i.user.id='head';
        await staff.execute(ctx,i);
        assert.equal(rankOf(store,G,U),RANKS.admin);
        i.options.getString=(key:string)=>key==='user_id'?U:'headadmin';
        await assert.rejects(async()=>staff.execute(ctx,i),/equal to or above your own rank/);
        // A plain moderator cannot change ranks at all.
        const mod:any={...ctx.actor,id:'mod',roles:{cache:new Collection([['r-mod',{}]]),highest:{}}};
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'moderator')",G,'r-mod');
        ctx.actor=mod;i.user.id='mod';
        i.options.getString=(key:string)=>key==='user_id'?U:'admin';
        await assert.rejects(async()=>staff.execute(ctx,i),/Head Admins and above/);
        // The server owner and Developers are exempt.
        ctx.actor=head.guild.ownerId===U?{...ctx.actor,id:U,guild:{id:G,ownerId:U},roles:{cache:new Collection(),highest:{}}}:ctx.actor;
        i.user.id=U;
        BOT_STAFF_IDS.developer=[D];i.user.id=D;
        await staff.execute(ctx,i);
        assert.equal(rankOf(store,G,U),RANKS.admin);
        assert.equal(rankOf(store,'elsewhere',U),0);
        i.options.getString=(key:string)=>key==='user_id'?U:'helper';
        await staff.execute(ctx,i);
        assert.equal(rankOf(store,G,U),RANKS.helper);
        i.options.getString=(key:string)=>key==='user_id'?U:'none';
        await staff.execute(ctx,i);
        assert.equal(rankOf(store,G,U),0);
        i.options.getString=(key:string)=>key==='user_id'?'invalid':'admin';
        await assert.rejects(async()=>staff.execute(ctx,i),/Discord user ID/);
    }finally{delete BOT_STAFF_IDS.developer;store.close();}
});

test('a role that carries a Vanguard rank can only be given by someone above that rank',()=>{
    const {store}=fixture();
    try{
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'helper')",G,ROLE);
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'helper')",G,'r-helper');
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'admin')",G,'r-admin');
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'grant','user',?,?,0)",G,ROLE,U,D);
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'allow','','',?,0)",G,ROLE,D);
        const role:any={id:ROLE,managed:false,permissions:new PermissionsBitField()};
        const guild:any={id:G,ownerId:'someone-else'};
        const as=(id:string,roles:string[],owner=false)=>({id,guild:{id:G,ownerId:owner?id:'someone-else'},permissions:new PermissionsBitField(),roles:{cache:new Collection(roles.map(r=>[r,{}])),highest:{comparePositionTo:()=>10}}});
        const target:any={id:'target',roles:{cache:new Collection(),highest:{comparePositionTo:()=>0}}};
        const call=(actor:any,op:'add'|'remove')=>decideRoleChange({store,guild,actor,target,role,me:actor,op});
        assert.equal(call(as(U,['r-helper']),'add').ok,false,'a Helper cannot hand out an equal rank');
        assert.equal(call(as(U,['r-admin']),'add').ok,true,'an Admin can hand out a rank below their own');
        assert.equal(call(as(U,['r-admin']),'remove').ok,true,'and take it away');
        BOT_STAFF_IDS.developer=[U];
        assert.equal(call(as(U,[]),'add').ok,true,'Developers are exempt');
    }finally{delete BOT_STAFF_IDS.developer;store.close();}
});

test('audit enforcement undoes unauthorized additions and removals, including owner actions',async()=>{
    const {store}=fixture();
    try{
        store.run("INSERT INTO permission_roles(guild_id,role_id,access,by_id) VALUES(?,?,'moderator',?)",G,ROLE,D);
        const cache=new Collection<string,any>([[ROLE,{}]]),calls:string[]=[];
        const member:any={roles:{cache,remove:async(ids:string[])=>{calls.push('remove');ids.forEach(id=>cache.delete(id));},add:async(ids:string[])=>{calls.push('add');ids.forEach(id=>cache.set(id,{}));}}};
        const guild:any={id:G,ownerId:U,client:{user:{id:'bot'}},members:{fetch:async()=>member}};
        const logs:any={push:()=>{}};
        const entry:any={action:AuditLogEvent.MemberRoleUpdate,executorId:U,targetId:'target',changes:[{key:'$add',new:[{id:ROLE}]}]};
        assert.deepEqual(await enforceProtectedRoles(store,logs,entry,guild),[ROLE]);
        entry.changes[0].key='$remove';
        assert.deepEqual(await enforceProtectedRoles(store,logs,entry,guild),[ROLE]);
        assert.deepEqual(calls,['remove','add']);
        BOT_STAFF_IDS.developer=[D];entry.executorId=D;
        assert.deepEqual(await enforceProtectedRoles(store,logs,entry,guild),[]);
        assert.equal(calls.length,2);
    }finally{delete BOT_STAFF_IDS.developer;store.close();}
});

test('permission history cannot be used by the server owner to bypass assignment restrictions',async()=>{
    const {store,ctx}=fixture();
    try{
        store.grant(G,U,'admin',D);
        const row=store.get("SELECT id FROM configuration_history WHERE guild_id=? AND component='grant'",G)!;
        await assert.rejects(previewHistory(ctx,{guildId:G,user:{id:U}},row.id),/developers/);
    }finally{store.close();}
});


test('changing a role rank clears legacy access rather than leaving a hidden higher rank', async () => {
    const { store, ctx } = fixture();
    try {
        BOT_STAFF_IDS.developer = [D];
        ctx.actor.id = D;
        store.run("INSERT INTO permission_roles(guild_id,role_id,access,by_id) VALUES(?,?,'admin',?)", G, ROLE, D);
        const i: any = { guildId: G, user: { id: D }, options: { getSubcommand: () => 'role', getRole: () => ({ id: ROLE, managed: false }), getString: () => 'helper' } };
        await staff.execute(ctx, i);
        assert.equal(store.get('SELECT 1 FROM permission_roles WHERE guild_id=? AND role_id=?', G, ROLE), undefined);
        assert.equal(store.get('SELECT level FROM staff_roles WHERE guild_id=? AND role_id=?', G, ROLE)?.level, 'helper');
        i.options.getString = () => 'none';
        await staff.execute(ctx, i);
        assert.equal(store.get('SELECT 1 FROM staff_roles WHERE guild_id=? AND role_id=?', G, ROLE), undefined);
    } finally { delete BOT_STAFF_IDS.developer; store.close(); }
});


test('quarantine suspends ID-based command access until an authorized recovery', () => {
    const { store, actor } = fixture();
    try {
        actor.guild.ownerId = 'server-owner';
        SERVER_STAFF_IDS[G] = { [U]: 'headadmin' };
        const guard = new Guard(store);
        assert.equal(guard.allowed(defaults, G, U, actor, 'antinuke', 'antinuke/status'), true);
        store.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1)', G, U, '[]', Date.now());
        assert.equal(guard.allowed(defaults, G, U, actor, 'antinuke', 'antinuke/status'), false);
        store.grant(G, U, 'staff:headadmin', D);
        assert.equal(guard.allowed(defaults, G, U, actor, 'role', 'role/add'), false);
        assert.equal(guard.allowed({ ...defaults, requiresAuthorization: false }, G, U, actor, 'help', 'help'), true);
        BOT_STAFF_IDS.supreme = [U];
        assert.equal(guard.allowed({ ...dev.metadata, ...dev.subcommands?.status }, G, U, actor, 'dev', 'dev/status'), false, 'bot-wide rank is also suspended in the quarantining server, even for tools that do not require server authorization');
        const owner = { ...actor, id: 'server-owner' };
        assert.equal(guard.allowed(defaults, G, owner.id, owner, 'security', 'security/release'), true);
        BOT_STAFF_IDS.developer = [D];
        assert.equal(guard.allowed(defaults, G, D, actor, 'security', 'security/release'), true);
        store.run('UPDATE backups SET active=0 WHERE guild_id=? AND user_id=?', G, U);
        assert.equal(guard.allowed(defaults, G, U, actor, 'antinuke', 'antinuke/status'), true);
    } finally { delete SERVER_STAFF_IDS[G]; delete BOT_STAFF_IDS.supreme; delete BOT_STAFF_IDS.developer; store.close(); }
});
