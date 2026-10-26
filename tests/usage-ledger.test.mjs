import test from 'node:test';import assert from 'node:assert/strict';import {UsageLedger} from '../src/lib/usage-ledger.mjs';
test('local caps count successes, never pretend Google remaining is known',()=>{
 let now=100000000;const u=new UsageLedger({ORBIT_GEMINI_IMAGE_DAILY_CAP:'2'},()=>now);
 u.check('gemini','image');u.record('gemini','image',{ok:true});
 u.record('gemini','image',{ok:false,error:new Error('failed to render')});
 assert.equal(u.status().providers.gemini.image.local_remaining,1);
 assert.equal(u.status().providers.gemini.image.provider_remaining,'unknown');
 u.record('gemini','image',{ok:true});
 assert.throws(()=>u.check('gemini','image'),e=>e.code==='orbit_usage_cap');
 now+=86400001;u.check('gemini','image');
});
test('provider quota errors trigger a local pause but ordinary failures do not',()=>{
 let now=100000000;const u=new UsageLedger({},()=>now);
 u.record('gemini','chat',{ok:false,error:new Error('daily usage limit reached')});
 assert.throws(()=>u.check('gemini','chat'),e=>e.code==='provider_quota_cooldown');
 now+=1800001;u.check('gemini','chat');
});
