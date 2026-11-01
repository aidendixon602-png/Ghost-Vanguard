import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PermissionsBitField } from 'discord.js';
import { blockedDomain, domain, suspiciousText, fingerprint, imageMatch, attachmentUrl, downloadImage, MAX_IMAGE_BYTES } from '../src/security/scam-matching.js';
import { ScamProtection } from '../src/security/scam.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { Guard } from '../src/bot/guard.js';
import definition from '../src/commands/security/scam.js';

const guildId='223456789012345678', userId='323456789012345678';
function fixture() {
    const store=new Store(':memory:');store.settings(guildId);authorize(store,guildId);
    store.run('INSERT INTO scam_config VALUES(?,1,0)',guildId);
    store.run('INSERT INTO scam_domains VALUES(?,?)',guildId,'bad.example');
    const events:string[]=[], alerts:any[]=[];
    const guild:any={id:guildId,ownerId:'owner',client:{user:{id:'bot'}},members:{fetch:async()=>({bannable:true,ban:async()=>events.push('ban')})}};
    const message:any={id:'message',guild,channelId:'channel',channel:{isThread:()=>false},content:'claim https://bad.example/reward',embeds:[],attachments:new Map(),author:{id:userId,bot:false},webhookId:null,editedTimestamp:null,
        fetch:async()=>message,delete:async()=>events.push('delete')};
    const scanner=new ScamProtection(store,{push:(_id:any,e:any)=>alerts.push(e.toJSON())} as any);
    scanner.initialize=async()=>true;
    return {store,guild,message,scanner,events,alerts};
}

