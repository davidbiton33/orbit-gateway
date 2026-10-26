// Local usage accounting. Counts Orbit activity, not Google's account-wide usage.
// Per-day guardrails are opt-in and cannot increase Google's actual quota.
import {fail} from './errors.mjs';
const DAY=86400000;
const safeLimit=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Math.min(100000,Number(n)):null;
export class UsageLedger{
 constructor(env=process.env,clock=()=>Date.now()){
  this.clock=clock;this.events=[];this.blocked=new Map();
  this.caps={gemini:{image:safeLimit(env.ORBIT_GEMINI_IMAGE_DAILY_CAP),chat:safeLimit(env.ORBIT_GEMINI_CHAT_DAILY_CAP)},aimode:{image:safeLimit(env.ORBIT_AIMODE_IMAGE_DAILY_CAP),chat:safeLimit(env.ORBIT_AIMODE_CHAT_DAILY_CAP)}};
 }
 restore(saved){
  if(!saved||!Array.isArray(saved.events))return;
  const now=this.clock();
  this.events=saved.events.filter(e=>e&&['gemini','aimode'].includes(e.provider)&&['chat','image'].includes(e.kind)&&typeof e.ok==='boolean'&&Number.isFinite(e.at)&&e.at>now-DAY&&e.at<=now+1000);
  this.blocked=new Map(Object.entries(saved.blocked||{}).filter(([key,time])=>/^(gemini|aimode):(chat|image)$/.test(key)&&Number.isFinite(time)&&time>now&&time<now+DAY));
 }
 serialize(){this.cleanup();return {events:this.events,blocked:Object.fromEntries(this.blocked)};}
 cleanup(){const min=this.clock()-DAY;this.events=this.events.filter(e=>e.at>min);}
 count(provider,kind){this.cleanup();return this.events.filter(e=>e.provider===provider&&e.kind===kind&&e.ok).length;}
 check(provider,kind){
  this.cleanup();
  const blocked=this.blocked.get(provider+':'+kind);
  if(blocked&&blocked>this.clock())fail(429,'provider_quota_cooldown','Provider reported a usage limit; pause until the cooldown expires');
  const cap=this.caps[provider]?.[kind];
  if(cap&&this.count(provider,kind)>=cap)fail(429,'orbit_usage_cap','Orbit local '+kind+' safety budget has been reached; this is not a Google account quota');
 }
 record(provider,kind,{ok,error}={}){
  this.events.push({provider,kind,ok:Boolean(ok),at:this.clock()});
  const message=String(error?.message||'');
  if(!ok&&/(?:quota|rate limit|usage limit|daily limit|too many requests|מכסת|מגבלת שימוש)/i.test(message)){
   this.blocked.set(provider+':'+kind,this.clock()+30*60*1000);
  }
  this.cleanup();
 }
 status(){
  this.cleanup();
  const result={};
  for(const provider of ['gemini','aimode']){
   result[provider]={};
   for(const kind of ['chat','image']){
    const used=this.count(provider,kind),cap=this.caps[provider]?.[kind]??null;
    result[provider][kind]={orbit_successes_last_24h:used,local_cap:cap,local_remaining:cap==null?null:Math.max(0,cap-used),provider_remaining:'unknown',cooldown_until:this.blocked.get(provider+':'+kind)||null};
   }
  }
  return {source:'orbit_local_activity_only',disclaimer:'Google account-wide usage and quota are not available to Orbit',providers:result};
 }
}
