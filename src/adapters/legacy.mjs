import {fail,GatewayError} from '../lib/errors.mjs';
import {parseStream} from '../lib/sse.mjs';
const tokenHeader=token=>({'Authorization':`Bearer ${token}`});
async function post(url,headers,body,timeoutMs){let response;try{response=await fetch(url,{method:'POST',headers,body:typeof body==='string'||body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}catch(e){throw new GatewayError(503,'upstream_unreachable','Legacy provider worker unreachable: '+e.message);}
 if(!response.ok){let msg;try{const json=await response.json();msg=json.error?.message||json.error||json.message;}catch{}throw new GatewayError(response.status,'upstream_error',String(msg||`Upstream HTTP ${response.status}`).slice(0,250));}return response;}
export async function ping(origin,token){try{const r=await fetch(origin+'/health',{headers:tokenHeader(token),signal:AbortSignal.timeout(1600)});return r.ok;}catch{return false;}}
export async function legacyChat(provider,config,request,onProgress){
 const gpt=provider==='gpt',origin=gpt?config.gptOrigin:config.geminiOrigin;
 const model=gpt?'gpt-web-chat':'gemini-web-chat';
 const route=gpt?'/chat/stream':'/v1/chat/completions';
 const payload={provider,model,messages:request.messages,stream:true,stream_mode:'snapshots',...(request.conversation_id?{conversation_id:request.conversation_id}:{}),...(gpt&&request.native_project_id?{native_project_id:request.native_project_id}:{})};
 const r=await post(origin+route,{...tokenHeader(config.token),'Content-Type':'application/json'},payload,config.requestTimeoutMs);
 let text='',attachments=[],file_warning=null,done=false,conversation_id=request.conversation_id||null;let emitted='';let finishReason='stop';
 await parseStream(r.body,(data,complete)=>{
  if(complete){done=true;return;}if(!data)return;
  if(data.error)throw new GatewayError(502,'upstream_stream_error',String(data.error?.message||data.error));
  if(typeof data.conversation_id==='string')conversation_id=data.conversation_id;
  if(Array.isArray(data.attachments))attachments=data.attachments;
  if(typeof data.file_warning==='string')file_warning=data.file_warning;
  if(['gateway.snapshot','gateway.final','gateway.reconcile'].includes(data.event||'')&&typeof data.text==='string'){
    text=data.text;
  }else if(typeof data.text==='string'&&(!data.choices||data.type==='snapshot')){
    text=data.text;
  }else {
    const delta=data.choices?.[0]?.delta?.content;if(typeof delta==='string')text+=delta;
    const c=data.choices?.[0]?.message?.content;if(typeof c==='string')text=c;
    if(data.choices?.[0]?.finish_reason)finishReason=data.choices[0].finish_reason;
  }
  // Snapshots can replace prior text, e.g. corrected words.
  if(text!==emitted){onProgress?.(text);emitted=text;}
 });
 if(!done)fail(502,'upstream_incomplete','Provider stream ended without [DONE]');
 return {text,attachments,...(file_warning?{file_warning}:{}),conversation_id,finish_reason:finishReason,actual_model:'browser_default',selection_verified:false};
}
export async function legacyImage(provider,config,request){
 const gpt=provider==='gpt',origin=gpt?config.gptOrigin:config.geminiOrigin;
 const edit=request.mode==='edit',route=gpt?(edit?'/images/edits':'/images/generations'):(edit?'/v1/images/edits':'/v1/images/generations');
 const payload={prompt:request.prompt,n:1,aspect_ratio:request.aspect_ratio||'auto',...(request.conversation_id?{conversation_id:request.conversation_id}:{})};
 if(!gpt){payload.model='gemini-web-image';payload.provider='gemini';payload.response_format='b64_json';}
 if(request.imageBase64) {if(gpt){payload.imageBase64=request.imageBase64;payload.inputMime=request.inputMime;}
 else { const body=new FormData();for(const [key,value] of Object.entries(payload))if(value!=null)body.append(key,String(value));body.append('image',new Blob([Buffer.from(request.imageBase64,'base64')],{type:request.inputMime}),'reference.'+(request.inputMime==='image/png'?'png':request.inputMime==='image/webp'?'webp':'jpg'));const result=await post(origin+route,tokenHeader(config.token),body,config.requestTimeoutMs);return await result.json(); }}
 const result=await post(origin+route,{...tokenHeader(config.token),'Content-Type':'application/json'},payload,config.requestTimeoutMs);
 let json;try{json=await result.json()}catch{fail(502,'invalid_image_response','Invalid image result from provider');}
 return json;
}
