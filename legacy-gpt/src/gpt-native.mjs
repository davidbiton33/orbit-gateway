/**
 * Native, self-contained ChatGPT WEB adapter. No GPT Web Gateway or port 3000.
 * This is UI automation, not an OpenAI API client. The site may reject automation
 * and its DOM can change. Never copy cookies or use the main Chrome profile.
 */
import { randomUUID } from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {gptResponseLinks,newGptLinks,captureGptLinks} from './gpt-files.mjs';
import path from 'node:path';
import { sendGptPromptWithModalGuard } from './gpt-submit-action.mjs';
import { dismissChatHistoryRateLimitDialog , startChatHistoryModalWatcher } from './gpt-history-modal.mjs';
import { GatewayError, validateImageBuffer } from './security.mjs';
import { parseChatRequest } from './chat.mjs';
import { validateGptChat, validateGptImageOptions } from './gpt.mjs';
import { commonPrefixLength, sseEvent } from './streaming.mjs';
import { GptNetworkCapture } from './gpt-network-capture.mjs';
import { GPT_IMAGE_ELEMENTS, snapshotGptImages, waitForGptGeneratedImage } from './gpt-image-reader.mjs';
import { discoverProviderProjects } from './native-projects.mjs';
import {validateProjectId,validateProjectName,validateProjectChatUrl,readProjectChatLinks} from './gpt-project-ops.mjs';

export const GPT_URL = 'https://chatgpt.com/';
export const GPT_REPLY = '[data-message-author-role="assistant"]';
export const GPT_COMPOSERS = Object.freeze([
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  '[contenteditable="true"][data-placeholder]',
  '[contenteditable="true"][role="textbox"]',
  'textarea[placeholder*="message" i]',
  'textarea',
]);
const STOP = '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="עצור"]';
const SEND = '[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="שלח"]';
const GPT_TIMEOUT = 360_000;
const POLL_MS = 450;
const MAX_IMAGE_PIXELS = 30_000_000;

export function stableGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com' || !/^\/(?:g\/g-p-[A-Za-z0-9_-]{6,90}\/)?c\/[a-zA-Z0-9_-]{6,90}\/?$/.test(url.pathname)) return null;
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch { return null; }
}

export function nativeChatRequest(body, maxInputBytes=10*1024*1024) {
  const forwarded=validateGptChat(body,maxInputBytes);
  const parsed=parseChatRequest({...body,model:'gpt-web-chat',stream:false,stream_mode:undefined},
    {maxInputBytes,allowedModels:['gpt-web-chat']});
  return {...parsed,thinkingMode:forwarded.thinking_mode||'instant',nativeProjectId:forwarded.native_project_id||null};
}

/** The GPT DOM sometimes rewrites earlier markdown, so snapshots win over guesswork. */
export function makeNativeSse({id=`chatcmpl-${randomUUID()}`,model='gpt-web-chat'}={}) {
  let current='',sent='',completed=false;
  const created=Math.floor(Date.now()/1000);
  const chunk=(delta,extra={})=>sseEvent(null,{id,object:'chat.completion.chunk',model,created,choices:[{index:0,delta,finish_reason:null}],...extra});
  return {
    start:()=>chunk({role:'assistant',content:''}),
    progress(text) {
      if(completed || typeof text!=='string'||text===current)return '';
      current=text;
      // Snapshot is authoritative, chunks are append-only best effort.
      let data=sseEvent('gateway.snapshot',{text,revision:!text.startsWith(sent)});
      if(text.startsWith(sent)) {
        const stable=commonPrefixLength(sent,text);
        if(stable===sent.length&&text.length>sent.length) {
          data+=chunk({content:text.slice(sent.length)});
          sent=text;
        }
      }
      return data;
    },
    complete(text,conversationId,source='gpt-dom',attachments=[],file_warning=null) {
      if(completed)return '';
      completed=true;
      let data='';
      if(text!==current)data+=sseEvent('gateway.snapshot',{text,revision:true});
      if(!text.startsWith(sent))data+=sseEvent('gateway.reconcile',{text,reason:'gpt_dom_rewrote_previous_text'});
      else if(text.length>sent.length)data+=chunk({content:text.slice(sent.length)});
      data+=sseEvent('gateway.final',{text,conversation_id:conversationId,source,attachments,...(file_warning?{file_warning}:{})});
      data+=sseEvent(null,{id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{},finish_reason:'stop'}],conversation_id:conversationId,attachments,...(file_warning?{file_warning}:{})});
      return data+sseEvent(null,'[DONE]');
    },
    failure(error) {completed=true;return sseEvent('gateway.error',{error:{code:error?.code||'gpt_ui_error',message:String(error?.message||'ChatGPT failed').slice(0,350)}})+sseEvent(null,'[DONE]');},
  };
}

/**
 * Same-conversation follow-ups must keep using the existing ChatGPT tab when
 * possible. Reloading /c/<id> for EVERY message caused intermittent navigation
 * and composer timeouts even when the first turn had completed successfully.
 * The browser session never leaves the dedicated private Docker profile.
 */
export function canReuseGptConversationPage({requestedId, retainedId, expectedUrl, page, capture}) {
  if (!requestedId || requestedId !== retainedId || !page || !capture) return false;
  try {
    return !page.isClosed() && Boolean(expectedUrl) && stableGptUrl(page.url()) === expectedUrl;
  } catch { return false; }
}

/** Acquire a page bound to exactly one passive network listener. */
export async function acquireGptConversationTab({context, requestedId, expectedUrl, startUrl=null, retainedId,
  retainedPage, retainedCapture, captureFactory=(page)=>new GptNetworkCapture(page)}) {
  if (canReuseGptConversationPage({requestedId,retainedId,expectedUrl,page:retainedPage,capture:retainedCapture})) {
    return {page:retainedPage,network:retainedCapture,reused:true};
  }
  const page=await context.newPage();
  try {
    const network=captureFactory(page);
    await network.install();
    await page.goto(expectedUrl||startUrl||GPT_URL,{waitUntil:'domcontentloaded',timeout:45000});
    await network.prime();
    return {page,network,reused:false};
  } catch (error) {
    await page.close().catch(()=>{});
    throw error;
  }
}

