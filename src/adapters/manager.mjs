import {BrowserHub} from './browser.mjs';
import {legacyChat,legacyImage,ping} from './legacy.mjs';
import {fail} from '../lib/errors.mjs';
import {remoteChat,remoteImage,remotePing} from './remote.mjs';
import {unpackGptConversation,applyGptBackendResult,packGptConversation} from './gpt-backend.mjs';
import {GatewayError} from '../lib/errors.mjs';

export class ProviderManager {
 constructor(config,{browserHub}={}){
  this.config=config;
  this.browser=browserHub||new BrowserHub(config);
  this.busy=new Set();
 }
 async mode(provider){
  if(provider==='aimode'&&this.config.workerProvider==='gemini')return 'browser';
  const preference=this.config[provider+'Mode'];
  if(preference==='remote'||preference==='browser'||preference==='legacy')return preference;
  if(provider==='aimode')return ['gemini','aimode'].includes(this.config.workerProvider)?'browser':'remote';
  if(provider==='claude')return 'browser';
  return await ping(provider==='gpt'?this.config.gptOrigin:this.config.geminiOrigin,this.config.token)?'legacy':'browser';
 }
 async status(){
  return Promise.all(['gpt','gemini','claude'].map(async provider=>({
   provider,mode:await this.mode(provider),
   ...(provider==='gpt'&&this.config.gptBackend?{backend:this.config.gptBackend}:{}),
   legacy_reachable:provider!=='claude'&&await ping(provider==='gpt'?this.config.gptOrigin:this.config.geminiOrigin,this.config.token),
   remote_reachable:this.config[provider+'Mode']==='remote'&&await remotePing(this.config[provider+'Origin'],this.config.token),
   browser:await this.browser.probe(provider)
  })));
 }
 async chat(r,onProgress){
  const backend=r.provider==='gpt'?this.config.gptBackend:null;
  const request=backend?{...r,conversation_id:unpackGptConversation(r.conversation_id,backend)}:r;
  const mode=await this.mode(request.provider);
  if(request.native_project_id && !((request.provider==='gpt'&&mode==='legacy')||(request.provider==='claude'&&['browser','remote'].includes(mode))))fail(422,'native_project_backend_unverified','Native projects are available only for ChatGPT Legacy or Claude Browser; no message sent.');
  let result;
  if(mode==='legacy'){
   if(request.model!=null)fail(422,'model_unverified','Legacy worker cannot verify named model selection. Use the default provider alias.');
   if(request.effort!=='auto')fail(422,'effort_unverified','Legacy worker cannot verify thinking effort selection. No prompt sent.');
   result=await legacyChat(request.provider,this.config,request,onProgress);
  } else if(mode==='remote'){
   result=await remoteChat(request.provider,this.config,request,onProgress);
  } else {
   result=await this.browser.send(request.provider,request,onProgress);
  }
  return backend?applyGptBackendResult(result,backend):result;
 }
 async image(r){
  const backend=r.provider==='gpt'?this.config.gptBackend:null;
  const request=backend?{...r,conversation_id:unpackGptConversation(r.conversation_id,backend)}:r;
  const mode=await this.mode(request.provider);
  let result;
  if(mode==='remote')result=await remoteImage(request.provider,this.config,request);
  else if(mode==='browser'&&['gemini','claude','aimode'].includes(request.provider))result=await this.browser.image(request.provider,request);
  else if(mode!=='legacy')fail(501,'browser_images_unimplemented','Image generation is not implemented for this browser provider.');
  else {
   if(request.model)fail(422,'image_model_unverified','Named image model selection is not verified.');
   if(request.effort!=='auto')fail(422,'image_effort_unverified','Image thinking mode cannot be verified.');
   result=await legacyImage(request.provider,this.config,request);
  }
  return backend?applyGptBackendResult(result,backend):result;
 }
 async nativeProjects(provider){
  if(!['gpt','claude','gemini'].includes(provider))fail(400,'invalid_provider','Unknown project provider');
  const mode=await this.mode(provider);
  if(mode==='browser')return this.browser.listNativeProjects(provider);
  const legacy=mode==='legacy';
  const base=provider==='gpt'?this.config.gptOrigin:provider==='gemini'?this.config.geminiOrigin:this.config.claudeOrigin;
  const route=legacy?'/projects':'/v1/projects/native?provider='+encodeURIComponent(provider);
  let response;
  try{response=await fetch(base+route,{headers:{authorization:'Bearer '+this.config.token},signal:AbortSignal.timeout(35000)});}
  catch(error){throw new GatewayError(503,'provider_projects_unreachable','Provider project discovery is unavailable: '+error.message);}
  if(!response.ok)throw new GatewayError(response.status,'provider_projects_failed','Provider project discovery returned '+response.status);
  const body=await response.json();
  return {provider,scope:'native',status:body.status||'unverified_empty',projects:Array.isArray(body.projects)?body.projects:[]};
 }
 async #nativeGptProjectRequest(method,route,body=null){
  if(this.config.gptBackend!=='legacy'||await this.mode('gpt')!=='legacy')fail(422,'native_project_backend_unverified','Native ChatGPT projects require GPT_BACKEND=legacy.');
  let response;
  try{response=await fetch(this.config.gptOrigin+route,{
    method,headers:{authorization:'Bearer '+this.config.token,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
    redirect:'error',signal:AbortSignal.timeout(60000)
  });}catch(e){throw new GatewayError(503,'native_project_unreachable','ChatGPT project worker is unavailable: '+e.message);}
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new GatewayError(response.status,result.error?.code||'native_project_failed',result.error?.message||'Project operation failed');
  return result;
 }
 async #nativeClaudeRequest(method,route,body=null){
  if(await this.mode('claude')!=='remote')fail(422,'native_project_backend_unverified','Claude browser worker is required');
  let response;
  try{response=await fetch(this.config.claudeOrigin+route,{
    method,headers:{authorization:'Bearer '+this.config.token,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(65000),redirect:'error'
  });}catch(e){throw new GatewayError(503,'claude_project_unreachable',e.message);}
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new GatewayError(response.status,result.error?.code||'claude_project_error',result.error?.message||'Claude project request failed');
  return result;
 }
 async nativeProjectChats(provider,id){
  if(provider==='claude')return this.config.workerProvider==='claude'?this.browser.listClaudeProjectChats(id):this.#nativeClaudeRequest('GET','/v1/projects/native/chats?provider=claude&project_id='+encodeURIComponent(id));
  if(provider!=='gpt')fail(422,'native_project_unverified','Listing native chats is supported for ChatGPT and Claude only.');
  if(typeof id!=='string'||!/^g-p-[A-Za-z0-9_-]{6,90}$/.test(id))fail(422,'invalid_native_project','Invalid ChatGPT project ID');
  return this.#nativeGptProjectRequest('GET','/projects/'+encodeURIComponent(id)+'/chats');
 }
 async openNativeProjectChat(provider,projectId,chatUrl){
  if(provider==='claude')return this.config.workerProvider==='claude'?this.browser.openClaudeProjectChat(projectId,chatUrl):this.#nativeClaudeRequest('POST','/v1/projects/native/open-chat',{provider,project_id:projectId,chat_url:chatUrl});
  if(provider!=='gpt')fail(422,'native_project_unverified','Opening existing chats is supported for ChatGPT and Claude only.');
  if(typeof projectId!=='string'||!/^g-p-[A-Za-z0-9_-]{6,90}$/.test(projectId))fail(422,'invalid_native_project','Invalid ChatGPT project ID');
  if(typeof chatUrl!=='string'||chatUrl.length>300)fail(422,'invalid_project_chat','Invalid project conversation URL');
  const result=await this.#nativeGptProjectRequest('POST','/projects/chats/open',{project_id:projectId,chat_url:chatUrl});
  return {...result,conversation_id:packGptConversation(result.conversation_id,'legacy')};
 }
 async createNativeProject(provider,name,description=''){
  if(provider==='claude'){
    if(this.config.workerProvider==='claude')return this.browser.createClaudeProject(name,description);
    if(await this.mode('claude')!=='remote')fail(422,'native_project_backend_unverified','Claude project creation requires the browser worker');
    let res;
    try{res=await fetch(this.config.claudeOrigin+'/v1/projects/native',{method:'POST',headers:{authorization:'Bearer '+this.config.token,'Content-Type':'application/json'},body:JSON.stringify({provider,name,description}),signal:AbortSignal.timeout(65000)});}
    catch(e){throw new GatewayError(503,'claude_project_unreachable',e.message);}
    const body=await res.json().catch(()=>({}));
    if(!res.ok)throw new GatewayError(res.status,body.error?.code||'claude_project_failed',body.error?.message||'Claude project creation failed');
    return body;
  }
  if(provider!=='gpt')fail(422,'native_project_unverified','Native project creation supports ChatGPT and Claude only.');
  if(typeof name!=='string'||name.trim().length<2||name.trim().length>80)fail(422,'invalid_project_name','Name must contain 2–80 characters');
  return this.#nativeGptProjectRequest('POST','/projects/create',{name:name.trim()});
 }
 async close(){await this.browser.close();}
}
