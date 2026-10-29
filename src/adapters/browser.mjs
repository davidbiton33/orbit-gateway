/* Experimental first-party web UI adapters; no credentials or cookies are extracted.
   Each provider owns a separate persistent Chromium profile, no parallel sends per provider.
   Selector packs are versioned and overrideable in config/selectors.json. */
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {aiModeChat} from './ai-mode.mjs';
import {snapshotOutputLinks,newOutputLinks,captureOutputLinks} from './output-files.mjs';
import {convertGeminiTableToCsv} from './table-export.mjs';
import {isPdfRequest,wordPromptForPdf,convertWordArtifactToPdf} from './document-export.mjs';
// ORBIT_IMAGE_PROGRESS_V2
import {ImageProgressTracker} from './image-progress.mjs';import {GatewayError,fail} from '../lib/errors.mjs';
import {ROOT} from '../lib/config.mjs';
import {launchPersistentBrowser} from './browser-launch.mjs';
import {prepareDockerProfile} from './profile-lock.mjs';
import {assistantSnapshot,newReply,browserResponseDiagnostics} from './response-detection.mjs';
import {inspectGptDialogs,dismissKnownGptNotice} from './gpt-modal.mjs';
import {GptNetworkCapture} from './gpt-network-capture.mjs';
import {captureGptFailure} from './gpt-failure-capture.mjs';
import {visibleComposer,fillGptComposer} from './composer.mjs';
import {requireGptAccess} from './access-challenge.mjs';
import {discoverProviderProjects} from './native-projects.mjs';
const SELECTOR_FILE=path.join(ROOT,'config','selectors.json');
const WARM_TABS=process.env.ORBIT_WARM_TABS==='1'||process.env.ORBIT_CLOUD_ARM64==='1';
const URLS={aimode:'https://www.google.com/ai',gpt:'https://chatgpt.com/',gemini:'https://gemini.google.com/app'};
const packs=JSON.parse(await readFile(SELECTOR_FILE,'utf8'));
let playwrightImport;
// A dynamic import returns a Promise. Await it before reading the Chromium export.
// Browser launcher used by active providers.
export async function resolvePlaywrightChromium(importer=()=>import('playwright')){
 const module=await importer();
 if(!module?.chromium||typeof module.chromium.launchPersistentContext!=='function')
  throw new GatewayError(503,'playwright_module_invalid','Playwright chromium.launchPersistentContext export was not found. Reinstall Playwright with npm install.');
 return module.chromium;
}
async function playwright(){return resolvePlaywrightChromium(()=>playwrightImport??=import('playwright'));}
function textOf(el){return String(el?.innerText||el?.textContent||'').trim();}
export class BrowserHub {
 constructor(config){this.config=config;this.contexts=new Map();this.pages=new Map();this.threads=new Map();this.locks=new Set();this.networkCaptures=new WeakMap();this.warmPages=new Map();this.warmPromises=new Map();this.threadFile=path.join(config.dataDir,'browser-conversations.json');
  // Cloud workers eagerly hydrate one new-chat composer at startup.
  // This never runs on the front gateway or local Windows installation.
  if(process.env.ORBIT_CLOUD_ARM64==='1'&&process.env.ORBIT_EAGER_PREWARM==='1'&&['gemini'].includes(config.workerProvider))
   setImmediate(()=>{void this._warm(config.workerProvider).catch(()=>{});});
 }
 async open(provider,{login=false}={}){
  if(!URLS[provider])fail(400,'invalid_provider','Unknown provider');
  if(this.contexts.has(provider)){const p=this.pages.get(provider);if(!p?.isClosed())return p;}
  const useFirefox=provider==='aimode'&&process.env.ORBIT_AIMODE_BROWSER==='firefox';
  const dir=path.join(this.config.dataDir,'profiles',useFirefox?'aimode-firefox':provider);await mkdir(dir,{recursive:true});
  let launched;
  if(useFirefox){
   const {firefox}=await import('playwright');
   const context=await firefox.launchPersistentContext(dir,{headless:false,viewport:{width:1360,height:900},timeout:45000,acceptDownloads:true});
   launched={context,engine:'Playwright Firefox - isolated AI Mode profile',attempts:[]};
  }else{
   const chromium=await playwright();
   await prepareDockerProfile(dir,provider);
   const browserChannel=this.config.browserChannel;
   launched=await launchPersistentBrowser(chromium,dir,{browserChannel:process.env.ORBIT_CLOUD_ARM64==='1'?'chromium':browserChannel,headless:(this.config.browserHeadless)&&!login});
  }
  const context=launched.context;
  console.log('[BROWSER-LAUNCH]',JSON.stringify({provider,engine:launched.engine,fallback_used:launched.attempts.length>0}));
  context.on('close',()=>{if(this.contexts.get(provider)===context){this.contexts.delete(provider);this.pages.delete(provider);}});
  this.contexts.set(provider,context);
  const existing=context.pages();
  const page=existing.find(x=>x.url().startsWith(new URL(URLS[provider]).origin))||existing[0]||await context.newPage();
  // Oracle workers are dedicated automation profiles: old restored tabs are not needed.
  if(process.env.ORBIT_CLOUD_ARM64==='1'){
    for(const extra of existing){
      if(extra!==page && !extra.isClosed())await extra.close().catch(()=>{});
    }
  }
  this.pages.set(provider,page);
  if(login||!page.url().startsWith(new URL(URLS[provider]).origin))await page.goto(URLS[provider],{waitUntil:'domcontentloaded',timeout:60000});
  return page;
 }
 async _warm(provider){
  if(!WARM_TABS||!['gemini'].includes(provider))return;
  const current=this.warmPages.get(provider);
  if(current&&!current.isClosed())return;
  if(this.warmPromises.has(provider))return this.warmPromises.get(provider);
  const work=(async()=>{
   let page;
   try{
    await this.open(provider);
    page=await this.contexts.get(provider).newPage();
    await page.goto(URLS[provider],{waitUntil:'domcontentloaded',timeout:45000});
    await page.locator(packs[provider].editor.join(',')).filter({visible:true}).first().waitFor({state:'visible',timeout:25000});
    this.warmPages.set(provider,page);
    console.info('[ORBIT-WARM-TAB]',JSON.stringify({provider,ready:true}));
   }catch(e){
    await page?.close().catch(()=>{});
    console.warn('[ORBIT-WARM-TAB]',JSON.stringify({provider,ready:false,reason:String(e?.name||'error')}));
   }
  })().finally(()=>this.warmPromises.delete(provider));
  this.warmPromises.set(provider,work);
  return work;
 }
 async _restore(id,provider){try{const stored=JSON.parse(await readFile(this.threadFile,'utf8'));const item=stored[id];if(!item||item.provider!==provider||new URL(item.url).origin!==new URL(URLS[provider]).origin)return null;await this.open(provider);const page=await this.contexts.get(provider).newPage();await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:55000});this.threads.set(id,{provider,page,nativeProjectId:item.native_project_id||null});return page;}catch{return null;}}
 async _store(id,provider,page,nativeProjectId=null){try{const saved=JSON.parse(await readFile(this.threadFile,'utf8').catch(()=>'{}'));const url=page.url();if(new URL(url).origin!==new URL(URLS[provider]).origin)return;saved[id]={provider,url,native_project_id:nativeProjectId||null,updated_at:new Date().toISOString()};await mkdir(path.dirname(this.threadFile),{recursive:true});const tmp=this.threadFile+'.tmp-'+process.pid;await writeFile(tmp,JSON.stringify(saved,null,2),{mode:0o600});await rename(tmp,this.threadFile);return true;}catch(e){console.warn('Could not persist browser conversation metadata:',e.code||e.message);}}
 async close(){await Promise.allSettled([...this.contexts.values()].map(x=>x.close()));}
 async listNativeProjects(provider){
  if(!['gpt','gemini'].includes(provider))fail(400,'invalid_provider','Unsupported project provider');
  if(this.locks.has(provider))fail(409,'provider_busy','Provider is busy; retry project refresh later');
  this.locks.add(provider);
  let page;
  try{
    await this.open(provider);
    page=await this.contexts.get(provider).newPage();
    const url=provider==='gemini'?'https://gemini.google.com/app':'https://chatgpt.com/';
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    if(provider==='gemini')await page.locator('#sidenav-section-content-notebooks a[href^="/notebook/"]').first().waitFor({state:'attached',timeout:15000}).catch(()=>{});
    else await page.waitForTimeout(1800);
    const found=await discoverProviderProjects(page,provider);
    if(provider==='gemini'&&!found.projects.length){found.diagnostic=await page.evaluate(()=>({path:location.pathname,notebookAnchors:document.querySelectorAll('a[href^="/notebook/"]').length,section:!!document.querySelector('#sidenav-section-content-notebooks'),totalAnchors:document.querySelectorAll('a[href]').length,sidebarButtons:[...document.querySelectorAll('button')].filter(e=>(e.getAttribute('aria-label')||'').includes('sidebar')).map(e=>e.getAttribute('aria-label')).slice(0,5)})).catch(()=>null);}
    return found;
  }finally{
    await page?.close().catch(()=>{});
    this.locks.delete(provider);
  }
 }
 async probe(provider){const p=this.pages.get(provider);if(!p||p.isClosed())return {provider,connected:false,status:'needs_browser_start'};
   const pack=packs[provider];const editor=await p.locator(pack.editor.join(',')).first().isVisible().catch(()=>false);
   return {provider,connected:true,editor_ready:editor,url_category:p.url().startsWith(new URL(URLS[provider]).origin)?'provider':'other',status:editor?'ready':'login_or_ui_changed'};
 }
 async choose(page,provider,model,effort){
   const pack=packs[provider];
   if(model){
     const label=pack.modelLabels?.[model];if(!label)fail(422,'model_unverified',`No selector pack verified for ${model}`);
     const picker=page.locator(pack.modelPicker.join(',')).filter({visible:true}).first();
     if(!await picker.isVisible().catch(()=>false))fail(422,'model_picker_missing','Model picker was not found. No prompt sent.');
     await picker.click({timeout:4000});
     const item=page.getByRole('menuitem',{name:label,exact:true}).or(page.getByRole('option',{name:label,exact:true})).first();
     if(!await item.isVisible().catch(()=>false)){await page.keyboard.press('Escape').catch(()=>{});fail(422,'model_not_in_menu',`${model} was not in the live model menu. No prompt sent.`);}
     await item.click({timeout:4000});
     const selected=await page.locator(pack.modelPicker.join(',')).allTextContents().catch(()=>[]);
     if(!selected.some(s=>s.toLowerCase().includes(label.toLowerCase()))){fail(422,'model_selection_unverified','Model selector did not confirm the choice. No prompt sent.');}
   }
   if(effort!=='auto')fail(422,'effort_unverified','Thinking effort cannot yet be confirmed for this browser interface. No prompt sent.');
 }
 async _aiModeImage(request){
  if(request.mode!=='generate')fail(501,'aimode_image_edit_unimplemented','AI Mode image editing is not supported');
  if(request.model)fail(422,'aimode_image_model_unverified','Use google-ai-mode default model');
  const ratio=request.aspect_ratio||'auto';
  if(!['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3'].includes(ratio))
   fail(422,'invalid_aspect_ratio','Unsupported image aspect ratio');
  if(this.locks.has('gemini')||this.locks.has('aimode'))fail(409,'provider_busy','Google Gemini browser is busy');
  this.locks.add('aimode');this.locks.add('gemini');
  const started=Date.now();
  let page,submitted=false;
  try{
   await this.open('gemini');
   page=await this.contexts.get('gemini').newPage();
   await page.goto('https://www.google.com/ai',{waitUntil:'domcontentloaded',timeout:55000});
   const editor=page.locator('textarea[aria-label*="Ask" i],textarea[placeholder*="Ask" i],[role="textbox"][contenteditable="true"],textarea').filter({visible:true}).first();
   await editor.waitFor({state:'visible',timeout:25000});
   const before=await page.locator('h3').evaluateAll(nodes=>nodes.filter(h=>(h.textContent||'').startsWith('AI Mode reply for')).length).catch(()=>0);
   const prompt='Create an image'+(ratio==='auto'?'':' with aspect ratio '+ratio)+': '+request.prompt;
   await editor.fill(prompt,{timeout:12000});
   await editor.press('Enter',{timeout:10000});
   submitted=true;
   console.info('[ORBIT-AIMODE-IMAGE]',JSON.stringify({phase:'submitted',elapsed_ms:Date.now()-started}));
   const deadline=Date.now()+Math.min(Math.max(90000,Number(this.config.requestTimeoutMs||240000)-15000),240000);
   let found=null,images=[];
   const lifecycle=new ImageProgressTracker({startedAt:Date.now()});
   while(Date.now()<deadline){
    const state=await page.evaluate(()=>{
      const replies=[...document.querySelectorAll('h3')].filter(h=>(h.textContent||'').startsWith('AI Mode reply for'));
      const heading=replies.at(-1);
      let scope=heading?.parentElement;
      // The reply heading is followed by the generated content within the same answer container.
      const candidates=scope?[...scope.querySelectorAll('img')]:[];
       const scopeText=(heading?.parentElement?.innerText||'').replace(heading?.innerText||'','').trim();
       // Transient generation status can appear BEFORE the first reply heading.
       // Inspect accessible status elements only, never the whole page or prompt.
       const statusText=[...document.querySelectorAll('[role="status"],[role="progressbar"],[aria-live],[aria-busy="true"]')].slice(-24).map(el=>(el.getAttribute('aria-label')||el.innerText||'').slice(0,140)).filter(Boolean).join(' ');
       return {replies:replies.length,answerText:scopeText,statusText,images:candidates.filter(i=>i.complete&&i.naturalWidth>=384&&i.naturalHeight>=384).map(i=>({src:(i.currentSrc||i.src||''),w:i.naturalWidth,h:i.naturalHeight}))};
    }).catch(()=>({replies:0,images:[]}));
    images=state.images;
    const newReplySeen=state.replies>before;
    const verdict=lifecycle.observe({
      now:Date.now(),imageReady:newReplySeen&&images.length>0,
      text:newReplySeen?state.answerText:'',statusText:state.statusText
    });
    if(verdict.changed)console.info('[ORBIT-IMAGE-STATE]',JSON.stringify({provider:'aimode',state:verdict.phase}));
    if(verdict.phase==='image_ready'){found=images.sort((a,b)=>b.w*b.h-a.w*a.h)[0];break;}
    if(verdict.phase==='text_error'||verdict.phase==='text_only'||verdict.phase==='stalled')
      fail(502,verdict.phase==='stalled'?'image_generation_stalled':'image_provider_text_reply','Google AI Mode did not produce an image: '+verdict.text.slice(0,180));
    await page.waitForTimeout(1800);
   }
   if(!found){
     const diag=await page.evaluate(()=>{
       const replies=[...document.querySelectorAll('h3')].filter(h=>(h.textContent||'').startsWith('AI Mode reply for'));
       const heading=replies.at(-1);
       const sizes=[...document.images].filter(i=>i.complete).map(i=>({w:i.naturalWidth,h:i.naturalHeight,cls:String(i.className||'').slice(0,60)})).filter(i=>i.w>=250||i.h>=250).slice(0,12);
       return {replyCount:replies.length,pathname:location.pathname,udm:new URL(location.href).searchParams.get('udm'),images:sizes,answerLength:(heading?.parentElement?.innerText||'').length};
     }).catch(()=>({failed:true}));
     console.warn('[ORBIT-AIMODE-IMAGE]',JSON.stringify({phase:'not_detected',diag}));
     fail(504,'aimode_image_not_detected','AI Mode did not display a verified generated image before timeout; do not retry blindly');
   }
   const target=page.locator('h3').filter({hasText:/^AI Mode reply for/}).last().locator('..').locator('img');
   let element=null;
   for(let i=0,n=await target.count();i<n;i++){
     const loc=target.nth(i);
     const matches=await loc.evaluate((img,src)=>(img.currentSrc||img.src)===src,found.src).catch(()=>false);
     if(matches){element=loc;break;}
   }
   if(!element)fail(502,'aimode_image_disappeared','AI Mode image disappeared before extraction');
   // Screenshot precisely the generated image element rather than surrounding Search UI.
   const bytes=await element.screenshot({type:'png',timeout:25000});
   if(bytes.length<1000||bytes.length>12000000||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
     fail(502,'aimode_image_invalid','Generated image pixels could not be extracted');
   console.info('[ORBIT-AIMODE-IMAGE]',JSON.stringify({phase:'completed',elapsed_ms:Date.now()-started,bytes:bytes.length}));
   return {created:Math.floor(Date.now()/1000),provider:'aimode',mime_type:'image/png',data:[{b64_json:bytes.toString('base64')}]};
  }catch(e){console.warn('[ORBIT-AIMODE-IMAGE]',JSON.stringify({phase:'failed',submitted,code:e.code||e.name}));throw e;}
  finally{await page?.close().catch(()=>{});this.locks.delete('aimode');this.locks.delete('gemini');}
 }
 async image(provider,request){
  if(provider==='aimode')return this._aiModeImage(request);

  if(provider!=='gemini')fail(422,'image_not_supported','Image generation is unavailable for this browser provider');
  if(request.mode!=='generate')fail(501,'gemini_edit_unimplemented','Gemini image editing is not yet implemented in this browser worker');
  if(request.model)fail(422,'image_model_unverified','Use model gemini for web image generation');
  const ratio=request.aspect_ratio||'auto';
  if(!['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3'].includes(ratio))
    fail(422,'invalid_aspect_ratio','Unsupported aspect ratio');
  if(this.locks.has(provider))fail(409,'provider_busy','Provider is busy');
  this.locks.add(provider);
  let page;
  let submitted=false;
  const begun=Date.now();
  try{
   await this.open(provider);
   page=await this.contexts.get(provider).newPage();
   await page.goto(URLS[provider],{waitUntil:'domcontentloaded',timeout:55000});
   const editor=page.locator(packs.gemini.editor.join(',')).filter({visible:true}).first();
   await editor.waitFor({state:'visible',timeout:35000});
   const selector='model-response img, [id^="model-response-message-content"] img, [data-test-id="model-response"] img';
   const snapshot=async()=>page.locator(selector).evaluateAll(images=>images.filter(im=>im.complete&&im.naturalWidth>=400&&im.naturalHeight>=400).map(im=>({src:im.currentSrc||im.src,w:im.naturalWidth,h:im.naturalHeight}))).catch(()=>[]);
   const before=new Set((await snapshot()).map(i=>i.src));
   const initialText=await assistantSnapshot(page,provider,packs.gemini);
   const lifecycle=new ImageProgressTracker({startedAt:Date.now()});
   await editor.fill('Create image. '+(ratio==='auto'?'':'Use '+ratio+' aspect ratio. ')+request.prompt,{timeout:12000});
   const send=page.locator(packs.gemini.send.join(',')).filter({visible:true}).first();
   if(await send.isVisible().catch(()=>false))await send.click({timeout:9000});
   else await editor.press('Enter',{timeout:9000});
   submitted=true;
   console.info('[ORBIT-IMAGE]',JSON.stringify({provider,phase:'submitted',elapsed_ms:Date.now()-begun}));
   const deadline=Date.now()+Math.max(90000,Math.min(Number(this.config.requestTimeoutMs||240000)-10000,300000));
   let candidate=null,seenAt=0;
   while(Date.now()<deadline){
    const images=(await snapshot()).filter(i=>!before.has(i.src));
     if(images.length){
      candidate=images.sort((a,b)=>b.w*b.h-a.w*a.h)[0];
      if(!seenAt)seenAt=Date.now();
     }
     // Only provider-owned response/status nodes; never scan the user's prompt.
     const answer=newReply(initialText,await assistantSnapshot(page,provider,packs.gemini));
     const statusText=await page.locator('[role="status"],[role="progressbar"],[aria-live],[aria-busy="true"]').evaluateAll(nodes=>nodes.slice(-24).map(n=>(n.getAttribute('aria-label')||n.innerText||'').slice(0,140)).filter(Boolean).join(' ')).catch(()=>'');
     const busy=await page.locator(packs.gemini.stop.join(',')).first().isVisible().catch(()=>false);
     const verdict=lifecycle.observe({now:Date.now(),imageReady:Boolean(candidate),text:answer,statusText,busy});
     if(verdict.changed)console.info('[ORBIT-IMAGE-STATE]',JSON.stringify({provider:'gemini',state:verdict.phase}));
     if(verdict.phase==='image_ready'&&Date.now()-seenAt>=3500)break;
     if(verdict.phase==='text_error'||verdict.phase==='text_only'||verdict.phase==='stalled')
       fail(502,verdict.phase==='stalled'?'image_generation_stalled':'image_provider_text_reply','Gemini did not produce an image: '+verdict.text.slice(0,180));
     await page.waitForTimeout(1000);
   }
   if(!candidate)fail(504,'gemini_image_not_detected','Gemini did not render a generated image before timeout. Prompt may have been submitted; do not retry blindly');
   const image=page.locator(selector).filter({visible:true}).filter({hasNot:page.locator('img img')}).first();
   // Prefer the actual generated image bytes. The screenshot fallback renders
   // only the model's generated image element, never the whole conversation.
   let bytes;
   try{
    const data=await page.evaluate(async src=>{
     const el=[...document.querySelectorAll('model-response img, [id^="model-response-message-content"] img, [data-test-id="model-response"] img')].find(i=>(i.currentSrc||i.src)===src);
     if(!el)throw Error('Image element disappeared');
     const res=await fetch(src);
     const blob=await res.blob();
     if(!blob.type.startsWith('image/')||blob.size>12000000)throw Error('Invalid image bytes');
     const buffer=await blob.arrayBuffer();
     return [...new Uint8Array(buffer)];
    },candidate.src);
    bytes=Buffer.from(data);
   }catch{
    const selected=page.locator(selector).filter({visible:true});
    const count=await selected.count();let found=null;
    for(let i=0;i<count;i++){
      const el=selected.nth(i);
      if(await el.evaluate((im,src)=>(im.currentSrc||im.src)===src,candidate.src).catch(()=>false)){found=el;break;}
    }
    if(!found)fail(502,'gemini_image_disappeared','Generated image is no longer available in Gemini');
    bytes=await found.screenshot({type:'png',timeout:18000});
   }
   if(bytes.length>12000000||bytes.length<1000)fail(502,'gemini_image_invalid','Generated image content size is invalid');
   const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
   const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
   const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
   if(!png&&!jpeg&&!webp)fail(502,'gemini_image_invalid','Generated image format is not supported');
   console.info('[ORBIT-IMAGE]',JSON.stringify({provider,phase:'completed',elapsed_ms:Date.now()-begun,bytes:bytes.length}));
   return {created:Math.floor(Date.now()/1000),provider:'gemini',mime_type:png?'image/png':jpeg?'image/jpeg':'image/webp',data:[{b64_json:bytes.toString('base64')}]};
  }catch(e){
   console.warn('[ORBIT-IMAGE]',JSON.stringify({provider,phase:'failed',submitted,code:e.code||e.name}));
   throw e;
  }finally{
   await page?.close().catch(()=>{});
   this.locks.delete(provider);
   if(WARM_TABS)void this._warm(provider).catch(()=>{});
  }
 }
 async send(provider,request,onProgress){
  if(provider==='aimode')return aiModeChat(this,request,onProgress);
  if(this.locks.has(provider))fail(409,'provider_busy','Another request is already using this provider');
  this.locks.add(provider);
  try{return await this._send(provider,request,onProgress);}finally{
   this.locks.delete(provider);
   // Prepare next new-chat composer after work completes, without delaying response.
   if(WARM_TABS&&['gemini'].includes(provider))
    void this._warm(provider).catch(()=>{});
  }
 }
 async _send(provider,{messages,model,effort='auto',conversation_id,native_project_id=null,timeoutMs=180000},onProgress){
  const pack=packs[provider];
  if(native_project_id)fail(422,'native_project_unverified','Native project unavailable for this browser provider');
  let page;let stage='start';let promptSubmitted=false;let network=null;
  const timing={started:performance.now(),navigation_done:null,editor_ready:null,submitted:null};
  const perf=(phase,extra={})=>console.info('[ORBIT-COMPOSER-PERF]',JSON.stringify({
   provider,phase,continuation:Boolean(conversation_id),
   elapsed_ms:Math.round(performance.now()-timing.started),...extra
  }));
  const report=(label,extra={})=>{if(provider==='gpt')console.info('[ORBIT-GPT-STAGE]',JSON.stringify({stage:label,...extra}));};
  report('start',{continuation:Boolean(conversation_id)});
  try{
  stage='open_or_restore';
  if(conversation_id){let thread=this.threads.get(conversation_id);if(!thread||thread.provider!==provider||thread.page.isClosed()){const restored=await this._restore(conversation_id,provider);if(restored)thread=this.threads.get(conversation_id);}if(!thread||thread.provider!==provider||thread.page.isClosed())fail(409,'conversation_not_restored','Conversation not available in this browser profile; no message was sent.');page=thread.page;}
  else{
   // Use a previously hydrated composer, never a conversation page.
   await this.open(provider);
   if(WARM_TABS&&['gemini'].includes(provider)){
    await this.warmPromises.get(provider);
    const warm=this.warmPages.get(provider);
    if(warm&&!warm.isClosed()){
     this.warmPages.delete(provider);page=warm;
     console.info('[ORBIT-WARM-TAB]',JSON.stringify({provider,reused:true}));
    }
   }
   if(!page){
    page=await this.contexts.get(provider).newPage();
    await page.goto(URLS[provider],{waitUntil:'domcontentloaded',timeout:55000});
   }
  }
  timing.navigation_done=performance.now();perf('page_ready');
  if(provider==='gpt'){
    try{
      network=this.networkCaptures.get(page);
      if(!network){network=new GptNetworkCapture(page);await network.install();this.networkCaptures.set(page,network);}
      await network.prime();
    }catch(e){
      console.warn('[ORBIT-GPT-NETWORK]',JSON.stringify({status:'capture_unavailable',code:e?.code||e?.name||'unknown'}));
      network=null; // Existing DOM path stays functional even if the passive observer cannot initialize.
    }
  }
  // This read is independent of editor hydration and model selection.
  // Start it early, then await before filling the prompt: never arm detection late.
  const baselinePromise=assistantSnapshot(page,provider,pack);
   const filesBeforePromise=snapshotOutputLinks(page,provider);
  stage='await_editor';report(stage,{host:(()=>{try{return new URL(page.url()).hostname;}catch{return 'unknown';}})()});
  if(provider==='gpt')await requireGptAccess(page);
  const editor=provider==='gpt'?visibleComposer(page,pack.editor):page.locator(pack.editor.join(',')).filter({visible:true}).first();
  if(!await editor.waitFor({state:'visible',timeout:22000}).then(()=>true).catch(()=>false)){
    if(provider==='gpt')await requireGptAccess(page);
    fail(503,'login_or_selector_changed','Sign in to '+provider+' or update the selector pack; editor was not found');
  }
  timing.editor_ready=performance.now();perf('composer_visible',{post_navigation_ms:Math.round(timing.editor_ready-timing.navigation_done)});
  if(provider==='gpt'){
    const modal=await inspectGptDialogs(page);
    if(modal.visible_dialogs)report('dialog_before_send',modal);
    if(modal.dialog_type==='recoverable_notice')await dismissKnownGptNotice(page);
  }
  stage='verify_model';await this.choose(page,provider,model,effort);
  perf('model_verified');
  const user=messages.filter(m=>m.role==='user').at(-1);if(!user||typeof user.content!=='string')fail(400,'missing_user_content','Last user message must be plain text');
  stage='baseline_snapshot';const before=await baselinePromise;
   const filesBefore=await filesBeforePromise;
  perf('baseline_ready',{assistant_count:before.primary.length});
  if(network)network.arm(); // Arm before clicking Send; observe this turn only.
  stage='fill_editor';
  if(provider==='gpt')await requireGptAccess(page);
  const needsPdfConversion=provider==='gemini'&&isPdfRequest(user.content);
  const outboundPrompt=needsPdfConversion?wordPromptForPdf(user.content):user.content;
  const activeEditor=provider==='gpt' ? await fillGptComposer(page,pack.editor,outboundPrompt,{onRetry:attempt=>report('editor_retry',{attempt})}) : editor;
  if(provider!=='gpt')await activeEditor.fill(outboundPrompt,{timeout:9000});
  perf('composer_filled',{prompt_chars:user.content.length});
  // Inspect once before submit. If the send button is absent, Enter is the
  // existing provider fallback. Never retry clicking after an ambiguous send.
  const send=page.locator(pack.send.join(',')).filter({visible:true}).first();
  const buttonVisible=await send.isVisible().catch(()=>false);
  perf('send_control_checked',{button_visible:buttonVisible});
  stage='submit_prompt';
  if(buttonVisible)await send.click({timeout:5000});else await activeEditor.press('Enter',{timeout:5000});
  // Playwright returned from the one permitted submit attempt. No blind retry.
  promptSubmitted=true;timing.submitted=performance.now();
  perf('click_returned',{method:buttonVisible?'button':'enter'});
  perf('submitted',{composer_to_send_ms:Math.round(timing.submitted-timing.editor_ready)});
  stage='await_response';report(stage,{submitted:true,baseline_primary:before.primary.length,baseline_fallback:before.fallback.length});
  const threadId=conversation_id||randomUUID();this.threads.set(threadId,{provider,page,nativeProjectId:native_project_id||null});
  const start=Date.now();let last='',stable=0,lastDiagnosticsAt=0,latest=before,noticeChecked=false,lastEmitted='';
   let fileStable=0,fileSignature='';
  while(Date.now()-start<timeoutMs){
    latest=await assistantSnapshot(page,provider,pack);
    const domReply=newReply(before,latest);
    const netState=network?.snapshot();
    // Only a final assistant message from the browser's own authenticated SSE
    // may substitute for a missing DOM reply. Never use page body/user text.
    const networkReply=netState?.complete && netState?.text ? netState.text : '';
    const reply=networkReply||domReply;
    // Stream observed assistant text without claiming completion. The gateway
    // handles revised snapshots and will only send DONE after verified completion.
    if(reply && reply!==lastEmitted){
      lastEmitted=reply;
      onProgress?.(reply);
    }
    const busy=await page.locator(pack.stop.join(',')).first().isVisible().catch(()=>false);
     const fileLinks=newOutputLinks(filesBefore,await snapshotOutputLinks(page,provider));
     const signature=fileLinks.map(x=>x.kind==='button'?'button:'+x.index+':'+x.filename:'link:'+x.href).join('|');
     if(signature&&signature===fileSignature)fileStable++;else fileStable=0;
     fileSignature=signature;
    if(reply && reply===last)stable++;else stable=0;
    last=reply;
    if((last&&((networkReply&&netState?.complete)||(stable>=3&&!busy)))||(fileLinks.length&&fileStable>=3&&!busy)){
       const attachments=fileLinks.length?await captureOutputLinks(page,provider,fileLinks,this.config):[];
       if(needsPdfConversion){
        const word=attachments.find(file=>String(file.filename||'').toLowerCase().endsWith('.docx'));
        if(word){
         try{
          const pdf=await convertWordArtifactToPdf({artifact:word,config:this.config,prompt:user.content});
          attachments.splice(0,attachments.length,pdf);
         }catch(error){
          console.warn('[ORBIT-PDF]',JSON.stringify({provider,phase:'docx_to_pdf_failed',code:error?.code||error?.name||'unknown'}));
         }
        }
       }
       if(provider==='gemini'&&!attachments.length&&!needsPdfConversion){
        // A Gemini Markdown/HTML table is not a native provider attachment.
        // Convert only on an explicit CSV-file request, preserving source metadata.
        try{
         const converted=await convertGeminiTableToCsv({page,reply:last,prompt:user.content,config:this.config});
         if(converted)attachments.push(converted);
        }catch(e){console.warn('[ORBIT-FILE]',JSON.stringify({provider,phase:'table_conversion_failed',code:e?.code||e?.name||'unknown'}));}
       }
       const fileRequested=/(?:\b(?:create|generate|make|save|attach|download)\b.{0,110}\b(?:file|csv|pdf|docx|xlsx|pptx|zip)\b|\b(?:csv|pdf|docx|xlsx|pptx|zip)\b.{0,110}\b(?:file|download|attachment)\b|(?:צור|תיצור|הכן|תכין).{0,90}קובץ|קובץ.{0,70}(?:להורדה|מצורף))/i.test(user.content);
       const file_warning=needsPdfConversion&&!attachments.some(x=>String(x.filename||'').toLowerCase().endsWith('.pdf'))?'PDF could not be verified; Gemini Word export or local conversion was unavailable':fileLinks.length&&!attachments.length?'A document link was shown but no downloadable file could be verified':fileRequested&&!attachments.length?'A downloadable file was requested but none was verified in the provider response':null;
       if(file_warning&&!last.trim())fail(502,'file_download_unavailable',file_warning);
       if(file_warning)console.warn('[ORBIT-FILE]',JSON.stringify({provider,phase:'unverified_link',count:fileLinks.length}));
      if(provider==='gemini' && /^sorry[,!]?\s+something went wrong\.?\s*(?:please try (?:your request )?again\.?\s*)?$/i.test(last.trim()))
        fail(502,'provider_ui_error','Gemini reported an error instead of an assistant response; the request may have been submitted, do not retry blindly.');
      perf('completed',{generation_ms:Math.round(performance.now()-timing.submitted)});
      stage='persist_thread';const persisted=await this._store(threadId,provider,page,native_project_id);report('completed',{reply_chars:last.length,source:networkReply?'gpt_passive_network':'dom',elapsed_ms:Date.now()-start});
      // Keep only the latest completed chat hot for fast follow-up; preserve disk mapping.
      if(persisted&&WARM_TABS&&['gemini'].includes(provider)){
       for(const [oldId,thread] of this.threads){
        if(oldId===threadId||thread.provider!==provider)continue;
        this.threads.delete(oldId);
        if(thread.page!==page)await thread.page?.close().catch(()=>{});
       }
      }else if(persisted && provider!=='gpt' && page && !page.isClosed()){
       await page.close().catch(()=>{});this.threads.delete(threadId);
      }
      return {text:last,attachments,...(file_warning?{file_warning}:{}),conversation_id:threadId,actual_model:model||'browser_default',selection_verified:Boolean(model)};}
    const elapsed=Date.now()-start;
    // A transient rate/history notice may cover the entire conversation even though
    // the prompt was submitted. Dismiss only a *recognized* closeable notice once.
    if(provider==='gpt' && !noticeChecked && elapsed>=8000 && !last && !busy){
      noticeChecked=true;
      const m=await inspectGptDialogs(page);
      console.info('[ORBIT-GPT-DIALOG]',JSON.stringify(m));
      if(m.dialog_type==='recoverable_notice')await dismissKnownGptNotice(page);
    }
    if(provider==='gpt' && elapsed-lastDiagnosticsAt>=15000){
      lastDiagnosticsAt=elapsed;
      const d=await browserResponseDiagnostics(page,provider,pack,before,latest);
      const net=network?.snapshot();
      console.warn('[ORBIT-RESPONSE-WAIT]',JSON.stringify({elapsed_ms:elapsed,reply_chars:last.length,busy,...d,network_posts:net?.networkPosts??0,network_chunks:net?.capturedChunks??0,network_events:net?.events??0,network_complete:net?.complete??false,network_text_chars:net?.text?.length??0,network_tee:net?.teeInstalled??false}));
      // Fast failure only if ChatGPT appears idle and has provided no detectable reply.
      // Do NOT retransmit the prompt: the website might already have accepted it.
      if(elapsed>=90000 && !busy && !last){
        const out=await captureGptFailure(page,this.config.dataDir,network?.snapshot());
        console.warn('[ORBIT-GPT-CAPTURE]',JSON.stringify(out));
        fail(504,'gpt_response_not_detected','GPT may have accepted the prompt but neither DOM nor passive network confirmed a final assistant reply after 90 seconds. Inspect logs and local screenshot. Do not retry blindly.');
      }
    }
    await page.waitForTimeout(700);
  }
  if(provider==='gpt')console.warn('[ORBIT-RESPONSE-TIMEOUT]',JSON.stringify(await browserResponseDiagnostics(page,provider,pack,before,latest)));
  fail(504,'response_not_detected','Browser response was not detected or completed. Check provider UI and update selector pack; do not blindly retry because a message may have been sent.');
  }catch(e){
    if(provider==='gpt'){
      if(page&&!page.isClosed()&&!promptSubmitted){const out=await captureGptFailure(page,this.config.dataDir,network?.snapshot());console.warn('[ORBIT-GPT-PRESEND-CAPTURE]',JSON.stringify(out));}
      const diagnostic={stage,prompt_submitted:promptSubmitted,code:String(e?.code||e?.name||'unknown').slice(0,70),status:Number(e?.status||500)};
      if(page&&!page.isClosed()){
        try{const u=new URL(page.url());diagnostic.host=u.hostname;diagnostic.route=u.pathname.slice(0,80);}catch{}
        try{diagnostic.editor_visible=await page.locator(pack.editor.join(',')).first().isVisible();}catch{}
        try{diagnostic.dialog_count=await page.locator('[role=dialog]').count();}catch{}
        try{diagnostic.assistant_count=await page.locator(pack.assistant.join(',')).count();}catch{}
      }
      console.error('[ORBIT-GPT-FAIL]',JSON.stringify(diagnostic));
    }
    throw e;
  }finally{
    if(network)network.disarm();
  }
 }
}
export async function loginBrowser(provider,config){const hub=new BrowserHub(config);const p=await hub.open(provider,{login:true});
 console.log(`\nSign in to ${provider} in the Chromium window. Profile will be saved locally.`);
 console.log('After login is complete, return here and press Enter.');
 const {createInterface}=await import('node:readline/promises');const rl=createInterface({input:process.stdin,output:process.stdout});await rl.question('Press Enter after login...');rl.close();console.log('Browser status:',await hub.probe(provider));await hub.close();}
