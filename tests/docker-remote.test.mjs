import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {remoteChat,remoteImage,remotePing} from '../src/adapters/remote.mjs';
import {ProviderManager} from '../src/adapters/manager.mjs';
import {createServers} from '../src/server.mjs';
import {tmpdir} from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';

const token='test-secret-token-'+('a'.repeat(55));
async function withWorker(handler,run){
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{return await run('http://127.0.0.1:'+server.address().port);}finally{await new Promise(r=>server.close(r));}
}
function event(res,obj){res.write('data: '+JSON.stringify(obj)+'\n\n');}
function fakeWorker(provider){
 return async(req,res)=>{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
  if(req.url==='/health'){res.writeHead(200);res.end('ok');return;}
  if(req.url==='/v1/chat/completions'){
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   assert.equal(body.model,provider);
   assert.equal(body.stream,true);
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   event(res,{choices:[{delta:{content:'Hello '}}]});
   event(res,{choices:[{delta:{content:'from '+provider}}]});
   event(res,{choices:[{delta:{}}],conversation_id:body.conversation_id||`${provider}-thread-1`,actual_model:'browser_default',model_selection_verified:false});
   res.end('data: [DONE]\n\n');return;
  }
  res.writeHead(404);res.end();
 };
}
test('both Docker workers route by provider with streaming and preserved IDs',async()=>{
 for(const p of ['gpt','gemini'])await withWorker(fakeWorker(p),async origin=>{
  const cfg={token,requestTimeoutMs:1000,[p+'Origin']:origin,[p+'Mode']:'remote'};
  const manager=new ProviderManager(cfg,{browserHub:{probe:async()=>({}),close:async()=>{}}});
  assert.equal(await manager.mode(p),'remote');
  const progress=[];
  const a=await manager.chat({provider:p,messages:[{role:'user',content:'hi'}],effort:'auto'},text=>progress.push(text));
  assert.deepEqual(progress,['Hello ','Hello from '+p]);
  assert.equal(a.conversation_id,`${p}-thread-1`);
  const b=await manager.chat({provider:p,messages:[{role:'user',content:'second'}],effort:'auto',conversation_id:a.conversation_id});
  assert.equal(b.conversation_id,a.conversation_id);
  assert.equal(b.text,'Hello from '+p);
  assert.equal(await remotePing(origin,token),true);
 });
});
test('remote worker errors cannot be mistaken for empty success',async()=>{
 await withWorker(async(req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('event: gateway.error\ndata: {"error":{"message":"Login needed"}}\n\ndata: [DONE]\n\n');},async origin=>{
  await assert.rejects(remoteChat('gemini',{geminiOrigin:origin,token,requestTimeoutMs:1000},{messages:[{role:'user',content:'hi'}]}),/Login needed/);
 });
});
test('remote image rejects unsupported browser image route, not fake success',async()=>{
 await withWorker(async(req,res)=>{res.writeHead(501,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'not supported by browser worker'}}));},async origin=>{
  await assert.rejects(remoteImage('gemini',{geminiOrigin:origin,token,requestTimeoutMs:1000},{mode:'generate',prompt:'image'}),e=>e.status===501);
 });
});
test('worker scope refuses requests aimed at another provider',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'orbit-worker-test-'));
 const cfg={token,apiHost:'127.0.0.1',apiPort:0,uiPort:0,uiDisabled:true,workerProvider:'gemini',dataDir:dir};
 const srv=createServers(cfg,{manager:{mode:async()=> 'browser',close:async()=>{}},projects:{assertExists:async()=>{}}});
 await new Promise(r=>srv.api.listen(0,'127.0.0.1',r));
 try{
  const url='http://127.0.0.1:'+srv.api.address().port;
  const response=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt',messages:[{role:'user',content:'hi'}]})});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error.code,'worker_scope');
 }finally{await new Promise(r=>srv.api.close(r));await rm(dir,{recursive:true,force:true});}
});
test('Compose has two isolated worker volumes; host access is loopback-only',async()=>{
 const raw=(await readFile(new URL('../docker-compose.yml',import.meta.url),'utf8')).replaceAll('\r\n','\n');
 for(const p of ['gpt','gemini'])assert.match(raw,new RegExp('  '+p+':\\n'));
 for(const [variable,port] of [['ORBIT_UI_PORT',4983],['ORBIT_API_PORT',4984],['ORBIT_GPT_VNC_PORT',6081],['ORBIT_GEMINI_VNC_PORT',6082],['ORBIT_GPT_LEGACY_VNC_PORT',6080]])assert.ok(raw.includes(`127.0.0.1:${'${'+variable+':-'+port+'}'}:`));
 for(const vol of ['gpt-data','gemini-data'])assert.ok(raw.includes(`${vol}:/app/data`));
 assert.doesNotMatch(raw,/\s+privileged:\s*true/);
 assert.doesNotMatch(raw,/docker compose down -v/);
 assert.match(raw,/name: \${COMPOSE_PROJECT_NAME:-orbit-gateway}/);
 assert.doesNotMatch(raw,/external:\s*true/);
 assert.doesNotMatch(raw,/unified-ai-gateway_gpt_browser_profile/);
});
test('public gateway API proxies SSE to the selected mock Docker worker and retains thread',async()=>{
 await withWorker(fakeWorker('gemini'),async origin=>{
  const dir=await mkdtemp(path.join(tmpdir(),'orbit-front-test-'));
  const cfg={token,apiHost:'127.0.0.1',uiHost:'127.0.0.1',apiPort:0,uiPort:0,uiDisabled:true,workerProvider:'',dataDir:dir,geminiOrigin:origin,geminiMode:'remote',gptMode:'remote',geminiMode:'remote',requestTimeoutMs:2000};
  const srv=createServers(cfg);
  await new Promise(r=>srv.api.listen(0,'127.0.0.1',r));
  try{
   const url='http://127.0.0.1:'+srv.api.address().port;
   const send=async(convId,stream)=>{
    const res=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({model:'gemini',messages:[{role:'user',content:'hi'}],conversation_id:convId,stream})});
    assert.equal(res.status,200);return stream?await res.text():await res.json();
   };
   const a=await send(undefined,false);
   assert.equal(a.choices[0].message.content,'Hello from gemini');
   assert.equal(a.conversation_id,'gemini-thread-1');
   const b=await send(a.conversation_id,true);
   assert.match(b,/Hello/);assert.match(b,/from gemini/);assert.match(b,/gemini-thread-1/);assert.match(b,/\[DONE\]/);
  }finally{await new Promise(r=>srv.api.close(r));await srv.manager.close();await rm(dir,{recursive:true,force:true});}
 });
});
test('Runtime catalog hides unsupported GPT remote image while preserving other image providers',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'orbit-models-test-'));
 const cfg={token,apiHost:'127.0.0.1',apiPort:0,uiDisabled:true,dataDir:dir,gptMode:'remote',geminiMode:'remote',geminiMode:'remote'};
 const srv=createServers(cfg,{manager:{},projects:{}});
 await new Promise(r=>srv.api.listen(0,'127.0.0.1',r));
 try{
  const url='http://127.0.0.1:'+srv.api.address().port;
  const res=await fetch(url+'/v1/models',{headers:{authorization:'Bearer '+token}});
  assert.equal(res.status,200);
  for(const item of (await res.json()).data.filter(x=>x.capabilities)){if(item.owned_by==='gpt')assert.equal(item.capabilities.image_generation,false);else assert.equal(item.capabilities.image_generation,true);}
  const caps=await fetch(url+'/v1/capabilities',{headers:{authorization:'Bearer '+token}});
  const allProviders=(await caps.json()).providers;assert.equal(allProviders.gpt.images,false);for(const key of ['gemini','aimode','gemini'])assert.equal(allProviders[key].images,true);
 }finally{await new Promise(r=>srv.api.close(r));await rm(dir,{recursive:true,force:true});}
});
