import {GatewayError} from './errors.mjs';

// Per-provider FIFO admission control: no implicit retries after a browser send.
export class ProviderQueue {
 constructor({providers=['gpt','gemini','claude'],limit=4,waitMs=90000}={}){
  this.limit=limit;this.waitMs=waitMs;this.slots=new Map(providers.map(p=>[p,{active:false,abandonedActive:false,abandoned:0,pending:[],started:0,completed:0,rejected:0,waits:[]}]));
 }
 snapshot(){return Object.fromEntries([...this.slots].map(([name,s])=>[name,{active:s.active,abandoned_active:s.abandonedActive,abandoned:s.abandoned,pending:s.pending.length,started:s.started,completed:s.completed,rejected:s.rejected,average_wait_ms:s.waits.length?Math.round(s.waits.reduce((a,b)=>a+b,0)/s.waits.length):0}]));}
 run(provider,job,{signal}={}){
  const slot=this.slots.get(provider);
  if(!slot)return Promise.reject(new GatewayError(400,'invalid_provider','Unknown provider'));
  if(signal?.aborted)return Promise.reject(new GatewayError(499,'request_cancelled','Client disconnected before dispatch'));
  if(slot.pending.length>=this.limit){slot.rejected++;return Promise.reject(new GatewayError(429,'provider_queue_full','Provider queue is full; retry later'));}
  return new Promise((resolve,reject)=>{
   const task={job,resolve,reject,signal,queuedAt:performance.now(),timer:null,onAbort:null,done:false};
   const remove=()=>{
    if(task.timer)clearTimeout(task.timer);
    if(signal&&task.onAbort)signal.removeEventListener('abort',task.onAbort);
   };
   task.cancel=(error)=>{
    if(task.done)return;
    task.done=true;remove();
    const ix=slot.pending.indexOf(task);if(ix>=0)slot.pending.splice(ix,1);
    slot.rejected++;reject(error);
   };
   task.onAbort=()=>task.cancel(new GatewayError(499,'request_cancelled','Client disconnected while queued'));
   if(signal)signal.addEventListener('abort',task.onAbort,{once:true});
   task.timer=setTimeout(()=>task.cancel(new GatewayError(503,'queue_wait_timeout','Provider queue wait exceeded limit')),this.waitMs);
   slot.pending.push(task);
   this.#drain(slot);
  });
 }
 #drain(slot){
  if(slot.active)return;
  while(slot.pending.length){
   const task=slot.pending.shift();
   if(task.done)continue;
   if(task.signal?.aborted){task.cancel(new GatewayError(499,'request_cancelled','Client disconnected before dispatch'));continue;}
   task.done=true;
   if(task.timer)clearTimeout(task.timer);
   // Once dispatched, never cancel the browser request on a client disconnect:
   // the provider may have accepted the prompt. Hold the slot until settled.
   slot.active=true;slot.started++;slot.abandonedActive=false;
   let abandoned=false;
   const onActiveAbort=()=>{
    if(abandoned)return;
    abandoned=true;slot.abandoned++;slot.abandonedActive=true;
    console.warn('[ORBIT-QUEUE]',JSON.stringify({phase:'client_disconnected_after_dispatch'}));
   };
   if(task.signal){
    task.signal.removeEventListener('abort',task.onAbort);
    task.signal.addEventListener('abort',onActiveAbort,{once:true});
    if(task.signal.aborted)onActiveAbort();
   }
   const wait=Math.round(performance.now()-task.queuedAt);
   slot.waits.push(wait);if(slot.waits.length>100)slot.waits.shift();
   console.info('[ORBIT-QUEUE]',JSON.stringify({phase:'start',wait_ms:wait,pending:slot.pending.length}));
   Promise.resolve().then(task.job).then(task.resolve,task.reject).finally(()=>{
    if(task.signal)task.signal.removeEventListener('abort',onActiveAbort);
    slot.active=false;slot.abandonedActive=false;slot.completed++;this.#drain(slot);
   });
   return;
  }
 }
}
