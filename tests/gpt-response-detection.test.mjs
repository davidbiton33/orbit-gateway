import test from 'node:test';import assert from 'node:assert/strict';
import {chooseReply,newReply,assistantSnapshot,browserResponseDiagnostics} from '../src/adapters/response-detection.mjs';
const fake = sets => ({url:()=> 'https://chatgpt.com/c/example',locator:s=>({allTextContents:async()=>sets[s]||[],first(){return this;},isVisible:async()=>false,count:async()=>0})});
test('new GPT assistant reply is distinguished from prior user messages',()=>{
 const before={primary:[],fallback:[]};
 const now={primary:[],fallback:['OK']};assert.equal(newReply(before,now),'OK');
 assert.equal(newReply(now,now),'');
});
test('existing GPT thread reads only changed assistant bubble',()=>{
 const before={primary:['old reply'],fallback:['old reply']};
 assert.equal(newReply(before,{primary:['old reply','new answer'],fallback:['old reply','new answer']}),'new answer');
 assert.equal(newReply(before,{primary:['old reply'],fallback:['old reply updated']}),'old reply updated');
 assert.equal(newReply(before,before),'');
});
test('empty streaming assistant never counts as completion',()=>{
 assert.equal(chooseReply(['old'],['old','  ']),'');
 assert.equal(chooseReply([],[]),'');
});
test('diagnostics do not include prompt or answer content',async()=>{
 const page=fake({'[data-message-author-role=assistant]':['SECRET_ANSWER']});
 const d=await browserResponseDiagnostics(page,'gpt',{editor:['#prompt'],stop:['#stop']},{primary:[],fallback:[]},{primary:['SECRET_ANSWER'],fallback:[]});
 const json=JSON.stringify(d);assert.ok(!json.includes('SECRET_ANSWER'));assert.equal(d.primary_last_chars,13);
});
test('GPT fallback is scoped to conversation-turn elements',async()=>{
 const p=fake({'[data-message-author-role="assistant"]':[], 'main [data-testid^="conversation-turn-"] .agent-turn':['OK']});
 const got=await assistantSnapshot(p,'gpt',{assistant:['[data-message-author-role="assistant"]']});
 assert.deepEqual(got.primary,[]);assert.deepEqual(got.fallback,['OK']);
});

test('GPT selector fallback excludes user message-only UI',async()=>{
 const p=fake({'[data-testid^="conversation-turn-"] .whitespace-pre-wrap':['USER MESSAGE']});
 const got=await assistantSnapshot(p,'gpt',{assistant:['[data-message-author-role="assistant"]']});
 assert.equal(newReply({primary:[],fallback:[]},got),'');
});
