import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleComposer,fillGptComposer} from '../src/adapters/composer.mjs';

test('GPT chooses visible composer instead of an earlier hidden matching textbox', async()=>{
  let applied=false, selector='',filtered=false,attempts=0;
  const page={isClosed:()=>false,waitForTimeout:async()=>{},locator:(q)=>{
    selector=q;return {filter(options){filtered=options.visible===true;return this;},
      first(){return this;},waitFor:async()=>{},fill:async(t)=>{attempts++; applied=t==='Hello';}};
  }};
  const editor=await fillGptComposer(page,['#prompt-textarea','[role="textbox"]'],'Hello');
  assert.equal(applied,true);assert.equal(filtered,true);assert.match(selector,/#prompt-textarea/);assert.equal(attempts,1);
  assert.ok(editor);
});
test('GPT transient editor disappearance retries filling without re-sending',async()=>{
 let attempts=0,retries=[];
 const page={isClosed:()=>false,waitForTimeout:async()=>{},locator:()=>({
   filter(){return this;},first(){return this;},waitFor:async()=>{},
   fill:async()=>{if(++attempts===1)throw new Error('editor detached after SPA navigation');}
 })};
 await fillGptComposer(page,['#prompt-textarea'],'hi',{onRetry:n=>retries.push(n)});
 assert.equal(attempts,2);assert.deepEqual(retries,[1]);
});
test('GPT editor stays unavailable: explicit before-send error without leaking prompt',async()=>{
 const page={isClosed:()=>false,waitForTimeout:async()=>{},locator:()=>({
   filter(){return this;},first(){return this;},waitFor:async()=>{throw new Error('hidden');}
 })};
 await assert.rejects(fillGptComposer(page,['#prompt-textarea'],'PRIVATE_PROMPT'),e=>e.code==='gpt_editor_unstable' && e.status===503 && !e.message.includes('PRIVATE_PROMPT'));
});
