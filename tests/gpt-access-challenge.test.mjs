import test from 'node:test';
import assert from 'node:assert/strict';
import {requireGptAccess,inspectGptAccessChallenge} from '../src/adapters/access-challenge.mjs';
const fake=(title,body,html='')=>({evaluate:async(fn)=>{
 const prevDoc=globalThis.document;
 globalThis.document={title,body:{innerText:body,outerHTML:html},querySelector:()=>null};
 try{return fn();}finally{globalThis.document=prevDoc;}
}});
test('recognizes Cloudflare human verification before attempting editor fill',async()=>{
 const page=fake('Just a moment...','Verify you are human');
 await assert.rejects(requireGptAccess(page),e=>e.code==='gpt_human_verification_required' && e.status===403);
});
test('ordinary ChatGPT page does not trigger false positive',async()=>{
 const page=fake('ChatGPT','Ask ChatGPT');
 assert.equal((await inspectGptAccessChallenge(page)).isChallenge,false);
});
test('turnstile markup triggers challenge without reading private prompt text',async()=>{
 const page=fake('ChatGPT','','<div class="cf-turnstile"></div>');
 await assert.rejects(requireGptAccess(page),e=>e.code==='gpt_human_verification_required');
});
