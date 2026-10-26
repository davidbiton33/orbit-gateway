/**
 * Passive ChatGPT answer capture. Observes ONLY network traffic from the already
 * logged-in chatgpt.com tab. No direct backend requests, cookie exports or raw
 * request/response logging. This is an unofficial, version-dependent UI adapter.
 */
import { randomUUID } from 'node:crypto';

const MAX_ANSWER_CHARS = 1_000_000;
const MAX_BUFFER_CHARS = 2_000_000;
const CAPTURE_HOOK = '__uaiGptPassiveChunk';

export function isChatGptAnswerEndpoint(url, method = 'POST') {
  try {
    const u = new URL(url);
    return u.origin === 'https://chatgpt.com' && method.toUpperCase() === 'POST' &&
      /^\/backend-api\/(?:f\/)?conversation\/?$/.test(u.pathname);
  } catch { return false; }
}

function messageText(message) {
  const data = message?.content;
  if (!data) return '';
  if (Array.isArray(data.parts)) return data.parts.map(x => typeof x === 'string' ? x : (typeof x?.text === 'string' ? x.text : '')).join('\n');
  if (typeof data.text === 'string') return data.text;
  return '';
}
function isFinal(message) {
  if (!message || message.author?.role !== 'assistant') return false;
  if (message.recipient && message.recipient !== 'all') return false;
  const channel = message.channel ?? message.metadata?.message_type ?? 'final';
  if (channel !== 'final') return false;
  return !message.content?.content_type || ['text','multimodal_text'].includes(message.content.content_type);
}

/** Incremental parser for both full-message SSE and JSON-patch-like deltas. */
export class GptSseParser {
  constructor() { this.text=''; this.complete=false; this.conversationId=null; this.events=0; this.tracking=false; this.lineBuffer=''; this.dataLines=[]; this.bytesObserved=0; this.parseFailures=0; }
  snapshot() { return {text:this.text,complete:this.complete,conversationId:this.conversationId,events:this.events,bytesObserved:this.bytesObserved}; }
  feed(chunk) {
    if (typeof chunk !== 'string' || !chunk || this.complete) return;
    this.bytesObserved+=chunk.length;
    if (this.bytesObserved > MAX_BUFFER_CHARS || this.lineBuffer.length + chunk.length > MAX_BUFFER_CHARS) return;
    this.lineBuffer += chunk;
    let at;
    while ((at=this.lineBuffer.indexOf('\n'))>=0) {
      const line=this.lineBuffer.slice(0,at).replace(/\r$/,'');
      this.lineBuffer=this.lineBuffer.slice(at+1);
      if (!line) this.flush();
      else if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /,''));
    }
  }
  finish() { if(this.lineBuffer.startsWith('data:')) this.dataLines.push(this.lineBuffer.slice(5).trimStart());this.lineBuffer='';this.flush(); }
  flush() {
    if (!this.dataLines.length) return;
    const raw=this.dataLines.join('\n');this.dataLines=[];
    if (raw==='[DONE]') {this.complete=true;return;}
    try{this.handleEvent(JSON.parse(raw));this.events++;}catch{this.parseFailures++;}
  }
  handleEvent(event) {
    if (!event || typeof event!=='object') return;
    if (event.type==='message_stream_complete' || event.type==='response.completed') {
      this.complete=true;
      if (typeof event.conversation_id==='string') this.conversationId=event.conversation_id;
      return;
    }
    if (typeof event.conversation_id === 'string') this.conversationId=event.conversation_id;
    if (event.message && typeof event.message==='object') {this.setMessage(event.message);return;}
    if (event.v && typeof event.v==='object' && !Array.isArray(event.v) && event.v.message) {this.setMessage(event.v.message);return;}
    if (Array.isArray(event.v)) {for(const patch of event.v)this.handlePatch(patch);return;}
    if (event.o==='patch' && Array.isArray(event.patch)) {for(const patch of event.patch)this.handlePatch(patch);return;}
    if (typeof event.v==='string' && (event.o==='append'||event.o===undefined) &&
        (event.p===undefined || /^\/message\/content\/parts\/\d+$/.test(event.p))) {
      if(this.tracking)this.append(event.v);
    }
  }
  handlePatch(p) {
    if(!p||typeof p!=='object')return;
    if(p.o==='append' && /^\/message\/content\/parts\/\d+$/.test(p.p||'') && typeof p.v==='string') {
      if(this.tracking)this.append(p.v);
    } else if(this.tracking && (p.p==='/message/status' && p.v==='finished_successfully' || p.p==='/message/end_turn' && p.v===true)) {
      this.complete=true;
    }
  }
  append(value) {this.text=(this.text+value).slice(0,MAX_ANSWER_CHARS);}
  setMessage(message) {
    this.tracking=isFinal(message);
    if(!this.tracking)return;
    const text=messageText(message);
    if(text && text.length>=this.text.length) this.text=text.slice(0,MAX_ANSWER_CHARS);
    if(message.status==='finished_successfully'||message.end_turn===true||message.metadata?.is_complete===true)this.complete=true;
  }
}