test('blocked domains use host boundaries, subdomains and URL parsing',()=>{
    assert.equal(domain('BAD.Example.'),'bad.example');
    for(const text of ['https://bad.example/a','https://promo.bad.example','bad.example','[gift](https://bad.example)']) assert.equal(blockedDomain(text,['bad.example']),'bad.example');
    for(const text of ['https://notbad.example','https://bad.example.good.example','https://good.example/bad.example','https://bad.example@good.example/']) assert.equal(blockedDomain(text,['bad.example']),null,text);
    assert.throws(()=>domain('https://bad.example'));assert.throws(()=>domain('bad.example/path'));assert.throws(()=>domain('example'));
});
test('text patterns require combinations and stay review only',()=>{
    assert.equal(suspiciousText('I watched MrBeast yesterday'),false);
    assert.equal(suspiciousText('Mr\u200bbeast crypto casino promo $5,000'),true);
    assert.equal(suspiciousText('free Nitro https://bad.example'),true);
    assert.equal(suspiciousText('crypto is risky'),false);
});
test('exact decoded images confirm; lossy/resized copies are only similar',async()=>{
    const raw=Buffer.alloc(32*32*3);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const at=(y*32+x)*3;raw[at]=x*7;raw[at+1]=y*7;raw[at+2]=(x+y)*3;}
    const image=sharp(raw,{raw:{width:32,height:32,channels:3}});
    const png=await image.clone().png().toBuffer(), compressed=await image.clone().png({compressionLevel:0}).toBuffer();
    const a=await fingerprint(png);assert.equal(imageMatch(a,await fingerprint(compressed)),'confirmed');
    const resized=await image.clone().resize(64,64).png().toBuffer();assert.equal(imageMatch(a,await fingerprint(resized)),'similar');
    const jpeg=await image.clone().jpeg().toBuffer();assert.notEqual(imageMatch(a,await fingerprint(jpeg)),'confirmed');
    assert.throws(()=>attachmentUrl('https://127.0.0.1/attachments/file.png'));
    assert.throws(()=>attachmentUrl('https://cdn.discordapp.com.evil.example/attachments/x'));
    assert.throws(()=>attachmentUrl('http://cdn.discordapp.com/attachments/x'));
    assert.throws(()=>attachmentUrl('https://cdn.discordapp.com:444/attachments/x'));
    assert.throws(()=>attachmentUrl('https://cdn.discordapp.com/icons/x'));
    await assert.rejects(()=>fingerprint(Buffer.from('not an image')));
    await assert.rejects(()=>fingerprint(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')));
});
test('attachment download blocks SSRF and enforces streamed size even with missing length',async()=>{
    let calls=0;
    await assert.rejects(()=>downloadImage('https://private.example/x',4,(async()=>{calls++;}) as any));assert.equal(calls,0);
    await assert.rejects(()=>downloadImage('https://cdn.discordapp.com/attachments/x',MAX_IMAGE_BYTES+1));
    const fetcher:any=async(_url:any,opts:any)=>{assert.equal(opts.redirect,'error');return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_IMAGE_BYTES));c.enqueue(new Uint8Array(1));c.close();}}));};
    await assert.rejects(()=>downloadImage('https://cdn.discordapp.com/attachments/x',10,fetcher),/limit/);
});
test('confirmed match deletes/bans once despite repeated create/update delivery',async()=>{
    const f=fixture();await Promise.all([f.scanner.process(f.message),f.scanner.process(f.message)]);
    assert.deepEqual(f.events,['delete','ban']);assert.equal(f.alerts.length,1);assert.equal(f.store.all('SELECT * FROM scam_events').length,1);f.store.close();
});
test('Administrator is not exempt; bot hierarchy blocks ban while deletion still works',async()=>{
    const f=fixture();f.guild.members.fetch=async()=>({permissions:new PermissionsBitField(8n),bannable:false});await f.scanner.process(f.message);
    assert.deepEqual(f.events,['delete']);assert.match(f.alerts[0].description,/Ban skipped/);f.store.close();
});
test('owner is scanned/deleted but never auto-banned',async()=>{
    const f=fixture();f.guild.ownerId=userId;await f.scanner.process(f.message);assert.deepEqual(f.events,['delete']);assert.match(f.alerts[0].description,/protected owner/);f.store.close();
});
test('reporting-channel and thread exclusions prevent actions and downloads',async()=>{
    const f=fixture();f.store.run('INSERT INTO scam_exclusions VALUES(?,?)',guildId,'reports');f.message.channel={isThread:()=>true,parentId:'reports'};
    await f.scanner.process(f.message);assert.deepEqual(f.events,[]);assert.equal(f.alerts.length,0);f.store.close();
});
test('disabled, unauthorized, webhook and bot messages are skipped',async()=>{
    for(const mode of ['disabled','unauthorized','webhook','bot']) {
        const f=fixture();if(mode==='disabled')f.store.run('UPDATE scam_config SET enabled=0');
        if(mode==='unauthorized')f.store.run("UPDATE guild_authorization SET state='DEAUTHORIZED'");
        if(mode==='webhook')f.message.webhookId='hook';if(mode==='bot')f.message.author.bot=true;
        await f.scanner.process(f.message);assert.deepEqual(f.events,[],mode);assert.equal(f.alerts.length,0);f.store.close();
    }
});
test('suspicious text alerts without punishment; edited blocked link then enforces',async()=>{
    const f=fixture();f.message.content='MrBeast crypto casino promo giveaway';await f.scanner.process(f.message);
    assert.deepEqual(f.events,[]);assert.match(f.alerts[0].description,/review only/);
    f.message.content='https://bad.example';f.message.editedTimestamp=10;await f.scanner.process(f.message);
    assert.deepEqual(f.events,['delete','ban']);assert.equal(f.alerts.length,2);f.store.close();
});
test('edit during analysis aborts enforcement; deletion failure does not prevent ban',async()=>{
    const f=fixture();let calls=0;f.message.fetch=async()=>{if(++calls===1){f.message.content='harmless';f.message.editedTimestamp=10;}return f.message;};
    await f.scanner.process(f.message);assert.deepEqual(f.events,[]);f.store.close();
    const g=fixture();g.message.delete=async()=>{throw new Error('missing permission');};await g.scanner.process(g.message);
    assert.deepEqual(g.events,['ban']);assert.match(g.alerts[0].description,/deletion failed/);g.store.close();
});
test('scam management requires internal security access and Manage Guild permission',()=>{
    const f=fixture(),guard=new Guard(f.store);
    const actor:any={id:userId,guild:{id:guildId,ownerId:'owner'},permissions:new PermissionsBitField(8n),roles:{cache:new Map()}};
    assert.equal(guard.allowed(definition.metadata,guildId,userId,actor),false);
    f.store.grant(guildId,userId,'admin','owner');assert.equal(guard.allowed(definition.metadata,guildId,userId,actor),true);
    actor.permissions=new PermissionsBitField(0n);assert.equal(guard.allowed(definition.metadata,guildId,userId,actor),false);f.store.close();
});
test('preloaded screenshot references exist and per-server custom records remain isolated',async()=>{
    const f=fixture();const seeds=await f.scanner.seeds();assert.equal(seeds.length,3);assert.equal(seeds.every(s=>s.id.startsWith('seed-')),true);
    f.store.save(f.store.settings('423456789012345678'));f.store.run('INSERT INTO scam_domains VALUES(?,?)','423456789012345678','other.example');
    assert.equal(blockedDomain('https://other.example',f.store.all('SELECT domain FROM scam_domains WHERE guild_id=?',guildId).map(r=>r.domain)),null);f.store.close();
});

