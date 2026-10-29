import test from 'node:test';
import assert from 'node:assert/strict';
import {launchPersistentBrowser,diagnoseBrowserLaunch,browserOptions} from '../src/adapters/browser-launch.mjs';

const context={close:async()=>{}};
test('Uses Playwright Chromium on initial launch, preserves visible login',async()=>{
 const calls=[];const chromium={launchPersistentContext:async(dir,opts)=>{calls.push({dir,opts});return context;}};
 const out=await launchPersistentBrowser(chromium,'/profiles/gemini',{browserChannel:'auto',headless:false});
 assert.equal(out.engine,'Playwright Chromium');assert.equal(calls.length,1);assert.equal(calls[0].opts.headless,false);assert.equal(calls[0].opts.channel,undefined);
});
test('Falls back to Edge on failed bundled Chromium with SAME intended profile',async()=>{
 const calls=[];const chromium={launchPersistentContext:async(dir,opts)=>{calls.push({dir,opts});if(!opts.channel)throw Error('Executable doesn\'t exist at C:/chromium');return context;}};
 const out=await launchPersistentBrowser(chromium,'/profiles/gemini',{browserChannel:'auto'});
 assert.equal(out.engine,'Microsoft Edge');assert.equal(out.attempts.length,1);assert.equal(calls.length,2);assert.equal(calls[0].dir,calls[1].dir);assert.equal(calls[1].opts.channel,'msedge');
});
test('Explicit Edge setting starts Edge directly',async()=>{
 let channel;const out=await launchPersistentBrowser({launchPersistentContext:async(dir,opts)=>{channel=opts.channel;return context;}},'profile',{browserChannel:'msedge'});
 assert.equal(channel,'msedge');assert.equal(out.engine,'Microsoft Edge');
});
test('Does not retry a profile lock in another browser',async()=>{
 let count=0;const chromium={launchPersistentContext:async()=>{count++;throw Error('user data directory is already in use');}};
 await assert.rejects(()=>launchPersistentBrowser(chromium,'profile',{browserChannel:'auto'}),e=>e.code==='browser_unavailable'&&/locked/i.test(e.message));
 assert.equal(count,1);
});
test('Failures include underlying stderr from BOTH engines',async()=>{
 const chromium={launchPersistentContext:async(_dir,opts)=>{throw Error(opts.channel==='msedge'?'Edge blocked by policy':'chrome startup failure');}};
 await assert.rejects(()=>launchPersistentBrowser(chromium,'profile',{browserChannel:'auto'}),e=>e.code==='browser_unavailable'&&e.detail.includes('chrome startup failure')&&e.detail.includes('Edge blocked by policy'));
});
test('Disallows arbitrary executable/channel injection',async()=>{
 await assert.rejects(()=>launchPersistentBrowser({},'profile',{browserChannel:'../../evil'}),e=>e.code==='invalid_browser_channel');
});
test('Browser diagnosis uses an isolated profile and cleans it up',async()=>{
 let dir;let closed=false;
 const chromium={launchPersistentContext:async(p)=>{dir=p;return {close:async()=>{closed=true;}};}};
 const r=await diagnoseBrowserLaunch({browserChannel:'chromium'},{chromium});
 assert.equal(r.ok,true);assert.equal(closed,true);assert.match(dir,/orbit-browser-check-/);
});
test('Browser diagnosis returns useful diagnostic for missing executable',async()=>{
 const chromium={launchPersistentContext:async()=>{throw Error('Executable does not exist');}};
 const r=await diagnoseBrowserLaunch({browserChannel:'chromium'},{chromium});
 assert.equal(r.ok,false);assert.match(r.detail,/Executable does not exist/);
});
test('Launch options cannot silently start a headless login',()=>{
 const opts=browserOptions({headless:false},'msedge');assert.equal(opts.headless,false);assert.equal(opts.channel,'msedge');
});
