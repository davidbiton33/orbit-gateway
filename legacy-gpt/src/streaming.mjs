import { randomUUID } from 'node:crypto';

export function commonPrefixLength(a, b) {
  let i=0;
  const n=Math.min(a.length,b.length);
  while (i<n && a.charCodeAt(i)===b.charCodeAt(i)) i++;
  // Never split UTF-16 surrogate pairs while streaming Unicode/emoji.
  if (i>0 && i<a.length && /[\uD800-\uDBFF]/.test(a[i-1])) i--;
  return i;
}

export function streamHeaders(res) {
  res.writeHead(200, {
    'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-store, no-transform',
    Connection:'keep-alive',
    'X-Content-Type-Options':'nosniff',
    'X-Accel-Buffering':'no',
  });
  res.flushHeaders?.();
}

export function sseEvent(event, data) {
  return `${event ? `event: ${event}\n` : ''}data: ${typeof data==='string'?data:JSON.stringify(data)}\n\n`;
}

/**
 * Gemini has no supported token stream in our adapter. The DOM can rewrite
 * earlier text (especially markdown/code blocks). Snapshot mode is lossless
 * for our UI; delta mode is best-effort OpenAI-compatible streaming.
 */
export class GeminiSseWriter {
  constructor(res,{model='gemini-web-chat',mode='deltas',id=`chatcmpl-${randomUUID()}`,created=Math.floor(Date.now()/1000),heartbeatMs=15000}={}) {
    if (!['deltas','snapshots'].includes(mode)) throw new Error('Invalid stream mode');
    this.res=res;this.mode=mode;this.model=model;this.id=id;this.created=created;
    this.observed='';this.emitted='';this.closed=false;this.revised=false;this.lastSnapshot='';
    streamHeaders(res);
    this.sendChunk({role:'assistant',content:''});
    this.heartbeat=setInterval(()=>this.raw(': heartbeat\n\n'),heartbeatMs);
    this.heartbeat.unref?.();
    res.once('close',()=>{this.closed=true;this.stopHeartbeat();});
  }
  stopHeartbeat(){if(this.heartbeat){clearInterval(this.heartbeat);this.heartbeat=null;}}
  raw(data){if(!this.closed && !this.res.destroyed && !this.res.writableEnded) this.res.write(data);}
  event(name,data){this.raw(sseEvent(name,data));}
  sendChunk(delta,extra={}) {
    this.event(null,{id:this.id,object:'chat.completion.chunk',created:this.created,model:this.model,
      choices:[{index:0,delta,finish_reason:null}],...extra});
  }
  status(phase){this.event('gateway.status',{phase});}
  snapshot(text) {
    if(typeof text!=='string' || text===this.observed) return;
    if(this.mode==='snapshots') {
      this.event('gateway.snapshot',{text,revision:text.length<this.observed.length||!text.startsWith(this.observed)});
    } else {
      // Confirm a stable common prefix between successive DOM readings.
      let safe=commonPrefixLength(this.observed,text);
      safe=Math.max(0,safe-12); // hold a small tail to absorb HTML/Markdown layout churn
      if(safe>0 && text.startsWith(this.emitted) && safe>this.emitted.length) {
        this.sendChunk({content:text.slice(this.emitted.length,safe)});
        this.emitted=text.slice(0,safe);
      }
      if(this.emitted && !text.startsWith(this.emitted)) this.revised=true;
    }
    this.observed=text;
  }
  finish({text='',conversationId=null,images=[]}={}){
    if(this.closed)return;
    if(this.mode==='snapshots'){
      if(text!==this.observed) this.event('gateway.snapshot',{text,revision:true});
    } else if(text.startsWith(this.emitted)) {
      if(text.length>this.emitted.length)this.sendChunk({content:text.slice(this.emitted.length)});
      this.emitted=text;
    } else {
      // An OpenAI delta stream cannot retract previously emitted characters.
      // Signal the corrected final text for capable consumers; do not pretend
      // the append-only stream was exact.
      this.revised=true;
      this.event('gateway.reconcile',{text,reason:'upstream_dom_rewrote_previous_text'});
    }
    if(images.length) this.event('gateway.images',{images:images.map(({bytes,mime})=>({mime_type:mime,b64_json:bytes.toString('base64')}))});
    this.event('gateway.final',{text,conversation_id:conversationId,source:'gemini-dom',reconciled:this.revised});
    this.event(null,{id:this.id,object:'chat.completion.chunk',created:this.created,model:this.model,
      choices:[{index:0,delta:{},finish_reason:'stop'}],conversation_id:conversationId});
    this.raw(sseEvent(null,'[DONE]'));
    this.end();
  }
  error(err){
    if(this.closed)return;
    this.event('gateway.error',{error:{code:err?.code||'stream_error',message:err?.message||'Streaming failed'}});
    this.event(null,{error:{code:err?.code||'stream_error',message:err?.message||'Streaming failed'}});
    this.raw(sseEvent(null,'[DONE]'));
    this.end();
  }
  end(){this.stopHeartbeat();if(!this.closed){this.closed=true;this.res.end();}}
}