test('image scanner enforces exact references but only alerts on resized references',async()=>{
    const raw=Buffer.alloc(32*32*3);for(let n=0;n<raw.length;n++)raw[n]=n%255;
    const image=sharp(raw,{raw:{width:32,height:32,channels:3}}), original=await image.clone().png().toBuffer(), fp=await fingerprint(original);
    const realFetch=globalThis.fetch;
    try {
        for(const exact of [true,false]) {
            const f=fixture();f.message.content='image';const bytes=exact?original:await image.clone().resize(64,64).png().toBuffer();
            f.message.attachments.set('attachment',{id:'attachment',name:'example.png',url:'https://cdn.discordapp.com/attachments/test/example.png',size:bytes.length,contentType:'image/png'});
            f.scanner.references=async()=>[{id:'reference',name:'Confirmed scam',...fp}];globalThis.fetch=(async()=>new Response(bytes)) as any;
            await f.scanner.process(f.message);
            assert.deepEqual(f.events,exact?['delete','ban']:[]);assert.equal(f.alerts.length,1);assert.match(f.alerts[0].description,exact?/Known scam image/:/Similar to scam image/);f.store.close();
        }
    } finally {globalThis.fetch=realFetch;}
});
test('enabling refuses missing Message Content access and reports paused automatic setup',async()=>{
    const f=fixture();const ctx:any={store:f.store,logs:{push:()=>{}},assertActive:()=>{},client:{options:{intents:{has:()=>false}}}};
    const i:any={guildId,user:{id:userId},options:{getSubcommand:()=> 'enable'},guild:{id:guildId,members:{fetchMe:async()=>({permissions:new PermissionsBitField(8n)})}}};
    await assert.rejects(()=>definition.execute(ctx,i),/Message Content/);
    ctx.client.options.intents.has=()=>true;assert.match(await definition.execute(ctx,i) as string,/paused/);f.store.close();
});

function automaticFixture() {
    const store=new Store(':memory:');store.save(store.settings(guildId));authorize(store,guildId);
    const channels=new Map<string,any>(), created:any[]=[],alerts:any[]=[];
    const me:any={id:'bot',permissions:new PermissionsBitField(8n)};
    const guild:any={id:guildId,client:{options:{intents:{has:()=>true}},user:{id:'bot'}},members:{fetchMe:async()=>me},channels:{
        fetch:async(id?:string)=>id?channels.get(id)??null:{find:(fn:any)=>[...channels.values()].find(fn)},
        create:async(options:any)=>{created.push(options);const channel={id:'auto-log',type:0,topic:options.topic,isSendable:()=>true,permissionsFor:()=>new PermissionsBitField(8n)};channels.set(channel.id,channel);return channel;}}};
    const scanner=new ScamProtection(store,{push:(_id:any,e:any)=>alerts.push(e.toJSON())} as any);
    return {store,guild,me,channels,created,alerts,scanner};
}
test('automatic startup creates one private log and enables an unconfigured authorized server',async()=>{
    const f=automaticFixture();assert.equal((await import('../src/security/scam.js')).scamConfig(f.store,guildId).enabled,1);
    assert.deepEqual(await Promise.all([f.scanner.initialize(f.guild),f.scanner.initialize(f.guild)]),[true,true]);
    assert.equal(f.created.length,1);assert.equal(f.created[0].name,'vanguard-security');assert.deepEqual(f.created[0].permissionOverwrites[0],{id:guildId,deny:[1024n]});
    assert.equal(f.store.settings(guildId).logChannelId,'auto-log');assert.equal(f.store.get('SELECT enabled FROM scam_config WHERE guild_id=?',guildId)?.enabled,1);
    const restarted=new ScamProtection(f.store,{push:()=>{}} as any);assert.equal(await restarted.initialize(f.guild),true);assert.equal(f.created.length,1);f.store.close();
});
test('automatic startup preserves explicit disables, exclusions and configured log channels',async()=>{
    const f=automaticFixture();f.store.run('INSERT INTO scam_config VALUES(?,0,0)',guildId);f.store.run('INSERT INTO scam_exclusions VALUES(?,?)',guildId,'reports');
    assert.equal(await f.scanner.initialize(f.guild),false);assert.equal(f.created.length,0);
    f.store.run('UPDATE scam_config SET enabled=1 WHERE guild_id=?',guildId);
    const settings=f.store.settings(guildId);settings.logChannelId='existing-log';f.store.save(settings);
    f.channels.set('existing-log',{id:'existing-log',isSendable:()=>true,permissionsFor:()=>new PermissionsBitField(8n)});
    assert.equal(await f.scanner.initialize(f.guild),true);assert.equal(f.created.length,0);assert.equal(f.store.all('SELECT * FROM scam_exclusions WHERE guild_id=?',guildId).length,1);f.store.close();
});
test('automatic startup pauses without required permissions or intent and never changes unauthorized servers',async()=>{
    for(const mode of ['permission','intent','unauthorized']){
        const f=automaticFixture();if(mode==='permission')f.me.permissions=new PermissionsBitField(0n);
        if(mode==='intent')f.guild.client.options.intents.has=()=>false;
        if(mode==='unauthorized')f.store.run("UPDATE guild_authorization SET state='DEAUTHORIZED'");
        assert.equal(await f.scanner.initialize(f.guild),false);assert.equal(f.created.length,0);assert.equal(f.store.get('SELECT 1 FROM scam_config WHERE guild_id=?',guildId),undefined);f.store.close();
    }
});
test('automatic retries recover after permissions improve without creating duplicate logs',async()=>{
    const f=automaticFixture();f.me.permissions=new PermissionsBitField(0n);assert.equal(await f.scanner.initialize(f.guild),false);
    f.me.permissions=new PermissionsBitField(8n);f.scanner.clearGuild(guildId);assert.equal(await f.scanner.initialize(f.guild),true);
    assert.equal(f.created.length,1);assert.equal(await f.scanner.initialize(f.guild),true);assert.equal(f.created.length,1);f.store.close();
});
test('automatic channel setup preserves settings edited while the channel API is in flight',async()=>{
    const f=automaticFixture(),create=f.guild.channels.create;
    f.guild.channels.create=async(options:any)=>{const settings=f.store.settings(guildId);settings.minAge=77;f.store.save(settings);return create(options);};
    assert.equal(await f.scanner.initialize(f.guild),true);assert.equal(f.store.settings(guildId).minAge,77);f.store.close();
});

