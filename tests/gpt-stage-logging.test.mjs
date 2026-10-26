import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const browser=await readFile(new URL('../src/adapters/browser.mjs',import.meta.url),'utf8');
const server=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
const smoke=await readFile(new URL('../smoke-docker.ps1',import.meta.url),'utf8');
test('GPT marks each request stage without logging prompt text',()=>{
 for(const stage of ['open_or_restore','await_editor','verify_model','baseline_snapshot','fill_editor','submit_prompt','await_response','persist_thread'])assert.ok(browser.includes(stage));
 assert.match(browser,/\[ORBIT-GPT-FAIL\]/);
 assert.match(browser,/prompt_submitted:promptSubmitted/);
 assert.match(browser,/console\.info\('\[ORBIT-GPT-STAGE\]'/);
});
test('worker and gateway log caught API failure codes',()=>{
 assert.match(server,/\[ORBIT-API-FAIL\]/);
 assert.match(server,/logRequestError\(config,e,'stream'\)/);
 assert.match(server,/logRequestError\(config,e,'request'\)/);
});
test('PowerShell smoke displays HTTP response body on 502',()=>{
 assert.match(smoke,/GetResponseStream\(\)/);
 assert.match(smoke,/Get-OrbitErrorDetail \$_/);
});

import {BrowserHub} from '../src/adapters/browser.mjs';
import {createServers} from '../src/server.mjs';
import {GatewayError} from '../src/lib/errors.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('GPT editor failure prints diagnostic stage even before any response-wait',async()=>{
 const hub=new BrowserHub({dataDir:'/tmp/orbit-test'});
 const page={isClosed:()=>false,url:()=> 'https://chatgpt.com/c/test',locator:()=>({filter(){return this},first(){return this},waitFor:async()=>{throw new Error('not visible')},isVisible:async()=>false,count:async()=>0})};
 hub.threads.set('thread-1',{provider:'gpt',page});
 const logs=[];const old=console.error;console.error=(...a)=>logs.push(a.join(' '));
 try{await assert.rejects(hub._send('gpt',{conversation_id:'thread-1',messages:[{role:'user',content:'secret-phrase-should-not-log'}]}),e=>e.code==='login_or_selector_changed');}
 finally{console.error=old;}
 assert.equal(logs.length,1);assert.match(logs[0],/"stage":"await_editor"/);assert.match(logs[0],/"prompt_submitted":false/);
 assert.doesNotMatch(logs[0],/secret-phrase-should-not-log/);
});
test('worker emits safe error SSE and logs error code for stream failures',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'orbit-v212-'));
 const token='test-'+('q'.repeat(50));
 const config={token,apiHost:'127.0.0.1',apiPort:0,uiDisabled:true,workerProvider:'gpt',dataDir:temp,gptMode:'browser'};
 const manager={mode:async()=> 'browser',chat:async()=>{throw new GatewayError(503,'selector_invalid','UI editor missing')},close:async()=>{}};
 const server=createServers(config,{manager,projects:{assertExists:async()=>{}}});
 const old=console.error;const logs=[];console.error=(...a)=>logs.push(a.join(' '));
 try{
  await new Promise(resolve=>server.api.listen(0,'127.0.0.1',resolve));
  const res=await fetch(`http://127.0.0.1:${server.api.address().port}/v1/chat/completions`,{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt',stream:true,messages:[{role:'user',content:'top-secret-value'}]})});
  assert.equal(res.status,200);
  const body=await res.text();assert.match(body,/gateway.error/);assert.match(body,/selector_invalid/);
  assert.ok(logs.some(x=>x.includes('[ORBIT-API-FAIL]') && x.includes('selector_invalid')));
  assert.ok(!logs.some(x=>x.includes('top-secret-value')));
 }finally{
   console.error=old;
   await new Promise(resolve=>server.api.close(resolve));await rm(temp,{recursive:true,force:true});
 }
});
