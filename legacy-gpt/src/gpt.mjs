import { GatewayError, validateImageBuffer } from './security.mjs';
import { parseChatRequest } from './chat.mjs';

const THINKING_MODES = new Set(['instant','standard','extended','extra_high','pro']);
const LIMIT = 32 * 1024 * 1024;

/** The upstream ChatGPT Web Gateway is strictly loopback. NEVER proxy an arbitrary user-supplied URL. */
export function parseLocalGptOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('GPT_WEB_URL must be a loopback HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || Number(url.port || 80) < 1 || Number(url.port || 80) > 65535) {
    throw new Error('GPT_WEB_URL must be an HTTP origin on localhost; no remote host, credentials, or path');
  }
  return url.origin;
}

async function readLimited(response, limit = LIMIT) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > limit) throw new GatewayError(502,'upstream_too_large','GPT response exceeded the size limit');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let used = 0, parts = [];
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      used += value.byteLength;
      if (used > limit) throw new GatewayError(502,'upstream_too_large','GPT response exceeded the size limit');
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts,used);
}

export function validateGptChat(body,maxInputBytes=10485760) {
  // Same MIME, role, file size, URL and tool restrictions as Gemini.
  parseChatRequest(body, {maxInputBytes,allowedModels:['gpt-web-chat']});
  if (body.thinking_mode != null && !THINKING_MODES.has(body.thinking_mode)) {
    throw new GatewayError(400,'invalid_thinking_mode','thinking_mode must be instant, standard, extended, extra_high, or pro');
  }
  if (body.native_project_id != null && (typeof body.native_project_id!=='string'||!/^g-p-[A-Za-z0-9_-]{6,90}$/.test(body.native_project_id))) {
    throw new GatewayError(422,'invalid_native_project','native_project_id must be a real ChatGPT g-p project ID');
  }
  if (body.include_images === true) {
    throw new GatewayError(400,'chat_images_unsupported','GPT chat image output is not guaranteed; use the images endpoints');
  }
  return {
    model:'gpt-web-chat',
    messages:body.messages,
    ...(body.conversation_id ? {conversation_id:body.conversation_id}:{}),
    ...(body.thinking_mode ? {thinking_mode:body.thinking_mode}:{}),
    ...(body.native_project_id ? {native_project_id:body.native_project_id}:{}),
    stream:body.stream===true,
  };
}

export function validateGptImageOptions(body) {
  if (body.n !== undefined && (!Number.isInteger(Number(body.n)) || Number(body.n) < 1 || Number(body.n) > 4)) {
    throw new GatewayError(400,'unsupported_n','GPT supports 1-4 images per gateway request');
  }
  if (body.response_format !== undefined && body.response_format !== 'b64_json') {
    throw new GatewayError(400,'unsupported_format','Only response_format=b64_json is supported');
  }
  if (body.aspect_ratio !== undefined && !['1:1','16:9','9:16','4:3','3:4','auto'].includes(body.aspect_ratio)) {
    throw new GatewayError(400,'invalid_aspect_ratio','Unsupported aspect_ratio');
  }
}

