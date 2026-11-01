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

test('all rank assignment routes require Developer IDs, even for owners and bot-wide staff', () => {
    const {store,actor}=fixture();
    try {
        const keys=['staff/user','staff/role','staff/global','security/admin','guild-config/permission-role'];
        const guard=new Guard(store);
        for (const key of keys) assert.equal(guard.allowed(defaults,G,U,actor,key.split('/')[0],key),false,key);
        BOT_STAFF_IDS.supreme=[U];
        for (const key of keys) assert.equal(guard.allowed(defaults,G,U,actor,key.split('/')[0],key),false,key);
        BOT_STAFF_IDS.developer=[D];
        for (const key of keys) assert.equal(guard.allowed(defaults,G,D,actor,key.split('/')[0],key),true,key);
    }finally {delete BOT_STAFF_IDS.supreme;delete BOT_STAFF_IDS.developer;store.close();}
});

test('direct user-ID command replaces and removes only the local direct rank, and refuses non-developers', async () => {
    const {store,ctx}=fixture();
    const i:any={guildId:G,user:{id:U},client:{users:{fetch:async(id:string)=>({id,bot:false})}},options:{getSubcommand:()=> 'user',getString:(key:string)=>key==='user_id'?U:'admin'}};
    try {
        await assert.rejects(async()=>staff.execute(ctx,i),/developers/);
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

test('owner-approved role rules cannot delegate bot permission roles, on add or remove',()=>{
    const {store,actor}=fixture();
    try{
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'helper')",G,ROLE);
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'grant','user',?,?,0)",G,ROLE,U,D);
        const role:any={id:ROLE,managed:false,permissions:new PermissionsBitField()};
        const change:any={store,guild:actor.guild,actor,target:{id:'target',roles:{cache:new Collection(),highest:{}}},role,me:actor};
        for(const op of ['add','remove'])assert.equal(decideRoleChange({...change,op}).ok,false);
        BOT_STAFF_IDS.developer=[U];
        assert.equal(decideRoleChange({...change,op:'add'}).ok,true);
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
