import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
 installedChromeCandidates,findInstalledChrome,nativeChromeArgs,
 channelMarker,profileBrowserChannel,loginWithRegularChrome
} from '../src/adapters/native-login.mjs';

const tmp=()=>mkdtemp(path.join(os.tmpdir(),'claude-native-test-'));
test('Regular Windows Chrome is found in standard paths, not Playwright Chromium',async()=>{
 const paths=installedChromeCandidates({platform:'win32',env:{PROGRAMFILES:'C:\\Program Files',LOCALAPPDATA:'C:\\Users\\User\\AppData\\Local'}});
 assert.equal(paths.some(p=>p.endsWith('Google/Chrome/Application/chrome.exe')||p.endsWith('Google\\Chrome\\Application\\chrome.exe')),true);
 const found=await findInstalledChrome({platform:'win32',env:{PROGRAMFILES:'C:\\Apps'},canAccess:async p=>{
  if(!p.includes('Google'))throw new Error('missing');
 }});
 assert.ok(found.includes('Chrome'));
});

test('Normal Chrome login has dedicated profile, Google OAuth and no automation / CDP flags',async()=>{
 const dir=await tmp();
 try{
  let invocation,questions=0;const logs=[];
  const result=await loginWithRegularChrome('claude',{dataDir:dir},{
   locate:async()=>'/installed/chrome',
   spawnBrowser:(bin,args,options)=>{
    invocation={bin,args,options};return {pid:150,exitCode:0,signalCode:null,once:()=>{}};
   },
   prompt:async()=>{questions++;},
   output:{log:(...v)=>logs.push(v.join(' ')),warn:(...v)=>logs.push(v.join(' '))}
  });
  assert.equal(invocation.bin,'/installed/chrome');
  assert.ok(invocation.args.some(a=>a.startsWith('--user-data-dir=')&&a.includes('profiles')));
  assert.ok(invocation.args.includes('https://claude.ai/new'));
  assert.ok(invocation.args.every(a=>!a.includes('remote-debugging')&&!a.includes('enable-automation')));
  assert.equal(questions,1);
  assert.equal(result.provider,'claude');
  assert.equal(JSON.parse(await readFile(channelMarker(dir,'claude'),'utf8')).channel,'chrome');
  assert.equal(await profileBrowserChannel(dir,'claude','auto'),'chrome');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Manual browser affinity only changes Claude, not Gemini or GPT',async()=>{
 const dir=await tmp();
 try{
  await mkdir(path.dirname(channelMarker(dir,'claude')),{recursive:true});
  await writeFile(channelMarker(dir,'claude'),JSON.stringify({channel:'chrome'}));
  assert.equal(await profileBrowserChannel(dir,'claude','auto'),'chrome');
  assert.equal(await profileBrowserChannel(dir,'gpt','auto'),'auto');
  assert.equal(await profileBrowserChannel(dir,'gemini','msedge'),'msedge');
  assert.equal(await profileBrowserChannel(dir,'claude','chrome'),'chrome');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Fails safely when manual Chrome profile conflicts with explicit Edge browser channel',async()=>{
 const dir=await tmp();
 try{
  await mkdir(path.dirname(channelMarker(dir,'claude')),{recursive:true});
  await writeFile(channelMarker(dir,'claude'),JSON.stringify({channel:'chrome'}));
  await assert.rejects(()=>profileBrowserChannel(dir,'claude','msedge'),e=>e.code==='browser_channel_conflict');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('No browser change unless Chrome native login actually launches',async()=>{
 const dir=await tmp();
 try{
  await assert.rejects(()=>loginWithRegularChrome('claude',{dataDir:dir},{locate:async()=>{throw new Error('missing');}}),/missing/);
  await assert.rejects(()=>readFile(channelMarker(dir,'claude'),'utf8'),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Native Chrome launch args preserve exact profile and destination and avoid webdriver switches',()=>{
 const args=nativeChromeArgs('C:\\some folder\\gateway\\claude','https://claude.ai/new');
 assert.equal(args[0],'--user-data-dir=C:\\some folder\\gateway\\claude');
 assert.equal(args.at(-1),'https://claude.ai/new');
 assert.ok(args.every(a=>!a.includes('headless')&&!a.includes('remote-debugging')));
});