export class GptWebClient {
  constructor({origin='http://127.0.0.1:3000',apiKey='',timeoutMs=300000,maxOutputBytes=20971520,maxInputBytes=10485760,fetchImpl=fetch} = {}) {
    this.origin = parseLocalGptOrigin(origin);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.maxInputBytes = maxInputBytes;
    this.fetch = fetchImpl;
  }
  async probe() {
    try {
      const response = await this.fetch(`${this.origin}/health/live`, {method:'GET',redirect:'error',signal:AbortSignal.timeout(2500)});
      return response.status === 200;
    } catch { return false; }
  }
  async #request(path,{body,asMultipart=false,timeoutMs=this.timeoutMs}={}) {
    if (!this.apiKey) throw new GatewayError(503,'gpt_not_configured','Set GPT_WEB_API_KEY in .env; the existing GPT Web Gateway must run locally on port 3000');
    const headers = {Authorization:`Bearer ${this.apiKey}`};
    if (!asMultipart) headers['Content-Type']='application/json';
    let response;
    try {
      response = await this.fetch(this.origin + path, {
        method:'POST',headers,body:asMultipart?body:JSON.stringify(body),
        redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GatewayError(503,'gpt_unavailable',error?.name==='TimeoutError'?'GPT Web Gateway timed out':'GPT Web Gateway is not reachable on localhost');
    }
    const bytes = await readLimited(response);
    let parsed;
    try { parsed=JSON.parse(bytes.toString('utf8')); }
    catch { throw new GatewayError(502,'gpt_bad_response','GPT Web Gateway returned invalid JSON'); }
    if (!response.ok) {
      const code = typeof parsed?.error?.code === 'string' ? parsed.error.code.slice(0,80) : 'gpt_upstream_error';
      const message = typeof parsed?.error?.message === 'string' ? parsed.error.message.slice(0,500) :
        `GPT Web Gateway returned HTTP ${response.status}`;
      throw new GatewayError(response.status>=400&&response.status<500?response.status:502,code,message);
    }
    return parsed;
  }
  async chat(payload) {
    const request=validateGptChat(payload,this.maxInputBytes);
    const response=await this.#request('/v1/chat/completions',{body:request});
    if (!Array.isArray(response?.choices) || typeof response.choices?.[0]?.message?.content !== 'string') {
      throw new GatewayError(502,'gpt_bad_response','GPT response has no text message');
    }
    return {
      id:typeof response.id==='string'?response.id:`chatcmpl-gpt-${Date.now()}`,
      object:'chat.completion',created:response.created||Math.floor(Date.now()/1000),
      provider:'gpt',model:'gpt-web-chat',
      choices:[{index:0,message:{role:'assistant',content:response.choices[0].message.content},finish_reason:'stop'}],
      conversation_id:response.conversation_id||null,
      ...(response.applied?{applied:response.applied}:{}),usage:response.usage||null,
    };
  }

  /** Pass through the real SSE stream from the existing GPT Web Gateway.
   * This upstream supports stream=true when READ_VIA_BACKEND_API is enabled.
   * No fallback to fake streaming: fail clearly if upstream declines SSE.
   */
  async openChatStream(payload) {
    const body=validateGptChat({...payload,stream:true},this.maxInputBytes);
    if(!this.apiKey)throw new GatewayError(503,'gpt_not_configured','GPT_WEB_API_KEY is missing');
    let response;
    try {
      response=await this.fetch(this.origin+'/v1/chat/completions',{
        method:'POST',redirect:'error',
        headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json','Accept':'text/event-stream'},
        body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs),
      });
    } catch(error) {
      throw new GatewayError(503,'gpt_unavailable',error?.name==='TimeoutError'?'GPT stream timed out':'GPT upstream stream unavailable');
    }
    if(!response.ok) {
      const bytes=await readLimited(response,128*1024);
      let message='GPT streaming request was rejected';
      try {message=JSON.parse(bytes.toString()).error?.message||message;} catch {}
      throw new GatewayError(response.status>=400&&response.status<500?response.status:502,'gpt_stream_rejected',message);
    }
    if(!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      await response.body?.cancel?.();
      throw new GatewayError(502,'gpt_not_sse','GPT upstream did not return text/event-stream; refusing to fabricate streaming');
    }
    return response;
  }
  async #normalizeImages(response) {
    if (!Array.isArray(response?.data) || !response.data.length) throw new GatewayError(502,'gpt_no_images','GPT did not return any images');
    const data = [];
    for(const entry of response.data) {
      let bytes;
      if (typeof entry?.b64_json==='string') {
        if (entry.b64_json.length > this.maxOutputBytes * 1.38 + 40) throw new GatewayError(502,'image_limit','GPT image exceeded size limit');
        bytes=Buffer.from(entry.b64_json,'base64');
      } else if (typeof entry?.url==='string') {
        bytes=await this.#downloadLocalImage(entry.url);
      } else {throw new GatewayError(502,'gpt_bad_image','GPT image response had no recognized image data');}
      const mime=validateImageBuffer(bytes,this.maxOutputBytes);
      data.push({b64_json:bytes.toString('base64'),mime_type:mime});
    }
    return {created:response.created||Math.floor(Date.now()/1000),provider:'gpt',data,mime_type:data[0].mime_type};
  }
  async #downloadLocalImage(value) {
    let url;
    try {url=new URL(value,this.origin);}catch{throw new GatewayError(502,'unsafe_gpt_image_url','Invalid GPT image URL');}
    if (url.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)
        || url.port !== new URL(this.origin).port || !/^\/images\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(url.pathname)
        || url.search || url.hash || url.username || url.password) {
      throw new GatewayError(502,'unsafe_gpt_image_url','GPT returned an image URL outside its local /images/ directory');
    }
    let res;
    try {res=await this.fetch(this.origin+url.pathname,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});}
    catch {throw new GatewayError(502,'gpt_image_download_failed','Could not download GPT image from local gateway');}
    if (!res.ok) throw new GatewayError(502,'gpt_image_download_failed',`GPT local image download failed (${res.status})`);
    return readLimited(res,this.maxOutputBytes);
  }
  async generate({prompt,n=1,aspect_ratio='1:1'}) {
    validateGptImageOptions({n,aspect_ratio});
    const response=await this.#request('/v1/images/generations',{body:{prompt,n:Number(n),aspect_ratio,response_format:'b64_json'}});
    return this.#normalizeImages(response);
  }
  async edit({prompt,imageBytes,inputMime,n=1,aspect_ratio='1:1'}) {
    validateGptImageOptions({n,aspect_ratio});
    const mime=validateImageBuffer(imageBytes,this.maxInputBytes);
    if(inputMime && inputMime!==mime) throw new GatewayError(400,'mime_mismatch','Input image MIME does not match bytes');
    const extension=mime==='image/png'?'png':mime==='image/jpeg'?'jpg':'webp';
    const form = new FormData();
    form.set('prompt',prompt);form.set('n',String(n));form.set('aspect_ratio',aspect_ratio);form.set('response_format','b64_json');
    form.set('image',new Blob([imageBytes],{type:mime}),`reference.${extension}`);
    const response=await this.#request('/v1/images/edits',{body:form,asMultipart:true});
    return this.#normalizeImages(response);
  }
}
