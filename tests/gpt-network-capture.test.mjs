import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {GptSseParser,GptNetworkCapture,isChatGptAnswerEndpoint} from '../src/adapters/gpt-network-capture.mjs';
import {captureGptFailure} from '../src/adapters/gpt-failure-capture.mjs';
const sse=(x)=>'data: '+JSON.stringify(x)+'\n\n';
const user={message:{author:{role:'user'},content:{parts:['Secret user prompt']},end_turn:true}};
const draft={message:{author:{role:'assistant'},channel:'analysis',content:{parts:['Internal text']}}};
const answer=(text)=>({message:{author:{role:'assistant'},channel:'final',content:{content_type:'text',parts:[text]},status:'finished_successfully'},conversation_id:'test-conversation'});

test('SSE parser reconstructs split frames, ignores user and internal assistant text',()=>{
 const p=new GptSseParser();const raw=sse(user)+sse(draft)+sse(answer('Orbit works'));
 for(let i=0;i<raw.length;i+=5)p.feed(raw.slice(i,i+5));
 assert.equal(p.snapshot().text,'Orbit works');
 assert.equal(p.snapshot().conversationId,'test-conversation');
 assert.equal(p.snapshot().complete,true);
 assert.equal(p.snapshot().events,3);
 assert.doesNotMatch(p.snapshot().text,/Secret|Internal/);
});
test('partial SSE without terminal status remains incomplete',()=>{
 const p=new GptSseParser();p.feed(sse({message:{author:{role:'assistant'},channel:'final',content:{parts:['still typing']}}}));
 assert.equal(p.snapshot().text,'still typing');assert.equal(p.snapshot().complete,false);
});
test('assistant final text can arrive in JSON patch append events',()=>{
 const p=new GptSseParser();
 p.feed(sse({message:{author:{role:'assistant'},channel:'final',content:{parts:[]}}}));
 p.feed(sse({v:[{o:'append',p:'/message/content/parts/0',v:'hel'},{o:'append',p:'/message/content/parts/0',v:'lo'}]}));
 p.feed(sse({type:'message_stream_complete'}));
 assert.equal(p.snapshot().text,'hello');assert.equal(p.snapshot().complete,true);
});
test('endpoint filtering rejects other origins, GET, and unrelated POSTs',()=>{
 assert.equal(isChatGptAnswerEndpoint('https://chatgpt.com/backend-api/conversation','POST'),true);
 assert.equal(isChatGptAnswerEndpoint('https://chatgpt.com/backend-api/f/conversation','POST'),true);
 assert.equal(isChatGptAnswerEndpoint('https://chatgpt.com/backend-api/conversation','GET'),false);
 assert.equal(isChatGptAnswerEndpoint('https://fake-chatgpt.com/backend-api/conversation','POST'),false);
 assert.equal(isChatGptAnswerEndpoint('https://chatgpt.com/backend-api/billing','POST'),false);
});
test('passive capture consumes only the armed turn and resets on next turn',async()=>{
 class Page extends EventEmitter{
  async exposeFunction(_name,fn){this.hook=fn;}
  async addInitScript(){}
  async evaluate(){return false;}
  isClosed(){return false;}
 }
 const page=new Page(),cap=new GptNetworkCapture(page);await cap.install();await cap.prime();
 cap.arm();page.hook('s1',sse(answer('first')));
 assert.equal(cap.snapshot().text,'first');cap.disarm();
 cap.arm();assert.equal(cap.snapshot().text,'');
 page.hook('s1',sse(answer('stale')));
 assert.equal(cap.snapshot().text,'');
 page.hook('s2',sse(answer('second')));
 assert.equal(cap.snapshot().text,'second');cap.disarm();
});
test('network fallback captures completed responses when page tee unavailable',async()=>{
 class Page extends EventEmitter{
  async exposeFunction(){}async addInitScript(){}async evaluate(){return false;}isClosed(){return false;}
 }
 const page=new Page(),cap=new GptNetworkCapture(page);await cap.install();cap.arm();
 const content=sse(answer('from response body'));
 const response={url:()=> 'https://chatgpt.com/backend-api/conversation',request:()=>({method:()=> 'POST'}),headers:()=>({'content-type':'text/event-stream'}),text:async()=>content};
 await page.listeners('response')[0](response);
 assert.equal(cap.snapshot().text,'from response body');
 assert.equal(cap.snapshot().networkPosts,1);
 assert.equal(cap.snapshot().completedBodies,1);
});
test('failure capture writes a private screenshot and metadata without saving text',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'orbit-gpt-capture-'));
 try{
  const page={evaluate:async()=>({main_count:0,body_text_chars:0}),screenshot:async()=>Buffer.from('fake-png')};
  const result=await captureGptFailure(page,dir,{text:'CONFIDENTIAL REPLY',networkPosts:1,events:9});
  assert.ok(result.screenshot.endsWith('gpt-last-failure.png'));
  assert.equal((await readFile(result.screenshot)).toString(),'fake-png');
  const json=await readFile(result.metadata,'utf8');
  assert.equal(JSON.parse(json).network.networkTextChars,18);
  assert.doesNotMatch(json,/CONFIDENTIAL/);
  assert.deepEqual(JSON.parse(json).fingerprint,{main_count:0,body_text_chars:0});
 }finally{await rm(dir,{recursive:true,force:true});}
});
