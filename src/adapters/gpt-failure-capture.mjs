/* Private, on-disk screenshot and metadata for failed GPT UI captures.
   Do not expose via API or log page text, requests, tokens, or cookies. */
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';

export async function gptDomFingerprint(page) {
  try {
    return await page.evaluate(() => {
      const count=s=>{try{return document.querySelectorAll(s).length;}catch{return -1;}};
      return {
        ready_state:document.readyState,
        title_length:document.title.length,
        body_text_chars:document.body?.innerText?.length??0,
        body_html_chars:document.body?.innerHTML?.length??0,
        main_count:count('main'),
        iframe_count:count('iframe'),
        role_main_count:count('[role="main"]'),
        message_role_count:count('[data-message-author-role]'),
        conversation_turn_count:count('[data-testid^="conversation-turn-"]'),
        app_root_count:count('#__next, #root'),
        shadow_host_count:[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).length,
        playwright_editor_count:count('#prompt-textarea, [data-testid="prompt-textarea"]'),
        // No text, HTML, URLs, request bodies, or account details are collected.
      };
    });
  }catch{return {error:'dom_probe_unavailable'};}
}
export async function captureGptFailure(page,dataDir,network={}) {
  const dir=path.join(dataDir,'diagnostics');
  const output={screenshot:'not_available',metadata:'not_available'};
  try{await mkdir(dir,{recursive:true,mode:0o700});}catch{return output;}
  const safeNetwork={
    networkPosts:Number(network.networkPosts||0),
    capturedChunks:Number(network.capturedChunks||0),
    completedBodies:Number(network.completedBodies||0),
    events:Number(network.events||0),
    bytesObserved:Number(network.bytesObserved||0),
    networkComplete:Boolean(network.complete),
    networkTextChars:String(network.text||'').length,
    teeInstalled:Boolean(network.teeInstalled),
  };
  const fingerprint=await gptDomFingerprint(page);
  try {
    const filename=path.join(dir,'gpt-last-failure.png');
    const png=await page.screenshot({timeout:6500,fullPage:false});
    await writeFile(filename,png,{mode:0o600});
    output.screenshot=filename;
  } catch {output.screenshot='screenshot_failed';}
  try {
    const filename=path.join(dir,'gpt-last-failure.json');
    const raw=JSON.stringify({version:1,created_at:new Date().toISOString(),fingerprint,network:safeNetwork},null,2);
    await writeFile(filename,raw,{mode:0o600});
    output.metadata=filename;
  } catch {output.metadata='write_failed';}
  return output;
}
