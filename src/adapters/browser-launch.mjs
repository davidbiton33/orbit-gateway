/* Browser launcher with actionable diagnostics and explicit Windows Edge fallback.
   Does not touch profiles from other providers or the legacy GPT Docker worker. */
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {GatewayError} from '../lib/errors.mjs';

const allowed=new Set(['auto','chromium','msedge','chrome']);
function cleanError(e){
  let msg=String(e?.message||e||'Unknown launch failure');
  // A launch error can include multiline browser stderr; keep the meaningful detail.
  return msg.length>2200?msg.slice(0,2200)+'…':msg;
}
function locked(error){return /user data directory is already in use|profile.*in use|singletonlock|processsingleton|another browser.*profile|lockfile/i.test(cleanError(error));}
function channels(setting){
  if(!allowed.has(setting))throw new GatewayError(400,'invalid_browser_channel','GATEWAY_BROWSER_CHANNEL must be auto, chromium, msedge, or chrome.');
  return setting==='auto'?[{name:'Playwright Chromium',channel:null},{name:'Microsoft Edge',channel:'msedge'}]:
    [{name:setting==='chromium'?'Playwright Chromium':setting==='msedge'?'Microsoft Edge':'Google Chrome',channel:setting==='chromium'?null:setting}];
}
export function browserOptions(settings={},channel=null){
  const options={acceptDownloads:true,headless:settings.headless??false,viewport:{width:1360,height:900},args:['--disable-notifications',...(process.platform==='linux'?['--password-store=basic','--disable-dev-shm-usage']:[])],timeout:35000};
  if(channel)options.channel=channel;
  return options;
}
export async function launchPersistentBrowser(chromium,profileDir,settings={}){
  const selection=settings.browserChannel||'auto';
  const attempts=[];
  for(const candidate of channels(selection)){
    try {
      const context=await chromium.launchPersistentContext(profileDir,browserOptions(settings,candidate.channel));
      return {context,engine:candidate.name,attempts};
    }catch(error){
      const reason=cleanError(error);
      attempts.push({engine:candidate.name,reason});
      // Never try to launch a second browser against an active locked user-data directory.
      if(locked(error))break;
    }
  }
  const message=attempts.some(x=>locked(x.reason))?
    'Chromium profile appears locked by another process. Close the browser currently using this profile (including any noVNC login window), then retry.':
    'Browser did not launch. Run: node bin/gateway.mjs doctor browser. If Chromium fails but Edge works, set GATEWAY_BROWSER_CHANNEL=msedge in .env.';
  const detail=attempts.map(a=>`[${a.engine}] ${a.reason}`).join('\n\n');
  throw new GatewayError(503,'browser_unavailable',message,detail);
}
export async function diagnoseBrowserLaunch(config,{chromium:injectedBrowser}={}){
  const chromium=injectedBrowser|| (await import('playwright')).chromium;
  const folder=await mkdtemp(path.join(os.tmpdir(),'orbit-browser-check-'));
  try{
    const result=await launchPersistentBrowser(chromium,folder,{browserChannel:config.browserChannel||'auto',headless:false});
    await result.context.close();
    return {ok:true,engine:result.engine,previousFailures:result.attempts};
  }catch(e){return {ok:false,code:e.code||'browser_unavailable',message:e.message,detail:e.detail||cleanError(e)};}
  finally{await rm(folder,{recursive:true,force:true,maxRetries:3,retryDelay:250}).catch(()=>{});}
}
