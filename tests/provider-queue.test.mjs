import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderQueue} from '../src/lib/provider-queue.mjs';

const deferred=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
test('FIFO per provider and cross-provider parallel execution',async()=>{
 const q=new ProviderQueue({limit:3});
 const lock=deferred(),order=[];
 const first=q.run('gpt',async()=>{order.push('gpt1-start');await lock.promise;order.push('gpt1-end');return 1;});
 const second=q.run('gpt',async()=>{order.push('gpt2-start');return 2;});
 const claude=q.run('claude',async()=>{order.push('claude-start');return 3;});
 assert.equal(await claude,3);
 assert.equal(q.snapshot().gpt.pending,1);
 lock.release();assert.equal(await first,1);assert.equal(await second,2);
 assert.ok(order.indexOf('gpt1-end')<order.indexOf('gpt2-start'));
});
test('queue full fails with explicit 429 without executing prompt',async()=>{
 const q=new ProviderQueue({limit:1});const lock=deferred();
 const a=q.run('gpt',()=>lock.promise);
 const b=q.run('gpt',()=>99);
 await assert.rejects(q.run('gpt',()=>{throw Error('must not execute')}),e=>e.status===429&&e.code==='provider_queue_full');
 lock.release();await a;assert.equal(await b,99);
});
test('abort queued task without dispatching',async()=>{
 const q=new ProviderQueue({limit:2});const lock=deferred();const ac=new AbortController();
 const a=q.run('gemini',()=>lock.promise);
 let sent=false;const b=q.run('gemini',()=>{sent=true},{signal:ac.signal});
 ac.abort();await assert.rejects(b,e=>e.code==='request_cancelled');
 lock.release();await a;assert.equal(sent,false);
 assert.equal(q.snapshot().gemini.pending,0);
});
test('timed-out queue task does not execute after active task completes',async()=>{
 const q=new ProviderQueue({limit:2,waitMs:20});const lock=deferred();
 const a=q.run('claude',()=>lock.promise);
 let sent=false;const b=q.run('claude',()=>{sent=true});
 await assert.rejects(b,e=>e.code==='queue_wait_timeout');
 lock.release();await a;assert.equal(sent,false);
});
