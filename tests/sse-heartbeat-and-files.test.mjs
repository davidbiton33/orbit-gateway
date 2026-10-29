import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServers} from '../src/server.mjs';

const token='Q'.repeat(56);
const payload={model:'gemini',stream:true,messages:[{role:'user',content:'Reply briefly'}]};
async function setup(t,manager){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'orbit-heartbeat-test-'));
 const config={token,dataDir,requestTimeoutMs:10000,workerProvider:'',geminiMode:'browser'};
 const projects={assertExists:async()=>{}};
 const servers=createServers(config,{manager,projects});
 await new Promise(resolve=>servers.api.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>servers.api.close(resolve));await rm(dataDir,{recursive:true,force:true});});
 return 'http://127.0.0.1:'+servers.api.address().port;
}
async function post(host){return fetch(host+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(payload)});}
const outputFile={id:'file_gemini_0123456789abcdef0123456789abcdef',filename:'בדיקה.pdf',size:32,mime_type:'application/pdf',download_url:'/v1/files/file_gemini_0123456789abcdef0123456789abcdef/content'};

test('slow SSE sends harmless keepalive comments and completes normally',async t=>{
 const prev=process.env.ORBIT_SSE_HEARTBEAT_MS;process.env.ORBIT_SSE_HEARTBEAT_MS='1000';
 t.after(()=>{if(prev===undefined)delete process.env.ORBIT_SSE_HEARTBEAT_MS;else process.env.ORBIT_SSE_HEARTBEAT_MS=prev;});
 const manager={
   mode:async()=> 'browser',
   chat:async(request,onProgress)=>{
    await new Promise(resolve=>setTimeout(resolve,2250));
    onProgress?.('Hello');
    return {text:'Hello',conversation_id:'thread-heartbeat',actual_model:'browser_default',selection_verified:false};
   }
 };
 const host=await setup(t,manager);
 const res=await post(host);
 assert.equal(res.status,200);
 const s=await res.text();
 assert.match(s,/: orbit:connected/);
 assert.match(s,/: orbit:waiting/);
 assert.match(s,/"content":"Hello"/);
 assert.match(s,/"finish_reason":"stop"/);
 assert.match(s,/data: \[DONE\]/);
 assert.doesNotMatch(s,/gateway.error/);
});

test('SSE preserves attachment metadata with text and warning',async t=>{
 const manager={mode:async()=> 'browser',chat:async()=>({text:'Here is a summary',attachments:[outputFile],file_warning:'Another link was not downloadable',conversation_id:'thread-file',actual_model:'browser_default'})};
 const host=await setup(t,manager);
 const res=await post(host);
 const s=await res.text();
 assert.equal(res.status,200);
 assert.match(s,/"file_warning":"Another link was not downloadable"/);
 assert.match(s,/"attachments":/);
 assert.match(s,/data: \[DONE\]/);
});

test('nonstream reply includes attachment and warning metadata',async t=>{
 const manager={mode:async()=> 'browser',chat:async()=>({text:'Report',attachments:[outputFile],file_warning:'One document could not be downloaded',conversation_id:'thread-file',actual_model:'browser_default'})};
 const host=await setup(t,manager);
 const res=await fetch(host+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...payload,stream:false})});
 const json=await res.json();
 assert.equal(res.status,200);
 assert.deepEqual(json.attachments,[outputFile]);
 assert.equal(json.file_warning,'One document could not be downloaded');
 assert.equal(json.choices[0].message.content,'Report');
});
