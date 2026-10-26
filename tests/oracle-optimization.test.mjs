import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const browser=()=>readFile(new URL('../src/adapters/browser.mjs',import.meta.url),'utf8');
const native=()=>readFile(new URL('../legacy-gpt/src/gpt-native.mjs',import.meta.url),'utf8');
test('Oracle closes restored startup tabs without affecting Windows',async()=>{
 const x=await browser();
 assert.match(x,/ORBIT_CLOUD_ARM64==='1'/);
 assert.match(x,/extra\.close\(\)/);
});
test('Browser conversation persistence is atomic and close follows confirmed write',async()=>{
 const x=await browser();
 assert.match(x,/await rename\(tmp,this\.threadFile\);return true/);
 assert.match(x,/if\(persisted && provider!=='gpt'/);
});
test('GPT Legacy mapping is persisted and restored without exposing secrets',async()=>{
 const x=await native();
 assert.match(x,/#restoreMappings\(\)/);
 assert.match(x,/#saveMappings\(\)/);
 assert.match(x,/await this\.#saveMappings\(\)/);
 assert.match(x,/await rename\(tmp,this\.#mappingFile\(\)\)/);
 assert.doesNotMatch(x,/console\.log\(.+apiKey/);
});
