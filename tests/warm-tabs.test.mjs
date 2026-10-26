import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=x=>readFile(new URL(x,import.meta.url),'utf8');
test('Cloud workers retain only latest completed chat and create separate warm new-chat page',async()=>{
 const src=await read('../src/adapters/browser.mjs');
 assert.match(src,/this\.warmPages=new Map/);
 assert.match(src,/this\.warmPromises=new Map/);
 assert.match(src,/await page\.locator\(packs\[provider\]\.editor\.join/);
 assert.match(src,/if\(oldId===threadId\|\|thread\.provider!==provider\)continue/);
 assert.match(src,/if\(warm&&!warm\.isClosed\(\)\)/);
 assert.match(src,/this\.warmPages\.delete\(provider\);page=warm/);
 assert.match(src,/void this\._warm\(provider\)/);
});
test('GPT last-chat continuation stays on same page with stored conversation URL',async()=>{
 const src=await read('../legacy-gpt/src/gpt-native.mjs');
 assert.match(src,/this\.#retainedPage=page/);
 assert.match(src,/this\.#retainedCapture=network/);
 assert.match(src,/this\.#retainedConversationId=id/);
 assert.match(src,/await this\.#saveMappings\(\)/);
 assert.match(src,/if\(previous&&previous!==page\)await previous\.close/);
});
