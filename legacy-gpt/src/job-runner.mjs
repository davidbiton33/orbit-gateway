import { GatewayError, validateImageBuffer, validateOptions, validatePrompt } from './security.mjs';
import { parseChatRequest, chatResponse } from './chat.mjs';
import { resolveProvider } from './providers.mjs';
import { validateGptChat, validateGptImageOptions } from './gpt.mjs';
import { validatePriority } from './jobs.mjs';

/** Decode only inline validated images. Arbitrary image URLs are forbidden. */
export function decodeJobImage(value,maxBytes=10*1024*1024) {
  if(typeof value!=='string'||value.length>Math.ceil(maxBytes*4/3)+120)
    throw new GatewayError(413,'image_limit','Expected an inline image data URL within the upload limit');
  const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if(!m || m[2].length%4===1)throw new GatewayError(400,'invalid_image','Image must be a PNG, JPEG, or WebP base64 data URL');
  const bytes=Buffer.from(m[2],'base64');
  const mime=validateImageBuffer(bytes,maxBytes);
  if(mime!==m[1])throw new GatewayError(400,'mime_mismatch','Image signature and MIME type differ');
  return {bytes,mime};
}

/** Validate BEFORE an asynchronous job is accepted, so invalid requests fail with HTTP 4xx. */
export function validateJobBody(body,{maxInputBytes=10*1024*1024}={}) {
  if(!body||typeof body!=='object'||Array.isArray(body) ||
    !['chat','image_generation','image_edit'].includes(body.type) ||
    !body.request||typeof body.request!=='object'||Array.isArray(body.request)) {
    throw new GatewayError(400,'invalid_job','Expected {type: chat|image_generation|image_edit, request: {...}}');
  }
  const kind=body.type==='chat'?'chat':'image';
  const {provider}=resolveProvider(body.request,kind);
  if(body.type==='chat'){
    if(provider==='gpt')validateGptChat({...body.request,stream:true},maxInputBytes);
    else {
      if(body.request.thinking_mode)throw new GatewayError(400,'unsupported_thinking_mode','thinking_mode is supported only by GPT');
      parseChatRequest({...body.request,stream:false,stream_mode:undefined},{maxInputBytes});
    }
  }else{
    validatePrompt(body.request.prompt);
    if(provider==='gpt')validateGptImageOptions(body.request);
    else {
      validateOptions(body.request);
      if(body.request.aspect_ratio && body.request.aspect_ratio!=='auto')
        throw new GatewayError(400,'unsupported_aspect_ratio','Gemini does not support aspect ratio selection');
    }
    if(body.type==='image_edit')decodeJobImage(body.request.image_data_url,maxInputBytes);
    else if(body.request.image_data_url!==undefined)throw new GatewayError(400,'invalid_image','Use image_edit for reference images');
  }
  return {type:body.type,provider,request:body.request};
}

/** One prompt, two isolated provider requests. No cross-provider conversation IDs. */
export function validateCompareBody(body,{maxInputBytes=10*1024*1024}={}) {
  if(!body || typeof body!=='object' || Array.isArray(body) || !Array.isArray(body.messages))
    throw new GatewayError(400,'invalid_comparison','Expected {messages:[...], priority?: ...}');
  const priority=validatePriority(body.priority??'normal');
  const gemini={provider:'gemini',model:'gemini-web-chat',messages:body.messages};
  const gpt={provider:'gpt',model:'gpt-web-chat',messages:body.messages};
  if(body.thinking_mode!==undefined)gpt.thinking_mode=body.thinking_mode;
  if(body.conversation_ids!==undefined){
    if(!body.conversation_ids || typeof body.conversation_ids!=='object' || Array.isArray(body.conversation_ids))
      throw new GatewayError(400,'invalid_conversation_ids','conversation_ids must be an object');
    if(body.conversation_ids.gemini)gemini.conversation_id=body.conversation_ids.gemini;
    if(body.conversation_ids.gpt)gpt.conversation_id=body.conversation_ids.gpt;
  }
  return {priority,gemini:validateJobBody({type:'chat',request:gemini},{maxInputBytes}),
    gpt:validateJobBody({type:'chat',request:gpt},{maxInputBytes})};
}