/** Injected in page MAIN world. Never makes requests or alters original response. */
export function installChatGptFetchTee() {
  if (window.__uaiFetchTeeInstalled) return;
  window.__uaiFetchTeeInstalled=true;
  const original=window.fetch;
  window.fetch = function (...args) {
    const result=Reflect.apply(original,this,args);
    try {
      const value=args[0];
      const target=typeof value==='string'?value: value?.url;
      const method=String(args[1]?.method||value?.method||'GET').toUpperCase();
      const targetUrl=new URL(target,location.href);
      if(targetUrl.origin!=='https://chatgpt.com' || method!=='POST' || !/^\/backend-api\/(?:f\/)?conversation\/?$/.test(targetUrl.pathname))return result;
      const streamId=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
      result.then(async response=>{
        if(!response.ok||!response.body||!String(response.headers.get('content-type')||'').includes('text/event-stream'))return;
        try {
          const reader=response.clone().body.getReader();
          const decoder=new TextDecoder();
          let forwarded=0;
          while (true) {
            const {done,value}=await reader.read();
            if(done)break;
            forwarded+=value.byteLength;
            if(forwarded>2_000_000){reader.cancel().catch(()=>{});break;}
            const chunk=decoder.decode(value,{stream:true});
            if(typeof window.__uaiGptPassiveChunk==='function')await window.__uaiGptPassiveChunk(streamId,chunk);
          }
          const final=decoder.decode();
          if(final && typeof window.__uaiGptPassiveChunk==='function')await window.__uaiGptPassiveChunk(streamId,final);
        }catch{/* Observation must never break ChatGPT UI. */}
      }).catch(()=>{});
    }catch{/* Ignore nonmatching application requests. */}
    return result;
  };
}

export class GptNetworkCapture {
  constructor(page) {this.page=page;this.parser=new GptSseParser();this.armed=false;this.streamId=null;this.activatedAt=0;this.report={teeInstalled:false,networkPosts:0,completedBodies:0,capturedChunks:0};this.generation=randomUUID();this.turnGeneration=0;this.staleStreamIds=new Set();}
  async install() {
    this.page.on('response', response=>this.#onResponse(response));
    await this.page.exposeFunction(CAPTURE_HOOK,(id,chunk)=>this.#onChunk(id,chunk));
    await this.page.addInitScript(installChatGptFetchTee);
    this.page.on('load',()=>this.prime().catch(()=>{}));
  }
  async prime() {
    if(this.page.isClosed())return;
    try {
      // Patchright bindings may need a MAIN-world touch before becoming visible.
      await this.page.evaluate(()=>true,undefined,false).catch(()=>{});
      await this.page.evaluate(installChatGptFetchTee,undefined,false);
      this.report.teeInstalled=await this.page.evaluate(()=>Boolean(window.__uaiFetchTeeInstalled),undefined,false).catch(()=>false);
    }catch{/* passive response listener can still capture completed SSE */}
  }
  arm() {this.turnGeneration++;this.parser=new GptSseParser();this.armed=true;this.streamId=null;this.activatedAt=Date.now();this.report.networkPosts=0;this.report.completedBodies=0;this.report.capturedChunks=0;}
  disarm() {
    if(this.streamId){this.staleStreamIds.add(this.streamId);if(this.staleStreamIds.size>128)this.staleStreamIds.clear();}
    this.armed=false;
  }
  snapshot() {return {...this.parser.snapshot(),...this.report};}
  #onChunk(id,chunk) {
    if(!this.armed || !id || typeof chunk!=='string'||this.staleStreamIds.has(id))return;
    if(!this.streamId)this.streamId=id;
    if(this.streamId!==id)return;
    this.parser.feed(chunk);this.report.capturedChunks++;
  }
  async #onResponse(response) {
    if(!this.armed)return;
    const expectedGeneration=this.turnGeneration;
    let isTarget=false;
    try {isTarget=isChatGptAnswerEndpoint(response.url(),response.request().method());}catch{}
    if(!isTarget)return;
    this.report.networkPosts++;
    // Once the browser finishes an SSE response, recover it even if the injected
    // MAIN-world tee was unavailable. Do not overwrite a stronger live capture.
    if(this.parser.complete && this.parser.text)return;
    try {
      const type=response.headers()['content-type']||'';
      if(!type.includes('text/event-stream'))return;
      const length=Number(response.headers()['content-length']||0);
      if(length>MAX_BUFFER_CHARS)return;
      const body=await response.text();
      if(!this.armed || this.turnGeneration!==expectedGeneration || body.length>MAX_BUFFER_CHARS)return;
      const parsed=new GptSseParser();parsed.feed(body);parsed.finish();
      const snap=parsed.snapshot();const existing=this.parser.snapshot();
      if (snap.text && (snap.complete || !existing.text) && snap.text.length>=existing.text.length) this.parser=parsed;
      this.report.completedBodies++;
    }catch{/* Network response might be streaming forever or be unreadable. */}
  }
}
