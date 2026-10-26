import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantSnapshot,newReply} from '../src/adapters/response-detection.mjs';
test('GPT DIL assistant container detected but user bubble excluded', async()=>{
 const selectors={'[data-message-author-role="assistant"]':[], 'main [class*="DilResponseRoot-"]':['OK']};
 const page={locator:s=>({allTextContents:async()=>selectors[s]||[]})};
 const snap=await assistantSnapshot(page,'gpt',{assistant:['[data-message-author-role="assistant"]']});
 assert.equal(newReply({primary:[],fallback:[]},snap),'OK');
});
