import http from 'node:http';import path from 'node:path';import {readFile,stat,mkdir,writeFile,rename} from 'node:fs/promises';import {randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {loadConfig,ROOT} from './lib/config.mjs';import {GatewayError,safeError,fail} from './lib/errors.mjs';
import {catalogResponse,validateRequest,CATALOG} from './lib/catalog.mjs';import {ProjectStore} from './lib/store.mjs';
import {ProviderManager} from './adapters/manager.mjs';
import {ProviderQueue} from './lib/provider-queue.mjs';
import {UsageLedger} from './lib/usage-ledger.mjs';
const PUBLIC=path.join(ROOT,'public');const MAX=22*1024*1024;
const TYPES={'.js':'application/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
function logRequestError(config,e,phase){const err=safeError(e).error;console.error('[ORBIT-API-FAIL]',JSON.stringify({provider:config.workerProvider||'gateway',phase,code:err.code,status:Number(e?.status||500),name:String(e?.name||'Error').slice(0,80)}));}
const json=(res,status,data)=>{if(res.headersSent)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});res.end(JSON.stringify(data));};
function bearer(req,token){const actual=String(req.headers.authorization||'');const expected='Bearer '+token;const a=Buffer.from(actual),b=Buffer.from(expected);return Boolean(token&&a.length===b.length&&timingSafeEqual(a,b));}
function assertWorkerProvider(config,provider){if(config.workerProvider&&config.workerProvider!==provider&&!(config.workerProvider==='gemini'&&provider==='aimode'))fail(403,'worker_scope','Worker handles only '+config.workerProvider);}
async function readBuffer(req){const parts=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX)fail(413,'payload_too_large','Request exceeds 22 MB');parts.push(chunk);}return Buffer.concat(parts);}
async function readJson(req){try{return JSON.parse((await readBuffer(req)).toString('utf8'));}catch{fail(400,'invalid_json','Expected valid JSON body');}}
async function imageBody(req){if(!String(req.headers['content-type']||'').startsWith('multipart/form-data'))return readJson(req);const raw=await readBuffer(req);let form;try{form=await new Request('http://localhost/upload',{method:'POST',headers:{'content-type':req.headers['content-type']},body:raw}).formData();}catch{fail(400,'invalid_multipart','Invalid multipart image upload');}const out={};for(const [key,value] of form.entries()){if(key==='image'){if(typeof value==='string')fail(400,'invalid_image','Expected image file');if(value.size>10e6)fail(413,'image_too_large','Image file exceeds 10 MB');out.image='data:'+value.type+';base64,'+Buffer.from(await value.arrayBuffer()).toString('base64');}else if(typeof value==='string')out[key]=value;}return out;}
function validateOrigin(req,ui){if(!req.headers.origin)return;if(ui && req.headers.origin==='http://'+req.headers.host)return;fail(403,'origin_not_allowed','Browser cross-origin API calls are disabled; use server-to-server calls');}
function validateMessages(m){if(!Array.isArray(m)||m.length===0||m.length>70||m.some(x=>!['system','user','assistant'].includes(x?.role)||typeof x.content!=='string'||x.content.length>24000))fail(400,'invalid_messages','messages must contain 1-70 plain-text role/content entries');}
function endPointEdit(endpoint,input){return endpoint==='/v1/images/edits'||input.mode==='edit';}
function imageData(input){if(input.image){if(typeof input.image!=='string'||input.image.length>15e6)fail(413,'invalid_image','Image payload too large');const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.image);if(!m)fail(400,'invalid_image','Use a PNG/JPEG/WebP data URL');const b=Buffer.from(m[2],'base64');if(b.length<12||b.length>10e6)fail(400,'invalid_image','Image size invalid');const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpg=b[0]===255&&b[1]===216&&b[2]===255;const webp=b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';if(!((png&&m[1]==='image/png')||(jpg&&m[1]==='image/jpeg')||(webp&&m[1]==='image/webp')))fail(400,'image_signature_mismatch','File signature does not match MIME');return {imageBase64:m[2],inputMime:m[1]};}return {};}
function runtimeCatalog(config){const result=catalogResponse();for(const item of result.data)if(item.capabilities){if(item.owned_by==='gpt'&&['browser','remote'].includes(config.gptMode))item.capabilities.image_generation=false;if(item.owned_by==='gpt')item.capabilities.projects_native=config.gptMode==='legacy';if(item.owned_by==='claude')item.capabilities.projects_native=['browser','remote'].includes(config.claudeMode);}return result;}
function runtimeProviders(config){return Object.fromEntries(Object.entries(CATALOG).map(([name,p])=>[name,{...p,images:(name==='gpt'&&['browser','remote'].includes(config[name+'Mode']))?false:p.images}]));}
function openaiResponse(request,result){return {id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:request.model,provider:request.provider,actual_model:result.actual_model,model_selection_verified:result.selection_verified,conversation_id:result.conversation_id||null,choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:result.finish_reason||'stop'}]};}
function openaiSse(res,id,model,delta,extra={}){const finish_reason=extra.finish_reason??null;const fields={...extra};delete fields.finish_reason;res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model,choices:[{index:0,delta,finish_reason}],...fields})+'\n\n');}
export function createServers(config,{manager=new ProviderManager(config),projects=new ProjectStore(path.join(config.dataDir,'projects.json'))}={}){
 const queue=config.workerProvider?null:new ProviderQueue({
  limit:Math.max(1,Math.min(20,Number(process.env.ORBIT_QUEUE_LIMIT||4))),
  waitMs:Math.max(1000,Math.min(300000,Number(process.env.ORBIT_QUEUE_WAIT_MS||90000)))
 });
 const usage=new UsageLedger();
 const usageFile=path.join(config.dataDir,'usage-ledger.json');
 const usageReady=readFile(usageFile,'utf8').then(data=>usage.restore(JSON.parse(data))).catch(()=>{});
 let usageWrite=Promise.resolve();
 const saveUsage=()=>{
  usageWrite=usageWrite.then(async()=>{
   await mkdir(config.dataDir,{recursive:true});
   const tmp=usageFile+'.tmp-'+process.pid;
   await writeFile(tmp,JSON.stringify(usage.serialize()),{mode:0o600});
   await rename(tmp,usageFile);
  }).catch(e=>console.warn('[ORBIT-USAGE]',JSON.stringify({phase:'persist_failed',code:e.code||e.name})));
  return usageWrite;
 };
 const usageCall=async(request,kind,fn)=>{
   await usageReady;
   usage.check(request.provider,kind);
   try{const result=await fn();usage.record(request.provider,kind,{ok:true});await saveUsage();return result;}
   catch(error){usage.record(request.provider,kind,{ok:false,error});await saveUsage();throw error;}
 };
 const queuedChat=(request,progress,signal)=>queue?
   queue.run(request.provider==='aimode'?'gemini':request.provider,()=>usageCall(request,'chat',()=>manager.chat(request,progress)),{signal}):usageCall(request,'chat',()=>manager.chat(request,progress));
 const queuedImage=(request,signal)=>queue?
   queue.run(request.provider==='aimode'?'gemini':request.provider,()=>usageCall(request,'image',()=>manager.image(request)),{signal}):usageCall(request,'image',()=>manager.image(request));
 async function dispatch(req,res,ui=false){const u=new URL(req.url,'http://localhost');const p=u.pathname;try{
  // host check makes the UI strictly a localhost-only playground; API is also loopback-only and needs Bearer auth.
  if(ui && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host||'')))fail(403,'invalid_host','UI is localhost-only');
  if(ui && req.method==='GET'&&(p==='/'||['/index.html','/app.js','/style.css'].includes(p))){const name=p==='/'?'index.html':p.slice(1);const file=path.join(PUBLIC,name);const info=await stat(file);if(!info.isFile())fail(404,'not_found','Not found');res.writeHead(200,{'Content-Type':TYPES[path.extname(file)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});res.end(await readFile(file));return;}
  // Public, non-secret instance ports are for the local Studio UI only. Never expose the API token.
  if(ui&&req.method==='GET'&&p==='/play/v1/instance')return json(res,200,{ui_port:Number(process.env.ORBIT_UI_PORT||config.uiPort),api_port:Number(process.env.ORBIT_API_PORT||config.apiPort),vnc:{gpt:Number(process.env.ORBIT_GPT_VNC_PORT||6081),legacy:Number(process.env.ORBIT_GPT_LEGACY_VNC_PORT||6080),gemini:Number(process.env.ORBIT_GEMINI_VNC_PORT||6082),claude:Number(process.env.ORBIT_CLAUDE_VNC_PORT||6083)}});
  // UI's same-origin proxy never exposes the backend token to browser JavaScript.
  if(ui&&!p.startsWith('/play/'))fail(404,'not_found','UI route not found');
  if(!ui && !bearer(req,config.token)){json(res,401,{error:{message:'Valid Bearer token required',code:'unauthorized'}});return;}
  if(req.method!=='GET')validateOrigin(req,ui);
  const endpoint=ui?p.replace(/^\/play/,''):p;
  if(req.method==='GET'&&endpoint==='/health')return json(res,200,{ok:true,version:'2.1.0-docker.1'});
  if(req.method==='GET'&&endpoint==='/v1/queue')return json(res,200,{queue:queue?.snapshot()||null});
  if(req.method==='GET'&&endpoint==='/v1/models')return json(res,200,runtimeCatalog(config));
  if(req.method==='GET'&&endpoint==='/v1/capabilities')return json(res,200,{providers:runtimeProviders(config),policy:'fail_closed_if_model_effort_native_project_unverified'});
  if(req.method==='GET'&&endpoint==='/v1/doctor')return json(res,200,{providers:await manager.status(),api_auth:'required',ui_binding:'localhost_only',remote_exposure:'Tailscale Serve API only'});
  if(req.method==='GET'&&endpoint==='/v1/projects/native'){
   const provider=u.searchParams.get('provider');
   if(!['gpt','gemini','claude'].includes(provider))fail(400,'invalid_provider','Use provider=gpt|gemini|claude');
   assertWorkerProvider(config,provider);
   return json(res,200,await manager.nativeProjects(provider));
  }
  if(endpoint==='/v1/projects/native/chats'&&req.method==='GET'){
   const provider=u.searchParams.get('provider')||'gpt',projectId=u.searchParams.get('project_id');
   assertWorkerProvider(config,provider);
   return json(res,200,await manager.nativeProjectChats(provider,projectId));
  }
  if(endpoint==='/v1/projects/native/open-chat'&&req.method==='POST'){
   const b=await readJson(req);
   if(!['gpt','claude'].includes(b?.provider))fail(422,'native_project_unverified','Native chat opening supports ChatGPT and Claude');
   assertWorkerProvider(config,b.provider);
   return json(res,200,await manager.openNativeProjectChat(b.provider,b.project_id,b.chat_url));
  }
  if(endpoint==='/v1/projects/native'&&req.method==='POST'){
   const b=await readJson(req);
   if(!['gpt','claude'].includes(b?.provider))fail(422,'native_project_unverified','Native project creation supports ChatGPT and Claude');
   assertWorkerProvider(config,b.provider);
   return json(res,201,await manager.createNativeProject(b.provider,b.name,b.description||''));
  }
  if(req.method==='GET'&&endpoint==='/v1/projects')return json(res,200,{projects:await projects.list(),scope:'local_metadata'});
  if(req.method==='POST'&&endpoint==='/v1/projects'){const body=await readJson(req);if(body?.type&&body.type!=='local')fail(422,'native_projects_unverified','Native provider projects are not enabled');return json(res,201,{project:await projects.create(body.name)});}
  if(req.method==='POST'&&endpoint==='/v1/preflight'){
   const b=await readJson(req),routing=validateRequest(b);assertWorkerProvider(config,routing.provider);await projects.assertExists(routing.project_id);
   const mode=await manager.mode(routing.provider);
   if(routing.native_project_id && !((routing.provider==='gpt'&&mode==='legacy')||(routing.provider==='claude'&&['browser','remote'].includes(mode))))fail(422,'native_project_backend_unverified','Native project backend is unavailable');
   if(!routing.default&&mode==='legacy')fail(422,'model_unverified','Named model selection not verified by legacy worker. No prompt sent.');
   if(routing.effort!=='auto'&&mode==='legacy')fail(422,'effort_unverified','Thinking selection not verified by legacy worker. No prompt sent.');
   return json(res,200,{ready:true,provider:routing.provider,mode,model:routing.requested,model_selection_verified:routing.default?false:null,effort:routing.effort,project_scope:routing.native_project_id?'provider_native':'local_metadata_only'});
  }
  if(req.method==='POST'&&endpoint==='/v1/chat/completions'){
   const b=await readJson(req),r=validateRequest(b);assertWorkerProvider(config,r.provider);await projects.assertExists(r.project_id);validateMessages(b.messages);
   if(b.messages.length>1&&!b.conversation_id)fail(422,'history_requires_conversation_id','For browser conversations, use conversation_id to continue. This gateway cannot replay arbitrary chat history safely.');
   if(b.conversation_id!=null&&(!/^[\w-]{1,120}$/.test(b.conversation_id)))fail(400,'invalid_conversation_id','Invalid conversation ID');
   const activeMode=await manager.mode(r.provider);
   if(r.native_project_id && !((r.provider==='gpt'&&activeMode==='legacy')||(r.provider==='claude'&&['browser','remote'].includes(activeMode))))fail(422,'native_project_backend_unverified','Native project backend is unavailable; no prompt sent');
   if(!r.default&&activeMode==='legacy')fail(422,'model_unverified','Named model choice cannot be verified by legacy adapter; no request sent');
   if(r.effort!=='auto'&&activeMode==='legacy')fail(422,'effort_unverified','Thinking effort cannot be verified by legacy adapter; no request sent');
   const request={...r,model:r.default?null:r.requested,messages:b.messages,conversation_id:b.conversation_id||null,timeoutMs:config.requestTimeoutMs};
   const pendingAbort=new AbortController();
   const disconnect=()=>{if(!res.writableEnded)pendingAbort.abort();};
   res.once('close',disconnect);

   if(b.stream===true){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    let shown='';const id='chatcmpl-'+randomUUID();
    try{const result=await queuedChat(request,text=>{if(!res.writableEnded){const append=text.startsWith(shown);const change=append?text.slice(shown.length):text;shown=text;if(change)openaiSse(res,id,b.model,{content:change},append?{}:{snapshot:true});}},pendingAbort.signal);
      if(!res.writableEnded){openaiSse(res,id,b.model,{}, {conversation_id:result.conversation_id||null,actual_model:result.actual_model,model_selection_verified:result.selection_verified,finish_reason:'stop'});res.write('data: [DONE]\n\n');res.end();}
    }catch(e){logRequestError(config,e,'stream');if(!res.writableEnded){res.write('event: gateway.error\ndata: '+JSON.stringify(safeError(e))+'\n\n');res.write('data: [DONE]\n\n');res.end();}}return;}
   const result=await queuedChat(request,null,pendingAbort.signal);return json(res,200,openaiResponse({...request,model:b.model},result));
  }
  if(req.method==='GET'&&endpoint==='/v1/usage'){await usageReady;return json(res,200,usage.status());}
  if(req.method==='POST'&&['/v1/images/generations','/v1/images/edits'].includes(endpoint)){
   const b=await imageBody(req),r=validateRequest(b,'image');assertWorkerProvider(config,r.provider);await projects.assertExists(r.project_id);
   if(typeof b.prompt!=='string'||!b.prompt.trim()||b.prompt.length>15000)fail(400,'invalid_prompt','Image prompt is required');
   if(b.response_format!=null&&!['binary','b64_json'].includes(b.response_format))
     fail(422,'invalid_image_response_format','Supported formats: binary, b64_json');
   const sizes={'1024x1024':'1:1','1536x1024':'3:2','1024x1536':'2:3','1792x1024':'16:9','1024x1792':'9:16'};
   if(b.size!=null&&!(typeof b.size==='string'&&Object.hasOwn(sizes,b.size)))
     fail(422,'unsupported_image_size','Supported size hints: '+Object.keys(sizes).join(', '));
   const ratioFromSize=b.size?sizes[b.size]:null;
   if(b.aspect_ratio&&ratioFromSize&&b.aspect_ratio!==ratioFromSize)
     fail(422,'conflicting_image_aspect_ratio','size and aspect_ratio specify different shapes');
   const payload={...r,model:r.default?null:r.requested,mode:endPointEdit(endpoint,b)?'edit':'generate',prompt:b.prompt,aspect_ratio:b.aspect_ratio||ratioFromSize,conversation_id:b.conversation_id||null,...imageData(b)};
   if(payload.mode==='edit'&&!payload.imageBase64&&!payload.conversation_id)fail(422,'missing_image','An image or existing image conversation_id is required');
   const imageResult=await queuedImage(payload);
   if(b.response_format==='binary'){
    const b64=imageResult?.data?.[0]?.b64_json;
    if(typeof b64!=='string'||b64.length>24e6||!/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
      fail(502,'image_binary_unavailable','Provider returned no valid image bytes');
    const bytes=Buffer.from(b64,'base64');
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
    if(!png&&!jpg&&!webp)fail(502,'image_binary_invalid','Image bytes are not PNG, JPEG, or WebP');
    res.writeHead(200,{'Content-Type':png?'image/png':jpg?'image/jpeg':'image/webp','Content-Length':bytes.length,'Content-Disposition':'inline; filename="orbit-image.'+(png?'png':jpg?'jpg':'webp')+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(bytes);return;
   }
   if(b.response_format!=null&&!['b64_json','binary'].includes(b.response_format))
    fail(422,'invalid_image_response_format','Supported response_format values: b64_json, binary');
   return json(res,200,imageResult);
  }
  if(req.method==='POST'&&endpoint==='/v1/compare'){if(config.workerProvider)fail(403,'worker_scope','Comparison is available only on the front gateway');
   const b=await readJson(req);if(typeof b.prompt!=='string'||!b.prompt.trim())fail(400,'invalid_prompt','Comparison requires prompt');
   const selected=Array.isArray(b.models)?b.models:['gpt','gemini'];if(selected.length<2||selected.length>3||new Set(selected).size!==selected.length)fail(422,'invalid_compare','Choose two or three distinct models');
   const routes=selected.map(x=>validateRequest({model:x,reasoning_effort:b.reasoning_effort||'auto',project_id:b.project_id}));await projects.assertExists(b.project_id);
   // Prefight every route before calling any provider, so invalid models don't cause partial sends.
   for(const route of routes){const mode=await manager.mode(route.provider);if(!route.default&&mode==='legacy')fail(422,'model_unverified','Comparison model cannot be verified; no requests sent');if(route.effort!=='auto'&&mode==='legacy')fail(422,'effort_unverified','Comparison effort not verified; no requests sent');}
   const responses=await Promise.allSettled(routes.map(async r=>({model:r.requested,provider:r.provider,...await queuedChat({...r,model:r.default?null:r.requested,messages:[{role:'user',content:b.prompt}],timeoutMs:config.requestTimeoutMs})})));
   return json(res,200,{results:responses.map((r,i)=>r.status==='fulfilled'?{ok:true,...r.value}:{ok:false,model:selected[i],error:safeError(r.reason).error}),parallel:true});
  }
  fail(404,'not_found','Endpoint not found');
 }catch(e){logRequestError(config,e,'request');if(!res.headersSent)json(res,e.status||500,safeError(e));else if(!res.writableEnded)res.end();}}
 return {api:http.createServer((req,res)=>dispatch(req,res,false)),ui:http.createServer((req,res)=>dispatch(req,res,true)),manager};
}
export async function start(config=null){
 config ||= await loadConfig();
 if(config.token.length<43)throw Error('Missing strong GATEWAY_TOKEN. Run setup first.');
 const srv=createServers(config);await Promise.all([new Promise((ok,fail)=>srv.api.listen(config.apiPort,config.apiHost).once('listening',ok).once('error',fail)),...(config.uiDisabled?[]:[new Promise((ok,fail)=>srv.ui.listen(config.uiPort,config.uiHost||'127.0.0.1').once('listening',ok).once('error',fail))])]);
 console.log(config.uiDisabled?'UI disabled in worker':'Local Studio: http://127.0.0.1:'+config.uiPort);console.log('Authenticated API: http://127.0.0.1:'+config.apiPort);
 return srv;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const running=await start();let closing=false;
 async function stop(signal){if(closing)return;closing=true;console.log('Stopping Orbit Gateway:',signal);
  await running.manager.close().catch(e=>console.error('Browser shutdown:',e.message));
  await Promise.allSettled([new Promise(resolve=>running.api.close(resolve)),...(running.ui.listening?[new Promise(resolve=>running.ui.close(resolve))]:[])]);
  process.exit(0);
 }
 process.on('SIGTERM',()=>{void stop('SIGTERM');});process.on('SIGINT',()=>{void stop('SIGINT');});
}
