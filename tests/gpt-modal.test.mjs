import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyGptDialog,inspectGptDialogs,dismissKnownGptNotice} from '../src/adapters/gpt-modal.mjs';
function pageFor(text, {buttons=true}={}){
 let open=true,clicks=0;
 const button={isVisible:async()=>buttons&&open,click:async()=>{clicks++;open=false},first(){return this}};
 const dialog={innerText:async()=>text,locator:()=>button,getByRole:()=>button};
 const locator={count:async()=>open?1:0,first:()=>dialog};
 return {page:{locator:()=>locator},stats:()=>({open,clicks})};
}
test('classifies known transient rate-limit/history dialogs without leaking text',()=>{
 assert.equal(classifyGptDialog('Too many requests. Try again later.'),'recoverable_notice');
 assert.equal(classifyGptDialog('משהו השתבש'),'recoverable_notice');
 assert.equal(classifyGptDialog('Please sign in to continue'),'authentication');
 assert.equal(classifyGptDialog('Please verify your login - too many requests'),'authentication');
 assert.equal(classifyGptDialog('Upgrade your plan'),'unknown');
});
test('closes only known dismissible notice and avoids clicking auth/unknown dialogs',async()=>{
 for(const [text,expected] of [['Too many requests',true],['Sign in required',false],['Upgrade subscription',false]]){
  const {page,stats}=pageFor(text);const out=await dismissKnownGptNotice(page,{log:{info(){}}});
  assert.equal(out.dismissed,expected);assert.equal(stats().clicks,Number(expected));
 }
});
test('never arbitrarily clicks an undismissable notice',async()=>{
 const {page,stats}=pageFor('Too many requests',{buttons:false});
 assert.equal((await dismissKnownGptNotice(page)).dismissed,false);
 assert.equal(stats().clicks,0);
});
test('dialog inspection exposes only count and classified type',async()=>{
 const {page}=pageFor('Very secret prompt: Too many requests');
 const x=await inspectGptDialogs(page);
 assert.deepEqual(x,{visible_dialogs:1,dialog_type:'recoverable_notice'});
 assert.doesNotMatch(JSON.stringify(x),/secret/);
});