test('disguised links are normalized: fullwidth/ideographic dots, invisible characters and escapes',()=>{
    for(const text of ['https://bad。example/x','bad．example','https://ba​d.example','bad\\.example','ｂａｄ.example'])
        assert.equal(blockedDomain(text,['bad.example']),'bad.example',JSON.stringify(text));
    assert.equal(blockedDomain('nothing here',[]),null);
});
test('ordinary cached messages without links or images cause no API calls or scans',async()=>{
    const f=fixture();let fetches=0;f.message.fetch=async()=>{fetches++;return f.message;};f.message.content='hello everyone, see you at 5';
    let inits=0;f.scanner.initialize=async()=>{inits++;return true;};
    await f.scanner.process(f.message);assert.equal(fetches,0);assert.equal(inits,0);assert.deepEqual(f.events,[]);f.store.close();
});
test('partial messages are fetched before scanning',async()=>{
    const f=fixture();const full=f.message;const partial:any={id:full.id,guild:full.guild,channelId:full.channelId,channel:full.channel,partial:true,author:null,fetch:async()=>full};
    await f.scanner.process(partial);assert.deepEqual(f.events,['delete','ban']);f.store.close();
});
test('forwarded scam links are scanned',async()=>{
    const f=fixture();f.message.content='';f.message.messageSnapshots=new Map([['s',{content:'https://bad.example/claim',embeds:[],attachments:new Map()}]]);
    await f.scanner.process(f.message);assert.deepEqual(f.events,['delete','ban']);f.store.close();
});
test('a sender who already left is banned by ID',async()=>{
    const f=fixture();f.guild.members.fetch=async()=>{throw new Error('Unknown Member');};f.guild.bans={create:async(id:string)=>f.events.push(`ban-id:${id}`)};
    await f.scanner.process(f.message);assert.deepEqual(f.events,['delete',`ban-id:${userId}`]);assert.match(f.alerts[0].description,/no longer in the server/);f.store.close();
});
test('oversized or unreadable images alone never alert staff, and are not downloaded when oversized',async()=>{
    const realFetch=globalThis.fetch;let downloads=0;
    try {
        globalThis.fetch=(async()=>{downloads++;return new Response(Buffer.from('not an image'));}) as any;
        const f=fixture();f.message.content='holiday photo';
        f.message.attachments.set('big',{id:'big',name:'photo.jpg',url:'https://cdn.discordapp.com/attachments/a/photo.jpg',size:3_000_000,width:4032,height:3024,contentType:'image/jpeg'});
        f.message.attachments.set('bad',{id:'bad',name:'x.png',url:'https://cdn.discordapp.com/attachments/a/x.png',size:12,contentType:'image/png'});
        await f.scanner.process(f.message);assert.equal(downloads,1);assert.equal(f.alerts.length,0);assert.deepEqual(f.events,[]);f.store.close();
    } finally {globalThis.fetch=realFetch;}
});
test('signed attachment URL changes do not cause duplicate processing',async()=>{
    const f=fixture();f.message.content='MrBeast crypto casino promo giveaway';await f.scanner.process(f.message);
    const count=()=>f.store.all('SELECT * FROM scam_events').length;assert.equal(count(),1);
    await f.scanner.process(f.message);assert.equal(count(),1);f.store.close();
});
test('an image burst waits for a bounded slot instead of being skipped',async()=>{
    const raw=Buffer.alloc(16*16*3,7);const png=await sharp(raw,{raw:{width:16,height:16,channels:3}}).png().toBuffer();const fp=await fingerprint(png);
    const realFetch=globalThis.fetch;
    try {
        globalThis.fetch=(async()=>{await new Promise(r=>setTimeout(r,20));return new Response(png);}) as any;
        const f=fixture();f.scanner.references=async()=>[{id:'reference',name:'Confirmed scam',...fp}];
        const messages=Array.from({length:6},(_,n)=>{const m:any={...f.message,id:`m${n}`,content:'look',attachments:new Map([[`a${n}`,{id:`a${n}`,name:'x.png',url:`https://cdn.discordapp.com/attachments/a/${n}.png`,size:png.length,contentType:'image/png'}]])};m.fetch=async()=>m;m.delete=async()=>f.events.push('delete');return m;});
        await Promise.all(messages.map(m=>f.scanner.process(m)));
        assert.equal(f.events.filter(e=>e==='delete').length,6);f.store.close();
    } finally {globalThis.fetch=realFetch;}
});
test('automatic startup reuses an existing #vanguard-security instead of creating a second one',async()=>{
    const f=automaticFixture();const topics:string[]=[];
    f.channels.set('existing-security',{id:'existing-security',name:'vanguard-security',type:0,topic:null,isSendable:()=>true,permissionsFor:()=>new PermissionsBitField(8n),setTopic:async(t:string)=>{topics.push(t);}});
    assert.equal(await f.scanner.initialize(f.guild),true);
    assert.equal(f.created.length,0,'a duplicate security log is never created');
    assert.equal(f.store.settings(guildId).logChannelId,'existing-security');
    assert.equal(topics.length,1,'the reused channel is marked as Vanguard\'s for later restarts');
    const restarted=new ScamProtection(f.store,{push:()=>{}} as any);assert.equal(await restarted.initialize(f.guild),true);
    assert.equal(f.created.length,0,'a restart finds the same channel');f.store.close();
});
test('automatic startup prefers the channel marked by Vanguard over a same-named look-alike',async()=>{
    const f=automaticFixture();
    f.channels.set('marked',{id:'marked',name:'security-archive',type:0,topic:'Ghost Vanguard • managed security log',isSendable:()=>true,permissionsFor:()=>new PermissionsBitField(8n)});
    f.channels.set('lookalike',{id:'lookalike',name:'vanguard-security',type:0,topic:null,isSendable:()=>true,permissionsFor:()=>new PermissionsBitField(8n),setTopic:async()=>{}});
    assert.equal(await f.scanner.initialize(f.guild),true);
    assert.equal(f.store.settings(guildId).logChannelId,'marked');assert.equal(f.created.length,0);
});
test('automatic startup never adopts a channel another bot has claimed a topic on',async()=>{
    const f=automaticFixture();
    f.channels.set('other-bot',{id:'other-bot',name:'vanguard-security',type:0,topic:'Moderation logs for Another Bot',isSendable:()=>true,permissionsFor:()=>new PermissionsBitField(8n),setTopic:async()=>{}});
    assert.equal(await f.scanner.initialize(f.guild),true);
    assert.equal(f.created.length,1,'a foreign channel is left alone; Vanguard creates its own');
    assert.equal(f.store.settings(guildId).logChannelId,'auto-log');
});