/** SPA URL may be assigned a moment after the network stream finishes. */
async function resolveCompletedGptConversationUrl(page,network) {
  let url=stableGptUrl(page.url());
  const timeout=Date.now()+2500;
  while (!url && !page.isClosed() && Date.now()<timeout) {
    await page.waitForTimeout(200);
    url=stableGptUrl(page.url());
  }
  if(url)return url;
  // Use the conversation UUID seen in the authenticated browser's own response.
  // Do not follow redirects, guess hosts, or construct a URL from arbitrary text.
  const id=network?.snapshot()?.conversationId;
  if(typeof id==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    return stableGptUrl(`https://chatgpt.com/c/${id}`);
  return null;
}

async function editor(page) {
  for(const css of GPT_COMPOSERS) {
    const loc=page.locator(css).first();
    try {if(await loc.isVisible())return loc;}catch {}
  }
  throw new GatewayError(503,'gpt_login_or_ui_changed',
    'ChatGPT editor is unavailable. Run npm run auth:gpt and auth:check:gpt; the site may reject Headless Chrome.');
}

async function requireLogin(page) {
  const end=Date.now()+20000;
  while(Date.now()<end){
    try {return await editor(page);}catch {}
    if(/\/auth\/|\/login/.test(new URL(page.url()).pathname))break;
    await page.waitForTimeout(750);
  }
  throw new GatewayError(503,'gpt_login_or_challenge','ChatGPT editor not available: login expired, challenge appeared, or UI changed.');
}

async function ensureFreshChat(page) {
  if((await page.locator(GPT_REPLY).count())===0 && !stableGptUrl(page.url()))return;
  const selectors=['[data-testid="create-new-chat-button"]','[data-testid="new-chat-button"]','a[href="/"]'];
  for(const css of selectors){
    try{const item=page.locator(css).first();if(await item.isVisible()){await item.click({timeout:4000});await page.waitForTimeout(1000);if((await page.locator(GPT_REPLY).count())===0 && !stableGptUrl(page.url()))return;}}catch{}
  }
  throw new GatewayError(503,'gpt_new_chat_unavailable','A clean ChatGPT conversation could not be confirmed. Nothing was sent.');
}


// Read only boolean/count metadata; never log chat text, prompts, URLs or cookies.
async function inspectGptSubmitFailure(page) {
  try {
    return await page.evaluate(() => {
      const visible = el => {
        if (!el || !(el instanceof Element))return false;
        const r=el.getBoundingClientRect(), s=getComputedStyle(el);
        return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none';
      };
      const text=(document.body?.innerText||'').slice(0,30000);
      const warnings=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-content"],[aria-modal="true"]')].filter(visible).slice(0,12);
      const composer=document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]');
      const send=document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="שלח הודעה"]');
      const withinHistory = el => /too\s+many\s+requests/i.test(el.innerText||'') &&
        /(?:conversations|conversation history|גישה לשיחות|היסטוריית השיחות)/i.test(el.innerText||'');
      let composerCovered=null;
      if(composer && visible(composer)) {
        const rect=composer.getBoundingClientRect(), node=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        composerCovered=Boolean(node && node!==composer && !composer.contains(node) && !node.contains(composer));
      }
      return {
        visible_dialogs:warnings.length,
        history_dialog_candidates:warnings.filter(withinHistory).length,
        too_many_requests_text_visible:/too\s+many\s+requests/i.test(text),
        history_limit_wording_present:/temporarily\s+limited\s+access\s+to\s+your\s+conversations|conversation\s+history\s+(?:is\s+)?(?:temporarily\s+)?(?:limited|unavailable)|גישה לשיחות|הגישה לשיחות/i.test(text),
        composer_present:Boolean(composer),composer_visible:visible(composer),composer_covered:composerCovered,
        send_present:Boolean(send),send_visible:visible(send),send_disabled:Boolean(send?.disabled),
        iframe_count:document.querySelectorAll('iframe').length,
      };
    });
  }catch{return {inspection_failed:true};}
}

export async function fillAndSubmit(page,text) {
  return sendGptPromptWithModalGuard(page,text,{getComposer:()=>editor(page)});
}

async function attachGptImage(page,imageBytes,mime) {
  const filename=mime==='image/png'?'reference.png':mime==='image/webp'?'reference.webp':'reference.jpg';
  const file={name:filename,mimeType:mime,buffer:imageBytes};
  const findInput=async()=>{
    const elements=page.locator('input[type="file"]');
    const length=Math.min(await elements.count(),12);
    for(let i=0;i<length;i++){
      const item=elements.nth(i);const accept=(await item.getAttribute('accept')||'').toLowerCase();
      if(accept.includes('image')||accept.includes('*')||length===1)return item;
    }
    return null;
  };
  let input=await findInput();
  if(input)await input.setInputFiles(file,{timeout:5000});
  else {
    const triggers=[
      '[data-testid="composer-plus-btn"]',
      'button[aria-label="Attach files"]',
      'button[aria-label="Add photos & files"]',
      'button[aria-label="הוספת קבצים"]',
      'button[aria-label="צרף קבצים"]',
    ];
    let clickTarget=null;
    for(const css of triggers){try{const candidate=page.locator(css).first();if(await candidate.isVisible()){clickTarget=candidate;break;}}catch{}}
    if(!clickTarget)throw new GatewayError(503,'gpt_upload_ui_changed','ChatGPT attachment menu is unavailable. Image was NOT submitted.');
    await clickTarget.click({timeout:3500});
    const action=page.getByRole('menuitem',{name:/add photos|upload (?:files|from computer)|photos & files|העלאת קבצים|הוספת תמונות/i}).first();
    if(await action.isVisible().catch(()=>false)){
      const chooser=page.waitForEvent('filechooser',{timeout:4000}).catch(()=>null);
      await action.click({timeout:3500});
      const chosen=await chooser;
      if(chosen)await chosen.setFiles(file);else {input=await findInput();if(!input)throw new GatewayError(503,'gpt_upload_ui_changed','ChatGPT did not expose a file input');await input.setInputFiles(file);}
    }else {
      input=await findInput();
      if(!input)throw new GatewayError(503,'gpt_upload_ui_changed','ChatGPT upload menu has no supported file input');
      await input.setInputFiles(file);
    }
  }
  const deadline=Date.now()+20000;
  while(Date.now()<deadline) {
    const previews=page.locator('[data-testid*="attachment" i] img,[data-testid*="upload" i] img,img[alt*="uploaded" i],[data-testid="composer-attachment"]');
    try {if(await previews.count()>0 && await previews.first().isVisible())return;}catch{}
    // A retained file input is only evidence of selection, not completed upload.
    await page.waitForTimeout(400);
  }
  throw new GatewayError(502,'gpt_upload_unconfirmed','ChatGPT did not show an attachment preview. Prompt NOT submitted.');
}

