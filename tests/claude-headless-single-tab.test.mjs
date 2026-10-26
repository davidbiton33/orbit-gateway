import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadConfig} from '../src/lib/config.mjs';
const source=()=>readFile(new URL('../src/adapters/browser.mjs',import.meta.url),'utf8');
test('Claude headless by default without changing other provider default',async()=>{
 const x=await loadConfig({CLAUDE_HEADLESS:'true',BROWSER_HEADLESS:'false'});
 assert.equal(x.claudeHeadless,true);assert.equal(x.browserHeadless,false);
});
test('Claude visual debugging is explicitly configurable',async()=>{
 const x=await loadConfig({CLAUDE_HEADLESS:'false'});assert.equal(x.claudeHeadless,false);
});
test('BrowserHub uses Claude-specific headless flag with ephemeral conversation tabs',async()=>{
 const x=await source();assert.match(x,/provider==='claude'\?this\.config\.claudeHeadless/);
 assert.match(x,/await this\.open\(provider\)/);
 assert.match(x,/page=await this\.contexts\.get\(provider\)\.newPage\(\)/);
});
test('Conversation tabs close only after persistence; restoration uses URL',async()=>{
 const x=await source();assert.match(x,/if\(persisted && provider!=='gpt'/);
 assert.match(x,/await page\.goto\(item\.url/);
});
