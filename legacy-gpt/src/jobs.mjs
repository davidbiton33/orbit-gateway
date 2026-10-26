import { randomUUID, createHmac, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { GatewayError } from './security.mjs';

const TERMINAL = new Set(['completed','failed','cancelled','interrupted']);
const ID_RE = /^[a-f0-9-]{36}$/;
const KEYS = /^[A-Za-z0-9._:-]{8,128}$/;
const PRIORITIES = Object.freeze({low:0,normal:1,high:2,urgent:3});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const asJson = x => JSON.stringify(x ?? null);
const parseJson = s => { try {return JSON.parse(s);}catch {return null;} };

export function validateIdempotencyKey(value) {
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||!KEYS.test(value)) throw new GatewayError(400,'invalid_idempotency_key','Idempotency-Key must be 8-128 letters, numbers, dots, dashes, underscores or colons');
  return value;
}
export function validatePriority(value='normal') {
  if(typeof value!=='string'||!Object.hasOwn(PRIORITIES,value))throw new GatewayError(400,'invalid_priority','priority must be low, normal, high or urgent');
  return value;
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function fingerprint(value) {return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
export function validateWebhookConfig({url='',host='',secret=''}={}) {
  if(!url)return null;
  let u;try{u=new URL(url);}catch{throw new Error('Webhook URL invalid');}
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port||u.hostname!==host.toLowerCase()||!host||net.isIP(u.hostname)||
     u.hostname==='localhost'||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal')||typeof secret!=='string'||secret.length<32)
     throw new Error('Webhook requires HTTPS, matching hostname and 32+ character secret');
  return {url:u.toString(),host:u.hostname,secret};
}
export async function deliverWebhook(webhook,metadata,{fetchImpl=fetch,retries=3}={}) {
  if(!webhook)return false;
  const payload=JSON.stringify({event:`job.${metadata.status}`,job_id:metadata.id,provider:metadata.provider,type:metadata.type,status:metadata.status,finished_at:metadata.finished_at});
  const sig='sha256='+createHmac('sha256',webhook.secret).update(payload).digest('hex');
  for(let i=0;i<retries;i++){
    try{
      const r=await fetchImpl(webhook.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
        headers:{'Content-Type':'application/json','X-AI-Gateway-Signature':sig,'X-AI-Gateway-Event-ID':metadata.id},body:payload});
      await r.body?.cancel?.().catch(()=>{});if(r.ok)return true;
    }catch{}
    if(i<retries-1)await sleep(250*(2**i));
  }
  return false;
}

function safeMeta(job) {
  return {id:job.id,type:job.type,provider:job.provider,status:job.status,priority:job.priority,
    created_at:job.created_at,updated_at:job.updated_at,finished_at:job.finished_at,
    last_event_id:job.seq,earliest_event_id:job.events[0]?.id??job.seq+1,
    last_text:job.last_text,has_result:job.has_result,error:job.error,
    cancel_requested:job.cancel_requested,attempts:job.attempts,retries:Math.max(0,job.attempts-1),
    not_before:job.not_before||null,comparison_id:job.comparison_id||null};
}
function diskRow(job){return {
 id:job.id,type:job.type,provider:job.provider,status:job.status,priority:job.priority,created_at:job.created_at,
 updated_at:job.updated_at,finished_at:job.finished_at,seq:job.seq,last_text:job.last_text,
 has_result:job.has_result?1:0,error_json:job.error?asJson(job.error):null,cancel_requested:job.cancel_requested?1:0,
 attempts:job.attempts,not_before:job.not_before||0,idempotency_key:job.idempotency_key||null,
 request_hash:job.request_hash||null,comparison_id:job.comparison_id||null,
};}
function fromDisk(r,events=[]) {return {...r,events,has_result:Boolean(r.has_result),cancel_requested:Boolean(r.cancel_requested),
 error:r.error_json?parseJson(r.error_json):null,lastProgressAt:0,writes:Promise.resolve()};}

export class JobManager {
 constructor({dir,runner,maxActive=6,maxConcurrent=2,maxStored=100,ttlMs=24*3600000,maxResultBytes=128*1024*1024,
   maxEvents=240,providerLimits={gemini:1,gpt:2},retryLimit=2,retryBaseMs=1000,agingMs=60000,
   webhook=null,fetchImpl=fetch,clock=()=>Date.now()}={}) {
   if(!dir||typeof runner!=='function')throw Error('JobManager needs directory and runner');
   this.dir=dir;this.runner=runner;this.maxActive=maxActive;this.maxConcurrent=maxConcurrent;this.maxStored=maxStored;
   this.ttlMs=ttlMs;this.maxResultBytes=maxResultBytes;this.maxEvents=maxEvents;this.webhook=webhook;this.fetchImpl=fetchImpl;this.clock=clock;
   this.providerLimits={gemini:1,gpt:2,...providerLimits};this.retryLimit=retryLimit;this.retryBaseMs=retryBaseMs;this.agingMs=agingMs;
   this.jobs=new Map();this.pending=[];this.running=0;this.runningByProvider={gemini:0,gpt:0};
   this.paused={all:false,gemini:false,gpt:false};this.events=new EventEmitter();this.events.setMaxListeners(500);
   this.db=null;this.timer=null;
 }
 #resultPath(id){return path.join(this.dir,`${id}.result.json`);}
 #writeAtomic(file,bytes){const temp=file+`.${randomUUID()}.tmp`;return fs.writeFile(temp,bytes,{mode:0o600,flag:'wx'})
   .then(()=>fs.rename(temp,file)).finally(()=>fs.rm(temp,{force:true}).catch(()=>{}));}
 #runTransaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 #saveJob(job){const r=diskRow(job);this.stmtSave.run(r.id,r.type,r.provider,r.status,r.priority,r.created_at,r.updated_at,r.finished_at,r.seq,r.last_text,r.has_result,r.error_json,r.cancel_requested,r.attempts,r.not_before,r.idempotency_key,r.request_hash,r.comparison_id);}
 #entry(job,event,data={}){const at=this.clock();return {id:++job.seq,event:`job.${event}`,data:{job_id:job.id,...data},at};}
 #push(job,event,data={}) {
   if(TERMINAL.has(job.status) && !TERMINAL.has(event) && event!=='snapshot')return;
   const entry=this.#entry(job,event,data);job.events.push(entry);
   if(job.events.length>this.maxEvents)job.events.splice(0,job.events.length-this.maxEvents);
   job.updated_at=this.clock();
   this.#runTransaction(()=>{this.#saveJob(job);this.stmtEvent.run(job.id,entry.id,entry.event,asJson(entry.data),entry.at);
     this.stmtTrim.run(job.id,Math.max(0,job.seq-this.maxEvents));});
   this.events.emit(job.id,entry);
 }
 #emptyJob({type,provider,priority='normal',idempotencyKey=null,requestHash=null,comparisonId=null}){
   const now=this.clock();return {id:randomUUID(),type,provider,priority,status:'queued',created_at:now,updated_at:now,finished_at:null,
     seq:0,events:[],last_text:'',has_result:false,error:null,cancel_requested:false,attempts:0,not_before:0,
     idempotency_key:idempotencyKey,request_hash:requestHash,comparison_id:comparisonId,lastProgressAt:0,writes:Promise.resolve()};
 }
 async init(){
   await fs.mkdir(this.dir,{recursive:true,mode:0o700});
   const dbPath=path.join(this.dir,'gateway.sqlite');this.db=new DatabaseSync(dbPath);try{fsSync.chmodSync(dbPath,0o600);}catch{}
   this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
     CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'normal',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER,seq INTEGER NOT NULL DEFAULT 0,last_text TEXT NOT NULL DEFAULT '',has_result INTEGER NOT NULL DEFAULT 0,error_json TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,not_before INTEGER NOT NULL DEFAULT 0,idempotency_key TEXT UNIQUE,request_hash TEXT,comparison_id TEXT);
     CREATE TABLE IF NOT EXISTS job_events(job_id TEXT NOT NULL,id INTEGER NOT NULL,event TEXT NOT NULL,data_json TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(job_id,id),FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE);
     CREATE TABLE IF NOT EXISTS comparisons(id TEXT PRIMARY KEY,gemini_job_id TEXT NOT NULL,gpt_job_id TEXT NOT NULL,created_at INTEGER NOT NULL,idempotency_key TEXT UNIQUE,request_hash TEXT);
     CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at DESC);
     CREATE INDEX IF NOT EXISTS jobs_status_provider_idx ON jobs(status,provider,priority);
     CREATE INDEX IF NOT EXISTS jobs_comparison_idx ON jobs(comparison_id);`);
   this.stmtSave=this.db.prepare(`INSERT INTO jobs(id,type,provider,status,priority,created_at,updated_at,finished_at,seq,last_text,has_result,error_json,cancel_requested,attempts,not_before,idempotency_key,request_hash,comparison_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
     status=excluded.status,priority=excluded.priority,updated_at=excluded.updated_at,finished_at=excluded.finished_at,seq=excluded.seq,
     last_text=excluded.last_text,has_result=excluded.has_result,error_json=excluded.error_json,
     cancel_requested=excluded.cancel_requested,attempts=excluded.attempts,not_before=excluded.not_before`);
   this.stmtEvent=this.db.prepare('INSERT INTO job_events(job_id,id,event,data_json,at) VALUES(?,?,?,?,?)');
   this.stmtTrim=this.db.prepare('DELETE FROM job_events WHERE job_id=? AND id<=?');
   await this.#migrateLegacy();
   for(const r of this.db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all()){
     const entries=this.db.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY id').all(r.id)
       .map(e=>({id:e.id,event:e.event,data:parseJson(e.data_json),at:e.at}));
     const job=fromDisk(r,entries);this.jobs.set(job.id,job);
     if(!TERMINAL.has(job.status)) {job.status='interrupted';job.finished_at=this.clock();job.error={code:'server_restarted',message:'Gateway restarted before job completion; submit a new request. It was not auto-retried.'};this.#push(job,'interrupted',{status:'interrupted',error:job.error});}
   }
   for(const r of this.db.prepare('SELECT key,value FROM settings').all())if(r.key.startsWith('pause:'))this.paused[r.key.slice(6)]=r.value==='1';
   await this.prune();
 }
 async #migrateLegacy(){
   const names=(await fs.readdir(this.dir)).filter(n=>n.endsWith('.json')&&!n.endsWith('.result.json')&&ID_RE.test(n.slice(0,-5)));
   for(const filename of names){
     let job;try{job=JSON.parse(await fs.readFile(path.join(this.dir,filename),'utf8'));}catch{continue;}
     if(job.id+'.json'!==filename||!Array.isArray(job.events)||!['queued','running','completed','failed','interrupted','cancelled'].includes(job.status))continue;
     if(!['chat','image_generation','image_edit'].includes(job.type)||!['gemini','gpt'].includes(job.provider))continue;
     const normalized={...this.#emptyJob({type:job.type,provider:job.provider}),...job,priority:'normal',idempotency_key:null,request_hash:null,comparison_id:null,attempts:0,not_before:0,seq:Number(job.seq)||0};
     try{if(this.db.prepare('SELECT id FROM jobs WHERE id=?').get(normalized.id)){await fs.rm(path.join(this.dir,filename),{force:true});continue;}
       this.#runTransaction(()=>{this.#saveJob(normalized);for(const e of normalized.events.slice(-this.maxEvents)){
         if(Number.isInteger(e.id)&&e.id>=1&&typeof e.event==='string')this.db.prepare('INSERT OR IGNORE INTO job_events VALUES(?,?,?,?,?)').run(normalized.id,e.id,e.event,asJson(e.data||{}),Number(e.at)||this.clock());
       }});
       // Remove old metadata only AFTER sqlite commit. Results stay under their original names.
       await fs.rm(path.join(this.dir,filename),{force:true});
     }catch{/* Existing DB record wins; never overwrite or execute a legacy file. */}
   }
 }
 async prune(){
   const now=this.clock();const jobs=[...this.jobs.values()].sort((a,b)=>a.created_at-b.created_at);
   for(const job of jobs){if(!TERMINAL.has(job.status))continue;
     if(now-job.updated_at<this.ttlMs&&this.jobs.size<=this.maxStored)continue;
     this.jobs.delete(job.id);this.#runTransaction(()=>this.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id));
     await fs.rm(this.#resultPath(job.id),{force:true}).catch(()=>{});
   }
   // Remove comparison headers only after BOTH children expire.
   this.db.exec('DELETE FROM comparisons WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE id=comparisons.gemini_job_id OR id=comparisons.gpt_job_id)');
 }
 get(id){if(!ID_RE.test(id))throw new GatewayError(400,'invalid_job_id','Invalid job ID');const job=this.jobs.get(id);if(!job)throw new GatewayError(404,'job_not_found','Job not found or expired');return job;}
 getMeta(id){return safeMeta(this.get(id));}
 list(){return [...this.jobs.values()].sort((a,b)=>b.created_at-a.created_at).slice(0,50).map(safeMeta);}
 activeCount(){return [...this.jobs.values()].filter(j=>!TERMINAL.has(j.status)).length;}
 queueStatus(){return {paused:{...this.paused},running:this.running,running_by_provider:{...this.runningByProvider},limits:{total:this.maxConcurrent,...this.providerLimits},queued:this.pending.length,
   queued_by_priority:Object.fromEntries(Object.keys(PRIORITIES).map(p=>[p,this.pending.filter(e=>e.job.priority===p&&e.job.status==='queued').length]))};}
 pause(provider='all'){return this.#setPause(provider,true);}
 resume(provider='all'){return this.#setPause(provider,false);}
 #setPause(provider,value){if(!Object.hasOwn(this.paused,provider))throw new GatewayError(400,'invalid_provider','Queue provider must be all, gemini or gpt');
   this.paused[provider]=value;this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`pause:${provider}`,value?'1':'0');
   if(!value)this.#pump();return this.queueStatus();}
 async create({type,provider,request,priority='normal',idempotencyKey=null}){
   await this.prune();validatePriority(priority);const key=validateIdempotencyKey(idempotencyKey);
   const hash=key?fingerprint({type,provider,request,priority}):null;
   if(key){const existing=this.db.prepare('SELECT id,request_hash FROM jobs WHERE idempotency_key=?').get(key);
     if(existing){if(existing.request_hash!==hash)throw new GatewayError(409,'idempotency_conflict','This Idempotency-Key belongs to a different request');return {...this.getMeta(existing.id),reused:true};}}
   if(this.activeCount()>=this.maxActive)throw new GatewayError(429,'job_queue_full','Too many active jobs');
   if(this.jobs.size>=this.maxStored)throw new GatewayError(507,'job_storage_full','Job history full');
   const job=this.#emptyJob({type,provider,priority,idempotencyKey:key,requestHash:hash});
   this.#runTransaction(()=>{this.#saveJob(job);const e=this.#entry(job,'status',{status:'queued'});
     this.#saveJob(job);this.stmtEvent.run(job.id,e.id,e.event,asJson(e.data),e.at);job.events.push(e);});
   this.jobs.set(job.id,job);this.pending.push({job,request});setImmediate(()=>this.#pump());return safeMeta(job);
 }
 async createComparison({gemini,gpt,priority='normal',idempotencyKey=null}){
   await this.prune();validatePriority(priority);const key=validateIdempotencyKey(idempotencyKey);
   const hash=key?fingerprint({gemini,gpt,priority}):null;
   if(key){const existing=this.db.prepare('SELECT * FROM comparisons WHERE idempotency_key=?').get(key);
     if(existing){if(existing.request_hash!==hash)throw new GatewayError(409,'idempotency_conflict','Comparison key belongs to another request');return {...this.comparison(existing.id),reused:true};}}
   if(this.activeCount()+2>this.maxActive)throw new GatewayError(429,'job_queue_full','Not enough slots for a two-provider comparison');
   if(this.jobs.size+2>this.maxStored)throw new GatewayError(507,'job_storage_full','Not enough storage for comparison');
   const id=randomUUID(),gJob=this.#emptyJob({type:'chat',provider:'gemini',priority,comparisonId:id}),pJob=this.#emptyJob({type:'chat',provider:'gpt',priority,comparisonId:id});
   this.#runTransaction(()=>{
     this.db.prepare('INSERT INTO comparisons VALUES (?,?,?,?,?,?)').run(id,gJob.id,pJob.id,this.clock(),key,hash);
     for(const job of [gJob,pJob]){const e=this.#entry(job,'status',{status:'queued'});job.events.push(e);this.#saveJob(job);this.stmtEvent.run(job.id,e.id,e.event,asJson(e.data),e.at);}
   });
   this.jobs.set(gJob.id,gJob);this.jobs.set(pJob.id,pJob);
   this.pending.push({job:gJob,request:gemini.request},{job:pJob,request:gpt.request});setImmediate(()=>this.#pump());return this.comparison(id);
 }
 listComparisons(){return this.db.prepare('SELECT id FROM comparisons ORDER BY created_at DESC LIMIT 30').all().map(r=>this.comparison(r.id));}
 comparison(id){if(!ID_RE.test(id))throw new GatewayError(400,'invalid_comparison_id','Invalid comparison ID');const row=this.db.prepare('SELECT * FROM comparisons WHERE id=?').get(id);
   if(!row)throw new GatewayError(404,'comparison_not_found','Comparison not found or expired');
   return {id,created_at:row.created_at,jobs:{gemini:this.jobs.has(row.gemini_job_id)?this.getMeta(row.gemini_job_id):null,
      gpt:this.jobs.has(row.gpt_job_id)?this.getMeta(row.gpt_job_id):null}};
 }
 #selectNext(){if(this.paused.all)return null;const now=this.clock();let winner=null,best=-Infinity;
   for(const entry of this.pending){const j=entry.job;if(j.status!=='queued'||j.not_before>now||this.paused[j.provider]||this.runningByProvider[j.provider]>=this.providerLimits[j.provider])continue;
     const score=PRIORITIES[j.priority]+Math.min(5,Math.floor(Math.max(0,now-j.created_at)/this.agingMs));
     if(score>best||(score===best&&winner&&j.created_at<winner.job.created_at)){winner=entry;best=score;}}
   return winner;
 }
 #scheduleRetryTimer(){if(this.timer){clearTimeout(this.timer);this.timer=null;}
   const earliest=Math.min(...this.pending.filter(e=>e.job.status==='queued'&&e.job.not_before>this.clock()).map(e=>e.job.not_before));
   if(Number.isFinite(earliest)){this.timer=setTimeout(()=>{this.timer=null;this.#pump();},Math.max(1,earliest-this.clock()));this.timer.unref?.();}}
 #pump(){while(this.running<this.maxConcurrent){const next=this.#selectNext();if(!next)break;
   this.pending.splice(this.pending.indexOf(next),1);this.running++;this.runningByProvider[next.job.provider]++;
   void this.#execute(next.job,next.request).catch(()=>{}).finally(()=>{this.running--;this.runningByProvider[next.job.provider]--;this.#pump();});
   }this.#scheduleRetryTimer();}
 async #execute(job,request){if(job.status!=='queued')return;job.status='running';job.attempts++;job.not_before=0;this.#push(job,'status',{status:'running',attempt:job.attempts});
   const report=text=>{if(typeof text!=='string'||text===job.last_text)return;const now=this.clock();const revision=!text.startsWith(job.last_text);
     job.last_text=text.slice(0,200000);if(now-job.lastProgressAt<500&&!revision)return;job.lastProgressAt=now;this.#push(job,'snapshot',{text:job.last_text,revision});};
   try{
     const result=await this.runner({type:job.type,provider:job.provider,request,report,jobId:job.id,attempt:job.attempts});
     if(job.cancel_requested){job.status='cancelled';job.finished_at=this.clock();this.#push(job,'cancelled',{status:'cancelled'});}
     else {const bytes=Buffer.from(JSON.stringify(result),'utf8');if(bytes.length>this.maxResultBytes)throw new GatewayError(413,'job_result_too_large','Job result exceeded maximum size');
       await this.#writeAtomic(this.#resultPath(job.id),bytes);job.has_result=true;job.status='completed';job.finished_at=this.clock();
       const text=typeof result?.choices?.[0]?.message?.content==='string'?result.choices[0].message.content:null;
       if(text!==null&&text!==job.last_text){job.last_text=text.slice(0,200000);this.#push(job,'snapshot',{text:job.last_text,revision:true});}
       this.#push(job,'completed',{status:'completed',has_result:true});}
   }catch(err){
     const safe=err?.safeToRetry===true;
     if(safe&&!job.cancel_requested&&job.attempts<=this.retryLimit){
       job.status='queued';job.not_before=this.clock()+Math.min(60000,this.retryBaseMs*(2**(job.attempts-1)));
       this.#push(job,'retry',{status:'queued',next_attempt:job.attempts+1,not_before:job.not_before,reason:'safe_pre_dispatch_failure'});
       this.#push(job,'status',{status:'queued',retry:true});
       this.pending.push({job,request});this.#pump();return;
     }
     job.status=job.cancel_requested?'cancelled':'failed';job.finished_at=this.clock();
     job.error=job.cancel_requested?null:{code:typeof err?.code==='string'?err.code.slice(0,80):'job_failed',
       message:'Provider operation failed. An ambiguous post-dispatch error will not be retried automatically.',safe_to_retry:safe};
     this.#push(job,job.status,{status:job.status,...(job.error?{error:job.error}:{})});
   }
   if(this.webhook)void deliverWebhook(this.webhook,safeMeta(job),{fetchImpl:this.fetchImpl});
 }
 cancel(id){const job=this.get(id);if(TERMINAL.has(job.status))return safeMeta(job);
   if(job.status==='queued'){job.status='cancelled';job.finished_at=this.clock();this.pending=this.pending.filter(e=>e.job.id!==id);this.#push(job,'cancelled',{status:'cancelled'});
     if(this.webhook)void deliverWebhook(this.webhook,safeMeta(job),{fetchImpl:this.fetchImpl});}
   else {job.cancel_requested=true;this.#push(job,'status',{status:'running',cancel_requested:true});}
   return safeMeta(job);}
 async result(id){const j=this.get(id);if(j.status!=='completed')throw new GatewayError(409,'job_not_completed',`Job status: ${j.status}`);
   if(!j.has_result)throw new GatewayError(404,'job_result_missing','Result not available');
   try{return JSON.parse(await fs.readFile(this.#resultPath(id),'utf8'));}catch{throw new GatewayError(500,'job_result_corrupt','Persisted result unavailable');}}
 subscribe(id,fn){this.get(id);this.events.on(id,fn);return()=>this.events.off(id,fn);}
 replay(id,after=0){const j=this.get(id);if(!Number.isSafeInteger(after)||after<0)throw new GatewayError(400,'invalid_cursor','Invalid event cursor');
   const first=j.events[0]?.id||j.seq+1;
   return {reset:after<first-1?{id:j.id,status:j.status,text:j.last_text,last_event_id:j.seq}:null,events:j.events.filter(e=>e.id>after),terminal:TERMINAL.has(j.status)};}
 close(){if(this.timer)clearTimeout(this.timer);this.db?.close();this.db=null;}
}
