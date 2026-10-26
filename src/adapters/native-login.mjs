/* One-time, user-driven login in a NORMAL installed Chrome browser.
   No Playwright instrumentation, Chrome remote-debugging, cookie export or profile sharing
   with the user's everyday browser. This is not a CAPTCHA/OAuth bypass. */
import {access,mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import {GatewayError} from '../lib/errors.mjs';

export const CLAUDE_PROFILE_CHANNEL = 'chrome';
export function channelMarker(dataDir,provider='claude') {
 return path.join(dataDir,'profile-meta',`${provider}.json`);
}
export async function profileBrowserChannel(dataDir,provider,configured='auto') {
 if(provider!=='claude')return configured;
 let marker;
 try{marker=JSON.parse(await readFile(channelMarker(dataDir,provider),'utf8'));}catch{return configured;}
 if(marker?.channel!=='chrome')return configured;
 if(process.env.ORBIT_CLOUD_ARM64==='1')return 'chromium';
 if(configured!=='auto'&&configured!=='chrome'){
  throw new GatewayError(409,'browser_channel_conflict',
   'Claude was signed in with regular Google Chrome. Set GATEWAY_BROWSER_CHANNEL=auto (recommended) or chrome; do not use a different browser with this profile.');
 }
 return 'chrome';
}

export function installedChromeCandidates({platform=process.platform,env=process.env}={}){
 const paths=[];
 if(env.GATEWAY_NATIVE_CHROME_PATH)paths.push(env.GATEWAY_NATIVE_CHROME_PATH);
 if(platform==='win32'){
  for(const base of [env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA]){
   if(base)paths.push(path.join(base,'Google','Chrome','Application','chrome.exe'));
  }
 }else if(platform==='darwin'){
  paths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 }else{
  paths.push('/usr/bin/google-chrome-stable','/usr/bin/google-chrome','/opt/google/chrome/chrome');
 }
 return [...new Set(paths)];
}
export async function findInstalledChrome(options={}){
 const candidates=installedChromeCandidates(options);
 const canAccess=options.canAccess||access;
 for(const executable of candidates){
  try{await canAccess(executable);return executable;}catch{}
 }
 throw new GatewayError(503,'native_chrome_missing',
  'Google Chrome (the regular installed browser) was not found. Install Google Chrome or set GATEWAY_NATIVE_CHROME_PATH to chrome.exe in the shell environment.');
}
export function nativeChromeArgs(profileDir,url){
 // Deliberately DO NOT add --remote-debugging-port or --enable-automation.
 return [`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--new-window',url];
}
async function promptUser(message){
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{await rl.question(message);}finally{rl.close();}
}
export async function loginWithRegularChrome(provider,config,{
 locate=findInstalledChrome,spawnBrowser=spawn,prompt=promptUser,output=console
}={}){
 if(provider!=='claude')throw new GatewayError(400,'native_login_provider','Native Chrome login is enabled only for Claude in this release.');
 const chrome=await locate();
 const dir=path.join(config.dataDir,'profiles',provider);
 await mkdir(dir,{recursive:true});
 const args=nativeChromeArgs(dir,'https://claude.ai/new');
 let child;
 try{child=spawnBrowser(chrome,args,{stdio:'ignore',windowsHide:false,detached:false});}
 catch(e){throw new GatewayError(503,'native_chrome_launch_failed',`Could not launch installed Chrome: ${e.message}`);}
 if(!child)throw new GatewayError(503,'native_chrome_launch_failed','Could not start installed Chrome.');
 // Avoid an unhandled child-process error; await startup race without ever manipulating Chrome.
 await new Promise((resolve,reject)=>{
  if(typeof child.once!=='function')return resolve();
  child.once('error',e=>reject(new GatewayError(503,'native_chrome_launch_failed',e.message)));
  child.once('spawn',resolve);
  if(child.pid)resolve();
 });
 // Record browser affinity immediately, even if the user has to retry signing in.
 const marker=channelMarker(config.dataDir,provider);
 await mkdir(path.dirname(marker),{recursive:true});
 await writeFile(marker,JSON.stringify({channel:'chrome',purpose:'user-driven-login',version:1},null,2)+'\n',{mode:0o600});
 output.log('\nNORMAL Google Chrome launched with a DEDICATED Claude profile.');
 output.log('1) Sign in to https://claude.ai using Google or your preferred login method.');
 output.log('2) Close ALL windows opened for this dedicated Chrome profile.');
 output.log('3) Return here and press Enter. No passwords or cookies are copied.');
 await prompt('Press Enter AFTER closing the dedicated Chrome window... ');
 if(child.exitCode===null&&child.signalCode===null){
  output.warn('Chrome may still be running in the background. If verification reports a locked profile, close its windows/processes and rerun the login command.');
 }
 return {provider,engine:'Installed Google Chrome',profileDir:dir,marker};
}