/**
 * Identify an answer by its turn identity/content, not only by the total count.
 * ChatGPT may update a pre-existing assistant turn or virtualize old turns.
 * Return only metrics in diagnostics; never print text, URLs, cookies or tokens.
 */
export function isNewGptAnswer(before, after) {
  if (!after?.text?.trim() && !(after?.images?.length)) return false;
  if (after.lastId && before?.lastId && after.lastId !== before.lastId) return true;
  if (after.count > (before?.count || 0)) return true;
  if (after.text !== (before?.text || '')) return true;
  if ((after.images?.length || 0) > (before?.images?.length || 0)) return true;
  return false;
}

/**
 * One serialized DOM reader, deliberately scoped to the chat area. Newer
 * ChatGPT builds do not always expose data-message-author-role=assistant.
 * Never inspect inputs, sidebars or arbitrary web-page content as an answer.
 * Exported for regression tests with synthetic page DOM; invoked in Chromium.
 */
export function snapshotGptReplyDOM(doc=globalThis.document) {
  const collect = css => [...doc.querySelectorAll(css)];
  const primary = collect('[data-message-author-role="assistant"]');
  const articles = collect('article[data-turn="assistant"]');
  const secondary = collect('[data-role="assistant"],[data-message-author="assistant"],.agent-turn');
  const turnTestIds = collect('[data-testid^="conversation-turn-"]');
  const allArticles = collect('main article');
  const markdown = collect('main .markdown,main [data-testid="markdown-content"],main .prose');
  const main = doc.querySelector('main');
  const excluded = el => Boolean(el.closest?.(
    '[data-message-author-role="user"],[data-role="user"],[data-message-author="user"],form,[contenteditable="true"],nav,aside'
  ));

  let roots, detectionSource;
  if (primary.length) { roots=primary; detectionSource='message_role'; }
  else if (articles.length) { roots=articles; detectionSource='article_role'; }
  else if (secondary.length) { roots=secondary; detectionSource='alternate_role'; }
  else {
    // Preferred fallback: rendered Markdown inside conversation turn elements,
    // including modern article[data-testid="conversation-turn-N"] turns.
    const inTurns=markdown.filter(el=>
      !excluded(el) && Boolean(el.closest?.('article,[data-testid^="conversation-turn-"]'))
    );
    if(inTurns.length) { roots=inTurns; detectionSource='turn_markdown'; }
    else { roots=markdown.filter(el=>!excluded(el)); detectionSource=roots.length?'main_markdown':'none'; }
  }

  const diagnostics = {
    primary:primary.length, articles:articles.length, secondary:secondary.length,
    turn_testids:turnTestIds.length, main_articles:allArticles.length,
    main_markdown:markdown.length, main_present:Boolean(main),
    main_text_length:Math.min(999999,(main?.innerText||main?.textContent||'').length),
    body_text_length:Math.min(999999,(doc.body?.innerText||doc.body?.textContent||'').length),
    editor_candidates:collect('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]').length,
    iframes:collect('iframe').length, detection_source:detectionSource,
  };
  const root=roots.at(-1);
  if (!root) return {count:0,text:'',images:[],lastId:null,dom:diagnostics};

  const content = root.matches?.('article')
    ? root.querySelector('[data-message-author-role="assistant"], [data-testid="markdown-content"], .markdown, .prose') || root
    : root;
  let text=(content.innerText||content.textContent||'').trim();
  for(const pre of content.querySelectorAll('pre')) {
    const code=(pre.innerText||pre.textContent||'').trimEnd();
    if(!code || text.includes('```'+code))continue;
    const index=text.indexOf(code); if(index<0)continue;
    const language=/language-([a-z0-9+#-]+)/i.exec(pre.querySelector('code')?.className||'')?.[1]||'';
    text=text.slice(0,index)+'```'+language+'\n'+code+'\n```'+text.slice(index+code.length);
  }
  const images=[...content.querySelectorAll('img')]
    .filter(im=>im.complete&&im.naturalWidth>=350&&im.naturalHeight>=350)
    .map(im=>({src:im.currentSrc||im.src,width:im.naturalWidth,height:im.naturalHeight}))
    .filter(im=>im.src);
  const article=root.closest?.('[data-turn-id],[data-testid^="conversation-turn-"]');
  const lastId=root.getAttribute?.('data-message-id') || article?.getAttribute?.('data-turn-id') || article?.getAttribute?.('data-testid') || null;
  return {count:roots.length,text,images,lastId,dom:diagnostics};
}

async function readAnswer(page) {
  return page.evaluate(snapshotGptReplyDOM).catch(()=>({
    count:0,text:'',images:[],lastId:null,dom:{evaluate_failed:true}
  }));
}

/** Sanitized browser-tab diagnostics. No URL strings, content, prompts or private cookies. */
export async function inspectGptBrowserTabs(context,activePage=null) {
  if (!context) return [];
  const pages=context.pages().slice(0,6);
  const results=[];
  for(let index=0;index<pages.length;index++) {
    const p=pages[index];
    if(p.isClosed())continue;
    const snap=await readAnswer(p);
    let location='other';
    try {
      if(stableGptUrl(p.url()))location='conversation';
      else if(new URL(p.url()).origin==='https://chatgpt.com')location='chatgpt_other';
    }catch{}
    const subframes=[];
    for(const frame of p.frames().slice(1,5)) {
      const s=await frame.evaluate(snapshotGptReplyDOM).catch(()=>null);
      subframes.push({
        reply_count:s?.count||0,
        main_markdown:s?.dom?.main_markdown||0,
        main_text_length:s?.dom?.main_text_length||0,
        body_text_length:s?.dom?.body_text_length||0,
        evaluation_failed:!s,
      });
    }
    results.push({
      index,active:p===activePage,location,
      reply_count:snap.count,
      reply_text_length:snap.text.length,
      main_present:Boolean(snap.dom?.main_present),
      main_markdown:snap.dom?.main_markdown||0,
      main_articles:snap.dom?.main_articles||0,
      main_text_length:snap.dom?.main_text_length||0,
      body_text_length:snap.dom?.body_text_length||0,
      editor_candidates:snap.dom?.editor_candidates||0,
      subframes,
    });
  }
  return results;
}

async function waitForAssistant(page,before,{image=false,onProgress=null,timeoutMs=GPT_TIMEOUT,network=null,beforeFiles=[]}={}) {
  let lastText='',lastSig='',stableAt=0,seenImageAt=0,fileOnlyAt=0;
  const started=Date.now(), end=started+timeoutMs;
  let lastDiagnosticAt=started;
  while(Date.now()<end){
    await dismissChatHistoryRateLimitDialog(page);
    // Preferred: capture the final assistant answer from the browser's own
    // response stream. This works even if ChatGPT renders no readable DOM.
    const net=network?.snapshot();
    if(!image && net?.text) {
      if(net.text!==lastText) {lastText=net.text;onProgress?.(net.text);}
      if(net.complete) return {text:net.text,images:[],source:'network'};
    }
    if(page.isClosed())throw new GatewayError(502,'gpt_browser_closed','ChatGPT tab closed unexpectedly');
    const r=await readAnswer(page);
    const isAnswer=isNewGptAnswer(before,r);
    if(isAnswer){
      if(r.text!==lastText){lastText=r.text;onProgress?.(r.text);}
      const sig=JSON.stringify({text:r.text,images:r.images});
      if(sig!==lastSig){lastSig=sig;stableAt=Date.now();}
      if(r.images.length&&!seenImageAt)seenImageAt=Date.now();
      const stop=page.locator(STOP).first();
      const stopVisible=await stop.isVisible().catch(()=>false);
      const settled=Date.now()-stableAt>3500 && !stopVisible;
      if(image&&r.images.length&&settled&&Date.now()-seenImageAt>1600)return r;
      if(!image&&r.text.trim()&&settled)return r;
      if(!image&&!r.text.trim()){
        const links=newGptLinks(beforeFiles,await gptResponseLinks(page));
        if(links.length&&!stopVisible){if(!fileOnlyAt)fileOnlyAt=Date.now();if(Date.now()-fileOnlyAt>1800)return {...r,text:''};}
        else fileOnlyAt=0;
      }
    }
    if(Date.now()-lastDiagnosticAt>=10000) {
      lastDiagnosticAt=Date.now();
      // Status only: no prompts, generated text, URLs, identifiers or secrets.
      console.warn('[GPT-REPLY-DIAGNOSTIC]',JSON.stringify({
        elapsed_seconds:Math.round((Date.now()-started)/1000),
        assistant_count:r.count,baseline_assistant_count:before.count,
        new_answer_detected:isAnswer,text_length:r.text.length,
        image_count:r.images.length,
        reply_role_nodes:r.dom?.primary||0,assistant_turn_articles:r.dom?.articles||0,
        alternate_role_nodes:r.dom?.secondary||0,
        conversation_turn_testids:r.dom?.turn_testids||0,
        main_articles:r.dom?.main_articles||0,
        main_markdown:r.dom?.main_markdown||0,
        main_present:Boolean(r.dom?.main_present),
        page_location:stableGptUrl(page.url())?'conversation':page.url().startsWith(GPT_URL)?'chatgpt_home_or_other':'not_chatgpt',
        open_browser_tabs:page.context().pages().length,
        main_text_length:r.dom?.main_text_length||0,
        iframe_count:r.dom?.iframes||0,
        detection_source:r.dom?.detection_source||'none',
        dom_evaluation_failed:Boolean(r.dom?.evaluate_failed),
        stop_button_visible:await page.locator(STOP).first().isVisible().catch(()=>false),
        network:{installed:Boolean(network?.snapshot().teeInstalled),posts:net?.networkPosts||0,chunks:net?.capturedChunks||0,events:net?.events||0,text_length:net?.text?.length||0,complete:Boolean(net?.complete),completed_bodies:net?.completedBodies||0},
        tabs:await inspectGptBrowserTabs(page.context(),page),
      }));
    }
    await page.waitForTimeout(POLL_MS);
  }
  throw new GatewayError(504,image?'gpt_no_generated_image':'gpt_response_incomplete',
    image?'ChatGPT did not show a completed generated image before timeout':'ChatGPT did not show a completed answer before timeout');
}

async function extractGeneratedImage(page,maxBytes,candidate) {
  // Re-check the image's fingerprint before reading. Never fall back to an old
  // image or a user-uploaded reference after DOM rearrangement.
  const current=await snapshotGptImages(page);
  const matched=current.candidates.find(x=>x.signature===candidate?.signature);
  if(!matched)throw new GatewayError(502,'gpt_image_changed','Generated image disappeared before extraction');
  const selected=page.locator(GPT_IMAGE_ELEMENTS).nth(matched.index);
  // Read bytes inside the browser, not with untrusted Node fetch or bearer/cookies.
  try {
    const encoded=await selected.evaluate(async(el,{limit,pixelLimit})=>{
      let blob;
      try{
        const r=await fetch(el.currentSrc||el.src);
        if(!r.ok)throw Error('HTTP read failed');
        blob=await r.blob();
      }catch{
        if(el.naturalWidth*el.naturalHeight>pixelLimit)throw Error('Canvas pixel limit');
        const canvas=document.createElement('canvas');canvas.width=el.naturalWidth;canvas.height=el.naturalHeight;
        const context=canvas.getContext('2d');context.drawImage(el,0,0);
        blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      }
      if(!blob||blob.size>limit)throw Error('Image missing or too large');
      const u8=new Uint8Array(await blob.arrayBuffer());let binary='';
      for(let i=0;i<u8.length;i+=8192)binary+=String.fromCharCode(...u8.subarray(i,i+8192));
      return btoa(binary);
    },{limit:maxBytes,pixelLimit:MAX_IMAGE_PIXELS});
    const bytes=Buffer.from(encoded,'base64');
    return {bytes,mime:validateImageBuffer(bytes,maxBytes)};
  }catch{
    // Final best-effort fallback: captures rendered image, not original pixels.
    // Never claim it preserves full resolution.
    const bytes=await selected.screenshot({type:'png',timeout:15000});
    return {bytes,mime:validateImageBuffer(bytes,maxBytes),renderedFallback:true};
  }
}

export class NativeGpt {
  #context=null;#boot=null;#serial=Promise.resolve();#conversations=new Map();#activePage=null;
  #retainedPage=null;#retainedCapture=null;#retainedConversationId=null;#conversationProjects=new Map();
  constructor(config={}) {this.config=config;this.apiKey='native-browser-session';this.maxInputBytes=config.maxInputBytes||10*1024*1024;this.maxOutputBytes=config.maxOutputBytes||20*1024*1024;this.timeoutMs=config.gptTimeoutMs||GPT_TIMEOUT;}
  get started(){return Boolean(this.#context);}
  #mappingFile(){return path.join(this.config.gptProfileDir,'.orbit-conversation-map.json');}
  async #restoreMappings(){
    try{
      const saved=JSON.parse(await readFile(this.#mappingFile(),'utf8'));
      for(const [id,value] of Object.entries(saved)){
        const url=stableGptUrl(value?.url);
        if(!url || !/^[a-f0-9-]{36}$/.test(id))continue;
        this.#conversations.set(id,url);
        if(value.projectId)this.#conversationProjects.set(id,value.projectId);
      }
      console.info('[GPT-MAPPING-RESTORE]',JSON.stringify({count:this.#conversations.size}));
    }catch(error){if(error.code!=='ENOENT')console.warn('[GPT-MAPPING-RESTORE]',String(error?.code||error?.message).slice(0,80));}
  }
  async #saveMappings(){
    const saved={};
    for(const [id,url] of this.#conversations){
      const valid=stableGptUrl(url);
      if(valid)saved[id]={url:valid,projectId:this.#conversationProjects.get(id)||null};
    }
    const tmp=this.#mappingFile()+'.tmp-'+process.pid;
    await writeFile(tmp,JSON.stringify(saved),{mode:0o600});
    await rename(tmp,this.#mappingFile());
  }
  async start(){
    if(this.#context)return;
    if(this.#boot)return this.#boot;
    this.#boot=(async()=>{
      const driver = this.config.gptDriver === 'patchright' ? 'patchright' : 'playwright';
      const {chromium}=await import(driver);
      const headless=this.config.gptHeadless !== false;
      this.#context=await chromium.launchPersistentContext(this.config.gptProfileDir,{
        headless,...(this.config.gptChannel==='chromium'?{}:{channel:this.config.gptChannel||'chrome'}),acceptDownloads:true,
        viewport:headless?{width:1330,height:960}:null,permissions:[],
      });
      if(process.env.ORBIT_TAB_POOL==='1'){
        // One persistent home tab keeps authenticated ChatGPT ready.
        // All conversation tabs are transient and reopen by saved URL.
        const pages=this.#context.pages();
        const home=pages.find(p=>p.url()==='https://chatgpt.com/')||pages[0]||await this.#context.newPage();
        for(const extra of pages){
          if(extra!==home && !extra.isClosed())await extra.close().catch(()=>{});
        }
        if(!home.isClosed() && home.url()!==GPT_URL){
          await home.goto(GPT_URL,{waitUntil:'domcontentloaded',timeout:20000}).catch(e=>
            console.warn('[GPT-HOME-TAB]',String(e?.name||'navigation_failed').slice(0,45)));
        }
        console.info('[GPT-TAB-POOL]',JSON.stringify({home_ready:!home.isClosed(),tabs:this.#context.pages().length}));
      }
    })();
    try{await this.#boot;await this.#restoreMappings();}catch(e){throw new GatewayError(503,'gpt_headless_unavailable',
      `Cannot start headless ChatGPT Chrome. Check Chrome installation/profile: ${String(e?.message||'').slice(0,230)}`);}
    finally{this.#boot=null;}
  }
  async openLoginPage(){
    await this.start();
    const page=this.#context.pages()[0] || await this.#context.newPage();
    try { await page.goto(GPT_URL,{waitUntil:'domcontentloaded',timeout:45000}); }
    catch { console.warn('ChatGPT page did not finish loading; manual navigation remains available in the virtual desktop.'); }
    return page;
  }
  async close(){const ctx=this.#context;this.#context=null;this.#retainedPage=null;this.#retainedCapture=null;this.#retainedConversationId=null;this.#activePage=null;this.#conversationProjects.clear();if(ctx)await ctx.close().catch(()=>{});}
  #runExclusive(fn){const run=this.#serial.then(fn,fn);this.#serial=run.catch(()=>{});return run;}
  async diagnostics(){
    if(!this.#context)return {worker_ready:false,tabs:[]};
    return {worker_ready:true,tabs:await inspectGptBrowserTabs(this.#context,this.#activePage)};
  }
  async inspectLastFileElements(){
    return this.#runExclusive(async()=>{
      const page=this.#retainedPage||this.#activePage;
      if(!page||page.isClosed())return {ready:false};
      return page.evaluate(()=>{
        const main=document.querySelector('main');
        if(!main)return {ready:false,reason:'no_main'};
        const selector='a[href],button,[role="button"],[tabindex],[class*="cursor-pointer"]';
        const controls=[...main.querySelectorAll(selector)];
        const candidates=[...main.querySelectorAll('*')].filter(el=>{
          const text=(el.innerText||el.textContent||'').trim();
          return text.length>0 && text.length<150 && /\.(?:csv|pdf|docx|xlsx|pptx|zip)\b/i.test(text);
        }).slice(-35);
        const describe=el=>({tag:el.tagName.toLowerCase(),
          role:el.getAttribute('role')||null,testid:(el.getAttribute('data-testid')||'').slice(0,80),
          cursor:getComputedStyle(el).cursor,classes:(el.className&&typeof el.className==='string'?el.className.split(/\s+/).filter(x=>/cursor|file|artifact|download|button/i.test(x)).slice(0,4):[]),
          parentTag:el.parentElement?.tagName.toLowerCase()||null,
          parentRole:el.parentElement?.getAttribute('role')||null,
          hasHref:el.hasAttribute('href'),hasOnClick:typeof el.onclick==='function',
          childCount:el.children.length});
        return {ready:true,mainNodes:main.querySelectorAll('*').length,controls:controls.length,anchors:main.querySelectorAll('a[href]').length,buttons:main.querySelectorAll('button').length,roleButtons:main.querySelectorAll('[role="button"]').length,matched:candidates.map(describe)};
      });
    });
  }
  async listProjects(){
    return this.#runExclusive(async()=>{
      await this.start();
      // Resolve sidebar destinations on an isolated page, never touching an active chat.
      const page=await this.#context.newPage();
      try{
        await page.goto(GPT_URL,{waitUntil:'domcontentloaded',timeout:25000});
        await page.waitForTimeout(2200);
        return await discoverProviderProjects(page,'gpt');
      }finally{await page.close().catch(()=>{});}
    });
  }
  async listProjectChats(projectId){
    validateProjectId(projectId);
    return this.#runExclusive(async()=>{
      await this.start();
      const page=await this.#context.newPage();
      try{
        await page.goto(GPT_URL,{waitUntil:'domcontentloaded',timeout:30000});
        await page.waitForTimeout(1200);
        const row=page.locator('[data-app-action-sidebar-project-id="'+projectId+'"]');
        if(!await row.waitFor({state:'attached',timeout:17000}).then(()=>true).catch(()=>false))throw new GatewayError(404,'project_not_found','ChatGPT did not show that project in the authenticated sidebar');
        if(await row.getAttribute('aria-expanded')!=='true')await row.click({timeout:6500});
        await page.waitForTimeout(900);
        return await readProjectChatLinks(page,projectId);
      }finally{await page.close().catch(()=>{});}
    });
  }
  async openProjectChat(projectId,chatUrl){
    const expected=validateProjectChatUrl(projectId,chatUrl);
    return this.#runExclusive(async()=>{
      await this.start();
      const page=await this.#context.newPage();
      try{
        await page.goto(GPT_URL,{waitUntil:'domcontentloaded',timeout:30000});
        const row=page.locator('[data-app-action-sidebar-project-id="'+projectId+'"]');
        if(!await row.waitFor({state:'attached',timeout:17000}).then(()=>true).catch(()=>false))throw new GatewayError(404,'project_not_found','ChatGPT project not found in sidebar.');
        if(await row.getAttribute('aria-expanded')!=='true')await row.click({timeout:6500});
        await page.waitForTimeout(900);
        const links=await readProjectChatLinks(page,projectId);
        if(!links.chats.some(c=>c.url===expected))throw new GatewayError(404,'project_chat_not_found','That chat was not found inside the selected project sidebar. No message was sent.');
        await page.goto(expected,{waitUntil:'domcontentloaded',timeout:35000});
        await requireLogin(page);
        if(stableGptUrl(page.url())!==expected)throw new GatewayError(503,'project_chat_navigation','Could not verify the selected project conversation. No message was sent.');
        // Existing ChatGPT threads may hydrate asynchronously; opening an Orbit handle
        // never submits a message or claims the transcript is complete.
        await page.waitForTimeout(550);
        const messages=await page.evaluate(()=>{
          const els=[...document.querySelectorAll('[data-message-author-role]')].filter(e=>e.closest('main'));
          return els.slice(-24).map(e=>({
            role:e.getAttribute('data-message-author-role'),
            text:(e.innerText||'').trim().slice(0,10000)
          })).filter(e=>['user','assistant'].includes(e.role)&&e.text);
        }).catch(()=>[]);
        const conversationId=randomUUID();
        this.#conversations.set(conversationId,expected);
        this.#conversationProjects.set(conversationId,projectId);
        return {provider:'gpt',project_id:projectId,conversation_id:conversationId,source_url:expected,messages,history_complete:false};
      }finally{await page.close().catch(()=>{});}
    });
  }
  async createProject(name){
    name=validateProjectName(name);
    return this.#runExclusive(async()=>{
      await this.start();
      const page=await this.#context.newPage();
      let submitted=false;
      try{
        await page.goto(GPT_URL,{waitUntil:'domcontentloaded',timeout:30000});
        await requireLogin(page);
        const before=await discoverProviderProjects(page,'gpt');
        if(before.projects.some(p=>p.name===name))throw new GatewayError(409,'project_name_exists','Project name already exists in your ChatGPT account.');
        const trigger=page.locator('[data-app-action-sidebar-project-create]');
        if(await trigger.count()!==1)throw new GatewayError(503,'project_create_unavailable','ChatGPT project creation control not found. Nothing was created.');
        await trigger.evaluate(el=>el.click());
        const form=page.locator('[role="dialog"] form').first();
        await form.locator('#chatgpt-project-name').fill(name,{timeout:7500});
        const submit=form.locator('button[type="submit"]').first();
        if(await submit.isDisabled())throw new GatewayError(503,'project_create_disabled','ChatGPT has disabled its project creation button. Nothing was created.');
        submitted=true;
        await submit.click({timeout:8000});
        const deadline=Date.now()+17000;
        let result=null;
        while(Date.now()<deadline){
          const found=await discoverProviderProjects(page,'gpt').catch(()=>({projects:[]}));
          result=found.projects.find(p=>p.name===name&&!before.projects.some(x=>x.id===p.id));
          if(result)break;
          await page.waitForTimeout(700);
        }
        if(!result)throw new GatewayError(504,'project_create_unconfirmed','The create action was clicked, but no new ChatGPT project could be confirmed. Refresh the projects list before trying again to avoid duplicates.');
        return {project:result,created:true,provider:'gpt'};
      }catch(error){
        if(submitted&&!(error instanceof GatewayError))throw new GatewayError(502,'project_create_uncertain','Project creation was submitted, but confirmation failed. Refresh before retrying.');
        throw error;
      }finally{await page.close().catch(()=>{});}
    });
  }
  async screenshotActiveTab(){
    if(!this.#context)throw new GatewayError(503,'gpt_not_ready','GPT browser not ready');
    const page=this.#activePage && !this.#activePage.isClosed()
      ? this.#activePage : this.#context.pages().find(p=>!p.isClosed());
    if(!page)throw new GatewayError(503,'gpt_no_open_tab','No live browser tab to capture');
    return page.screenshot({type:'png',fullPage:false,timeout:15000});
  }
  async probe(){
    // Used as a pre-dispatch check for Jobs and by auth:check:gpt.
    try { await this.start(); } catch { return false; }
    let page;
    try{page=await this.#context.newPage();await page.goto(GPT_URL,{waitUntil:'domcontentloaded',timeout:20000});await dismissChatHistoryRateLimitDialog(page);
        startChatHistoryModalWatcher(page);
        await requireLogin(page);return true;}
    catch{return false;}finally{await page?.close().catch(()=>{});}
  }
  async #execute({prompt,conversationId=null,nativeProjectId=null,imageBytes=null,inputMime=null,onProgress=null,wantImage=false}) {
    return this.#runExclusive(async()=>{
      await this.start();
      const old=conversationId?this.#conversations.get(conversationId):null;
      if(nativeProjectId&&!/^g-p-[A-Za-z0-9_-]{6,90}$/.test(nativeProjectId))throw new GatewayError(422,'invalid_native_project','Invalid ChatGPT project id. Nothing was sent.');
      const bound=conversationId?this.#conversationProjects.get(conversationId)||null:null;
      if(conversationId&&bound!==nativeProjectId)throw new GatewayError(409,'gpt_project_thread_mismatch','The conversation belongs to a different project. No message was submitted.');
      const projectUrl=nativeProjectId?'https://chatgpt.com/g/'+nativeProjectId+'/project':null;
      if(conversationId&&!old)throw new GatewayError(404,'gpt_conversation_not_found',
        'Unknown ChatGPT conversation. After restart, resend full messages without conversation_id.');
      let page=null,network=null,reused=false,retain=false,submitted=false;
      let phase='open_conversation';
      try {
        const acquired=await acquireGptConversationTab({
          context:this.#context,requestedId:conversationId,expectedUrl:old,startUrl:!old?projectUrl:null,
          retainedId:this.#retainedConversationId,retainedPage:this.#retainedPage,
          retainedCapture:this.#retainedCapture,
        });
        ({page,network,reused}=acquired);
        this.#activePage=page;
        phase='verify_chat_editor';
        await requireLogin(page);
        if(old&&stableGptUrl(page.url())!==old)
          throw new GatewayError(503,'gpt_conversation_navigation',
            'ChatGPT did not open the requested conversation. Nothing was submitted.');
        if(!old) {
          phase='prepare_new_chat';
          if(projectUrl) {
            // Project page has its own new-chat composer. Never click general New chat.
            if(page.url().split(/[?#]/)[0]!==projectUrl)throw new GatewayError(503,'gpt_project_navigation','Could not confirm the requested ChatGPT project. No prompt sent.');
            if(!await page.locator('[data-app-action-sidebar-project-id="'+nativeProjectId+'"]').count())
              throw new GatewayError(503,'gpt_project_not_visible','The selected project was not found in the authenticated sidebar. No prompt sent.');
          } else await ensureFreshChat(page);
        }
        phase='capture_existing_turn';
        const before=await readAnswer(page);
        if(imageBytes){
          phase='attach_image';
          const mime=validateImageBuffer(imageBytes,this.maxInputBytes);
          if(inputMime&&inputMime!==mime)throw new GatewayError(400,'mime_mismatch','Invalid uploaded image MIME');
          await attachGptImage(page,imageBytes,mime);
        }
        // Capture after uploading the reference, so its preview is baseline.
        const beforeImages=wantImage?await snapshotGptImages(page):null;
        const beforeFiles=wantImage?[]:await gptResponseLinks(page);
        // This is the SAME capture object as the preceding turn when we reuse
        // its page. Do not register page.exposeFunction twice on one tab.
        network.arm();
        phase='submit_message';
        await fillAndSubmit(page,prompt);
        submitted=true;
        phase='await_response';
        const answer=wantImage
          ?await waitForGptGeneratedImage(page,beforeImages,{network,timeoutMs:this.timeoutMs})
          :await waitForAssistant(page,before,{image:false,onProgress,timeoutMs:this.timeoutMs,network,beforeFiles});
        phase='resolve_conversation';
        const current=await resolveCompletedGptConversationUrl(page,network);
        let id=conversationId;
        if(!id&&current) {id=randomUUID();this.#conversations.set(id,current);this.#conversationProjects.set(id,nativeProjectId);}
        if(id&&current){
          this.#conversations.set(id,current);
          // Fail closed before releasing the page if the mapping cannot be persisted.
          await this.#saveMappings();
        }
        if(wantImage){
          phase='extract_image';
          const picture=await extractGeneratedImage(page,this.maxOutputBytes,answer.candidate);
          console.info('[GPT-IMAGE-RESULT]',JSON.stringify({
            width:answer.candidate.width,height:answer.candidate.height,
            bytes:picture.bytes.length,mime:picture.mime,
            rendered_fallback:Boolean(picture.renderedFallback),
          }));
          return {...picture,conversationId:id,text:''};
        }
        // Keep the last successfully completed ChatGPT conversation hydrated.
        // Switching conversations closes the previous retained page, with the
        // durable URL map available to reopen it on a later turn.
        if(id&&current&&this.#conversations.get(id)===current){
          const previous=this.#retainedPage;
          this.#retainedPage=page;
          this.#retainedCapture=network;
          this.#retainedConversationId=id;
          retain=true;
          if(previous&&previous!==page)await previous.close().catch(()=>{});
          console.info('[GPT-WARM-CONTINUATION]',JSON.stringify({retained:true,reused}));
        }
        let fileLinks=newGptLinks(beforeFiles,await gptResponseLinks(page));
        // Download cards may become visible after the assistant text settles.
        // Never retry sending the prompt; only inspect the completed reply.
        const expectsFile=/\b(?:file|document|download|attachment|pdf|csv|zip|docx|xlsx|pptx)\b|קובץ|להורדה|להוריד|מצורף/i.test(prompt+' '+(answer.text||''));
        if(!fileLinks.length&&expectsFile){
          const fileDeadline=Date.now()+7000;
          while(!fileLinks.length&&Date.now()<fileDeadline){
            await page.waitForTimeout(700);
            fileLinks=newGptLinks(beforeFiles,await gptResponseLinks(page));
          }
        }
        const attachments=fileLinks.length?await captureGptLinks(page,fileLinks,this.config.gptProfileDir):[];
        console.info('[GPT-FILE-E2E]',JSON.stringify({candidates:fileLinks.length,kinds:fileLinks.map(x=>x.kind||'link'),verified:attachments.length}));
        const file_warning=fileLinks.length&&!attachments.length?'File link was displayed, but no file download was verified':expectsFile&&!attachments.length?'A downloadable file was requested, but none was verified in the ChatGPT response':null;
        if(file_warning&&!answer.text?.trim())throw new GatewayError(502,'file_download_unavailable',file_warning);
        return {text:answer.text,attachments,...(file_warning?{file_warning}:{}),conversationId:id,source:answer.source||'gpt-dom'};
      }catch(error){
        // No content, prompts, URLs, conversation IDs, tokens or cookies in logs.
        console.warn('[GPT-TURN-DIAGNOSTIC]',JSON.stringify({
          phase,continuation:Boolean(conversationId),reused_tab:reused,
          submission_confirmed:submitted,error_type:String(error?.name||'Error').slice(0,50),
          error_code:error instanceof GatewayError?error.code:'unexpected_error',
          active_tab_open:Boolean(page&&!page.isClosed()),
        }));
        if(error instanceof GatewayError)throw error;
        if(error?.code==='gpt_image_render_missing'||error?.code==='gpt_image_timeout')
          throw new GatewayError(504,error.code,String(error.message).slice(0,220));
        throw new GatewayError(502,'gpt_ui_error',
          `ChatGPT failed at ${phase} (${error?.name||'Error'}). `+
          `${submitted?'Message was submitted; do not resend automatically.':'Message submission was not confirmed.'} `+
          'See [GPT-TURN-DIAGNOSTIC] in Docker logs.');
      }finally{
        network?.disarm();
        if(!retain) {
          if(reused && page===this.#retainedPage) {
            // Preserve the existing chat tab for troubleshooting and possible
            // recovery. A failed continuation must not destroy conversation state.
          } else await page?.close().catch(()=>{});
        }
        if(this.#activePage===page) this.#activePage=this.#retainedPage;
      }
    });
  }

  async chat(payload){
    const parsed=nativeChatRequest(payload,this.maxInputBytes);
    const result=await this.#execute(parsed);
    return {
      id:`chatcmpl-${randomUUID()}`,object:'chat.completion',created:Math.floor(Date.now()/1000),
      model:'gpt-web-chat',provider:'gpt',conversation_id:result.conversationId,usage:null,
      applied:{thinking_mode:'unverified',requested_thinking_mode:parsed.thinkingMode},
      attachments:result.attachments||[],...(result.file_warning?{file_warning:result.file_warning}:{}),
      choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:'stop'}],
    };
  }
  async openChatStream(payload){
    const parsed=nativeChatRequest({...payload,stream:true},this.maxInputBytes);
    const encoder=new TextEncoder();const wire=makeNativeSse();
    const body=new ReadableStream({
      start:(controller)=>{
        const push=s=>{if(s)try{controller.enqueue(encoder.encode(s));}catch{}};
        push(wire.start());
        this.#execute({...parsed,onProgress:t=>push(wire.progress(t))}).then(result=>{
          push(wire.complete(result.text,result.conversationId,result.source,result.attachments||[],result.file_warning||null));try{controller.close();}catch{}
        }).catch(error=>{push(wire.failure(error));try{controller.close();}catch{}});
      },
      cancel:()=>{/* UI turn may continue; do not automatically resubmit. */},
    });
    return new Response(body,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store'}});
  }
  async generate({prompt,n=1,aspect_ratio='auto'}){
    validateGptImageOptions({n,aspect_ratio});
    if(Number(n)!==1)throw new GatewayError(400,'gpt_native_n_unsupported','Native ChatGPT supports one image per request in v0.9');
    const requested=aspect_ratio==='auto'?'':` Use ${aspect_ratio} aspect ratio.`;
    const res=await this.#execute({prompt:`Create and output an image. ${prompt}${requested}`,wantImage:true});
    return {created:Math.floor(Date.now()/1000),provider:'gpt',
      data:[{b64_json:res.bytes.toString('base64'),mime_type:res.mime}],mime_type:res.mime,
      ...(res.renderedFallback?{quality_note:'Rendered screenshot fallback; original resolution may differ'}:{})};
  }
  async edit({prompt,imageBytes,inputMime,n=1,aspect_ratio='auto'}){
    validateGptImageOptions({n,aspect_ratio});
    if(Number(n)!==1)throw new GatewayError(400,'gpt_native_n_unsupported','Native ChatGPT supports one edited image per request in v0.9');
    const requested=aspect_ratio==='auto'?'':` Use ${aspect_ratio} aspect ratio.`;
    const res=await this.#execute({prompt:`Edit the attached image and output the edited image. ${prompt}${requested}`,imageBytes,inputMime,wantImage:true});
    return {created:Math.floor(Date.now()/1000),provider:'gpt',
      data:[{b64_json:res.bytes.toString('base64'),mime_type:res.mime}],mime_type:res.mime,
      ...(res.renderedFallback?{quality_note:'Rendered screenshot fallback; original resolution may differ'}:{})};
  }
}
