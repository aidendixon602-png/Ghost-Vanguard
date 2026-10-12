import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { reconcileStartupMembers } from '../src/security/startup-members.js';

const id='223456789012345678';
function fixture() {
    const store=new Store(':memory:');authorize(store,id);
    for(const user of ['gone','present'])store.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1)',id,user,'["role"]',Date.now());
    const calls:string[]=[], logs:any[]=[], security:any={reconcile:async(m:any)=>calls.push(m.id)};
    const guild:any={id,members:{fetch:async({user,force}:any)=>{assert.equal(force,true);if(user==='gone')throw {code:10007};return {id:user};}}};
    return {store,calls,logs,security,guild,report:(_name:any,data:any)=>logs.push(data)};
}
test('startup skips confirmed absent members, continues reconciling and retains quarantine records',async()=>{
    const f=fixture();assert.deepEqual(await reconcileStartupMembers(f.store,f.security,f.guild,f.report),{reconciled:1,absent:1});
    assert.deepEqual(f.calls,['present']);assert.equal(f.logs.length,1);
    assert.equal(f.store.get('SELECT active FROM backups WHERE guild_id=? AND user_id=?',id,'gone')?.active,1);f.store.close();
});
test('retained quarantine is reconciled when an absent member is available on a later pass',async()=>{
    const f=fixture();await reconcileStartupMembers(f.store,f.security,f.guild,f.report);
    f.guild.members.fetch=async({user}:any)=>({id:user});f.calls.length=0;
    assert.deepEqual(await reconcileStartupMembers(f.store,f.security,f.guild,f.report),{reconciled:2,absent:0});assert.deepEqual(f.calls,['gone','present']);f.store.close();
});
test('startup does not treat network/permission failures as member absence',async()=>{
    for(const code of [50013,'ETIMEDOUT',10004]) {
        const f=fixture();f.guild.members.fetch=async()=>{throw {code};};
        await assert.rejects(()=>reconcileStartupMembers(f.store,f.security,f.guild,f.report),(e:any)=>e.code===code);
        assert.equal(f.logs.length,0);assert.deepEqual(f.calls,[]);f.store.close();
    }
});
test('departure between initial lookup and quarantine containment is also safe',async()=>{
    const f=fixture();f.guild.members.fetch=async({user}:any)=>({id:user});f.security.reconcile=async(m:any)=>{if(m.id==='gone')throw {code:10007};f.calls.push(m.id);};
    assert.deepEqual(await reconcileStartupMembers(f.store,f.security,f.guild,f.report),{reconciled:1,absent:1});assert.deepEqual(f.calls,['present']);f.store.close();
});
test('startup stops reconciliation after authorization is revoked during a member lookup',async()=>{
    const f=fixture();f.guild.members.fetch=async()=>{f.store.run("UPDATE guild_authorization SET state='DEAUTHORIZED' WHERE guild_id=?",id);return {id:'gone'};};
    await assert.rejects(()=>reconcileStartupMembers(f.store,f.security,f.guild,f.report),(error:any)=>error.category==='AUTHORIZATION_ERROR');assert.deepEqual(f.calls,[]);f.store.close();
});
