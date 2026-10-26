/* Private container-to-container bridge to provider-scoped Orbit browser workers.
   Each worker accepts only its configured provider; internal HTTP port is never exposed to host. */
import {GatewayError,fail} from '../lib/errors.mjs';
import {parseStream} from '../lib/sse.mjs';
const headers=token=>({authorization:`Bearer ${token}`,'content-type':'application/json'});
function origin(config,provider){const host=config[provider+'Origin'];if(!host)fail(503,'remote_unconfigured',`Missing origin for ${provider}`);return host.replace(/\/$/,'');}
async function send(config,provider,endpoint,payload,{stream=false}={}){
 let res;
 try{res=await fetch(origin(config,provider)+endpoint,{method:'POST',headers:headers(config.token),body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(config.requestTimeoutMs||240000)});}
 catch(e){throw new GatewayError(503,'remote_unreachable',`${provider} worker unreachable: ${e.message}`);}
 if(!res.ok){let message=`Worker returned ${res.status}`;try{const j=await res.json();message=j.error?.message||message;}catch{}throw new GatewayError(res.status,'worker_error',String(message).slice(0,500));}
 return res;
}
export async function remotePing(host,token){if(!host)return false;try{const r=await fetch(host.replace(/\/$/,'')+'/health',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(1600)});return r.ok;}catch{return false;}}
export async function remoteChat(provider,config,request,onProgress){
 const started=performance.now();let firstTextAt=null;
 const payload={model:request.model||(provider==='aimode'?'google-ai-mode':provider),messages:request.messages,conversation_id:request.conversation_id||undefined,native_project_id:request.native_project_id||undefined,reasoning_effort:request.effort||'auto',stream:true};
 const res=await send(config,provider,'/v1/chat/completions',payload,{stream:true});
 let text='',conversation_id=request.conversation_id||null,actual_model='browser_default',selection_verified=false,done=false,workerError=null;
 await parseStream(res.body,(data,complete)=>{
  if(complete){done=true;return;}
  if(!data)return;
  if(data.error){workerError={code:String(data.error.code||'remote_stream_error'),message:String(data.error.message||data.error)};return;}
  if(data.event==='gateway.error'){workerError={code:String(data.code||'remote_stream_error'),message:String(data.message||'Worker error')};return;}
  if(typeof data.conversation_id==='string')conversation_id=data.conversation_id;
  if(data.actual_model)actual_model=data.actual_model;
  if(typeof data.model_selection_verified==='boolean')selection_verified=data.model_selection_verified;
  const delta=data.choices?.[0]?.delta;
  if(typeof delta?.content==='string'){
   if(delta.content.length&&firstTextAt===null)firstTextAt=performance.now();
   if(data.snapshot)text=delta.content;else text+=delta.content;
   onProgress?.(text);
  }
 });
 console.info('[ORBIT-PERF]',JSON.stringify({provider,phase:'worker_stream',ttft_ms:firstTextAt===null?null:Math.round(firstTextAt-started),total_ms:Math.round(performance.now()-started),reply_chars:text.length,complete:done&&!workerError}));
 if(workerError){
  const status=workerError.code==='google_verification_required'?503:
    ['provider_quota_exceeded','provider_quota_cooldown','orbit_usage_cap'].includes(workerError.code)?429:502;
  throw new GatewayError(status,workerError.code,workerError.message.slice(0,350));
 }
 if(!done)throw new GatewayError(502,'remote_stream_incomplete',`${provider} worker ended without DONE; do not blindly retry`);
 return {text,conversation_id,actual_model,selection_verified};
}
export async function remoteImage(provider,config,request){
 const endpoint=request.mode==='edit'?'/v1/images/edits':'/v1/images/generations';
 const payload={model:request.model||(provider==='aimode'?'google-ai-mode':provider),prompt:request.prompt,aspect_ratio:request.aspect_ratio,conversation_id:request.conversation_id||undefined,...(request.imageBase64?{imageBase64:request.imageBase64,inputMime:request.inputMime}:{})};
 const res=await send(config,provider,endpoint,payload);
 try{return await res.json();}catch{throw new GatewayError(502,'worker_invalid_image','Worker returned non-JSON image result');}
}
