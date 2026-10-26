import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {loadConfig} from '../src/lib/config.mjs';
import {ProviderManager} from '../src/adapters/manager.mjs';
import {unpackGptConversation,packGptConversation} from '../src/adapters/gpt-backend.mjs';

const token='x'.repeat(64);
test('GPT_BACKEND env selects legacy or Docker only in the front gateway',async()=>{
 const overrides={GPT_ORIGIN:'http://gpt:4984',GPT_LEGACY_ORIGIN:'http://gpt-legacy:4982',WORKER_PROVIDER:'',ORBIT_ROLE:'gateway'};
 const legacy=await loadConfig({...overrides,GPT_BACKEND:'legacy'});
 assert.equal(legacy.gptMode,'legacy');assert.equal(legacy.gptOrigin,'http://gpt-legacy:4982');
 const modern=await loadConfig({...overrides,GPT_BACKEND:'docker'});
 assert.equal(modern.gptMode,'remote');assert.equal(modern.gptOrigin,'http://gpt:4984');
 const worker=await loadConfig({...overrides,WORKER_PROVIDER:'gpt',GPT_BACKEND:'legacy',GPT_MODE:'browser'});
 assert.equal(worker.gptMode,'browser');
 await assert.rejects(loadConfig({...overrides,GPT_BACKEND:'unknown'}),/GPT_BACKEND must/);
});

test('changing GPT backend never silently continues a conversation in the wrong profile',()=>{
 const id='fbf9a1c0-a7c4-4aa1-88d9-fc8d030cab11';
 assert.equal(unpackGptConversation(packGptConversation(id,'legacy'),'legacy'),id);
 assert.equal(unpackGptConversation(packGptConversation(id,'docker'),'docker'),id);
 assert.equal(unpackGptConversation(id,'docker'),id); // existing pre-switch GPT threads
 assert.throws(()=>unpackGptConversation(packGptConversation(id,'legacy'),'docker'),e=>e.code==='gpt_backend_changed'&&e.status===409);
 assert.throws(()=>unpackGptConversation(id,'legacy'),e=>e.code==='gpt_backend_changed');
});

async function withServer(handler,run){
 const server=http.createServer(handler);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await run('http://127.0.0.1:'+server.address().port);}
 finally{await new Promise(r=>server.close(r));}
}
const browserHub={close:async()=>{},probe:async()=>({})};
test('legacy GPT worker is called on its original /chat/stream route with tagged conversation',async()=>{
 let received=0,seenId=null;
 await withServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+token);
  if(req.url==='/chat/stream'){
   let raw='';for await(const c of req)raw+=c;
   const payload=JSON.parse(raw);seenId=payload.conversation_id||null;received++;
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.end('data: '+JSON.stringify({choices:[{delta:{content:'OK'}}],conversation_id:'legacy-conversation-42'})+'\\n\\ndata: [DONE]\\n\\n'.replaceAll('\\n','\n'));
  } else {res.writeHead(404);res.end();}
 },async origin=>{
  const cfg={token,gptBackend:'legacy',gptMode:'legacy',gptOrigin:origin,requestTimeoutMs:3000};
  const manager=new ProviderManager(cfg,{browserHub});
  const r=()=>({provider:'gpt',messages:[{role:'user',content:'hello'}],effort:'auto'});
  const a=await manager.chat(r());
  assert.equal(a.conversation_id,'gpt_legacy_legacy-conversation-42');
  assert.equal(a.text,'OK');assert.equal(seenId,null);
  const b=await manager.chat({...r(),conversation_id:a.conversation_id});
  assert.equal(b.text,'OK');assert.equal(seenId,'legacy-conversation-42');
  await assert.rejects(manager.chat({...r(),conversation_id:'gpt_docker_wrong-id'}),e=>e.code==='gpt_backend_changed');
  assert.equal(received,2);
 });
});

test('Docker GPT worker uses /v1/chat/completions and preserves its own namespace',async()=>{
 let seenId=null,received=0;
 await withServer(async(req,res)=>{
  if(req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end();}
  let raw='';for await(const c of req)raw+=c;
  const p=JSON.parse(raw);received++;seenId=p.conversation_id||null;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({choices:[{delta:{content:'OK'}}]})+'\n\n');
  res.write('data: '+JSON.stringify({choices:[{delta:{}}],conversation_id:'docker-conversation-99'})+'\n\n');
  res.end('data: [DONE]\n\n');
 },async origin=>{
  const manager=new ProviderManager({token,gptBackend:'docker',gptMode:'remote',gptOrigin:origin,requestTimeoutMs:3000},{browserHub});
  const request={provider:'gpt',messages:[{role:'user',content:'hi'}],effort:'auto'};
  const a=await manager.chat(request);
  assert.equal(a.conversation_id,'gpt_docker_docker-conversation-99');
  const b=await manager.chat({...request,conversation_id:a.conversation_id});
  assert.equal(b.text,'OK');assert.equal(seenId,'docker-conversation-99');
  assert.equal(received,2);
 });
});

test('Compose isolates two GPT services with new private volumes and no old external profile',async()=>{
 const compose=await readFile(new URL('../docker-compose.yml',import.meta.url),'utf8');
 const switchScript=await readFile(new URL('../switch-gpt.ps1',import.meta.url),'utf8');
 assert.match(compose,/profiles: \["gpt-docker"\]/);
 assert.match(compose,/profiles: \["gpt-legacy"\]/);
 assert.match(compose,/legacy-gpt-profile:\/home\/pwuser\/profile/);
 assert.doesNotMatch(compose,/unified-ai-gateway_gpt_browser_profile/);
 assert.doesNotMatch(compose,/external: true/);
 assert.doesNotMatch(switchScript,/docker volume inspect unified-ai-gateway/);
 assert.match(compose,/GPT_LEGACY_ORIGIN: http:\/\/gpt-legacy:4982/);
 assert.doesNotMatch(compose,/127\.0\.0\.1:4982:4982/);
 assert.match(switchScript,/\bGPT_BACKEND\b/);
 assert.doesNotMatch(switchScript,/\bdown\s+-v\b/);
});
