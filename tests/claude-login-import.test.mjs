import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePlaywrightChromium} from '../src/adapters/browser.mjs';

test('Claude login correctly awaits asynchronously imported Playwright module', async()=>{
  const chromium={launchPersistentContext:async()=>({close:async()=>{}})};
  let importerCalled=0;
  const actual=await resolvePlaywrightChromium(()=>new Promise(resolve=>{
    importerCalled++;
    queueMicrotask(()=>resolve({chromium}));
  }));
  assert.equal(importerCalled,1);
  assert.equal(actual,chromium);
  assert.equal(typeof actual.launchPersistentContext,'function');
});

test('Malformed Playwright import fails with an actionable error', async()=>{
 await assert.rejects(()=>resolvePlaywrightChromium(async()=>({})),e=>
   e.code==='playwright_module_invalid'&&e.message.includes('npm install'));
});