/** Safe pre-dispatch checks. Never re-run a possibly accepted prompt. */
export async function providerPreflight(gpt,provider) {
  if(provider!=='gpt')return;
  if(!gpt)throw new GatewayError(503,'gpt_not_configured','Native GPT engine is unavailable');
  if(typeof gpt.probe==='function' && await gpt.probe()===false){
    const error=new GatewayError(503,'gpt_preflight_unavailable','Native ChatGPT browser is not authenticated or blocked');
    error.safeToRetry=true;throw error;
  }
}

/** Consume GPT's actual upstream SSE and aggregate its deltas for persistence. */
export async function collectGptStream(response,onSnapshot=()=>{}) {
  let buffer='',text='',conversationId=null,done=false,receivedError=null,totalBytes=0,sawSnapshot=false;
  const dec=new TextDecoder();
  function frame(data){
    const lines=data.split('\n');let event='message';let values=[];
    for(const line of lines){
      if(line.startsWith('event:'))event=line.slice(6).trim();
      else if(line.startsWith('data:'))values.push(line.slice(5).trimStart());
    }
    if(!values.length)return;
    const raw=values.join('\n');
    if(raw==='[DONE]'){done=true;return;}
    let item;try{item=JSON.parse(raw);}catch{throw new GatewayError(502,'gpt_stream_invalid','GPT emitted invalid SSE JSON');}
    if(event==='gateway.error'||item?.error){receivedError=new GatewayError(502,'gpt_stream_failed',String(item?.error?.message||'GPT stream failed').slice(0,400));return;}
    if(event==='gateway.snapshot'||event==='gateway.reconcile'||event==='gateway.final'){
      if(typeof item.text==='string'){sawSnapshot=true;if(text!==item.text){text=item.text;onSnapshot(text);}}
      if(item.conversation_id)conversationId=item.conversation_id;
      return;
    }
    const delta=item?.choices?.[0]?.delta?.content;
    if(typeof delta==='string'&&delta&&!sawSnapshot){text+=delta;onSnapshot(text);}
    if(typeof item?.conversation_id==='string')conversationId=item.conversation_id;
  }
  for await(const chunk of response.body){
    totalBytes+=chunk.byteLength;
    if(totalBytes>32*1024*1024)throw new GatewayError(502,'gpt_stream_limit','GPT stream exceeded 32MB');
    buffer+=dec.decode(chunk,{stream:true});
    buffer=buffer.replace(/\r\n/g,'\n');
    let idx;while((idx=buffer.indexOf('\n\n'))>=0){frame(buffer.slice(0,idx));buffer=buffer.slice(idx+2);}
    if(receivedError)throw receivedError;
    if(done)break;
  }
  if(buffer.trim()&&!done)frame(buffer);
  if(receivedError)throw receivedError;
  if(!done)throw new GatewayError(502,'gpt_stream_incomplete','GPT stream ended before [DONE]');
  if(!text)throw new GatewayError(502,'gpt_empty_response','GPT stream produced no text');
  return {id:`chatcmpl-job-${Date.now()}`,object:'chat.completion',created:Math.floor(Date.now()/1000),
    model:'gpt-web-chat',provider:'gpt',conversation_id:conversationId,
    choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:null};
}

export function createJobRunner({browser,queue,gpt,processImage,maxInputBytes=10*1024*1024}) {
  return async({type,provider,request,report})=>{
    if(type==='chat'){
      if(provider==='gpt'){
        await providerPreflight(gpt,provider);
        const upstream=await gpt.openChatStream({...request,stream:true});
        return collectGptStream(upstream,report);
      }
      const parsed=parseChatRequest({...request,stream:false,stream_mode:undefined},{maxInputBytes});
      const result=await queue.run(()=>browser.chat({...parsed,onProgress:report}));
      return {...chatResponse(result),provider:'gemini'};
    }
    const params={...request};
    if(type==='image_edit'){
      const image=decodeJobImage(params.image_data_url,maxInputBytes);
      delete params.image_data_url;
      params.imageBytes=image.bytes;params.inputMime=image.mime;
    }
    await providerPreflight(gpt,provider);
    return processImage(params);
  };
}
