import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyPanels } from '../src/bot/reply-panels.js';

function interaction(id:string,user='user',guild='guild') {
    let removed=0;
    return {id,guildId:guild,user:{id:user},editReply:async(_payload:any)=>({id}),reply:async(_payload:any)=>({id}),deleteReply:async()=>{removed++;},removed:()=>removed};
}

test('new embeds delete the previous personal panel; repeated updates preserve the same panel',async()=>{
    const panels=new ReplyPanels(),old=interaction('a'),next=interaction('b');
    await panels.wrap(old).editReply({embeds:[{}]});await panels.wrap(old).editReply({embeds:[{}]});assert.equal(old.removed(),0);
    await panels.wrap(next).editReply({embeds:[{}]});assert.equal(old.removed(),1);assert.equal(next.removed(),0);
});
test('cleanup is isolated by user and guild and a failed new reply keeps the old panel',async()=>{
    const panels=new ReplyPanels(),old=interaction('a');await panels.wrap(old).editReply({embeds:[{}]});
    await panels.wrap(interaction('b','other')).editReply({embeds:[{}]});await panels.wrap(interaction('c','user','other')).editReply({embeds:[{}]});assert.equal(old.removed(),0);
    const bad=interaction('d');bad.editReply=async()=>{throw new Error('send failed');};
    await assert.rejects(panels.wrap(bad).editReply({embeds:[{}]}),/send failed/);assert.equal(old.removed(),0);
});
test('expired cleanup failure does not fail the new panel and ordinary methods keep their receiver',async()=>{
    const panels=new ReplyPanels(),old=interaction('a');old.deleteReply=async()=>{throw new Error('expired');};
    await panels.wrap(old).editReply({embeds:[{}]});const next=interaction('b');await panels.wrap(next).editReply({embeds:[{}]});assert.equal(panels.wrap(next).removed(),0);
});
test('known deleted replies do not emit a cleanup warning, but other failures do',async()=>{
    const lines:string[]=[];const original=console.log;console.log=(...args:any[])=>{lines.push(args.join(' '));};
    try {
        for (const code of [10008,10015,10062,50013]) {
            const panels=new ReplyPanels(),old=interaction(`old${code}`),next=interaction(`next${code}`);
            old.deleteReply=async()=>{throw Object.assign(new Error('cleanup failed'),{code});};
            await panels.wrap(old).editReply({embeds:[{}]});await panels.wrap(next).editReply({embeds:[{}]});
        }
        assert.equal(lines.filter(line=>/Old reply cleanup unavailable|old_reply_cleanup_unavailable/.test(line)).length,1);
    } finally {console.log=original;}
});
