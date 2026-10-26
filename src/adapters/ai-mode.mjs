import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from '../lib/errors.mjs';

// AI Mode is Search, not Gemini App. All selectors are provisional until UI smoke succeeds.
// Never return Google search snippets as if they were a generative answer.
const editorSelectors=[
 'textarea[aria-label*="Ask" i]',
 'textarea[placeholder*="Ask" i]',
 'textarea[aria-label*="שאל" i]',
 '[role="textbox"][contenteditable="true"]',
 'textarea'
].join(',');
const replySelectors=[
 '[data-testid="ai-response"]',
 '[data-testid="answer-content"]',
 '[data-attrid="wa:/description"]'
].join(',');

export async function aiModeChat(hub,request,onProgress){
 const provider='aimode';
 if(request.model||request.effort!=='auto')fail(422,'aimode_model_unverified','AI Mode model selection has not been verified');
 if(hub.locks.has(provider))fail(409,'provider_busy','AI Mode is busy');
 hub.locks.add(provider);
 let page=null,submitted=false,ownPage=false;
 try{
  const id=request.conversation_id||randomUUID();
  const previous=hub.threads.get(id);
  // Reuse Gemini's already authenticated Google account and browser profile.
  await hub.open('gemini');
  if(previous&&!previous.page.isClosed()){page=previous.page;}
  else{
   let url='https://www.google.com/ai';
   if(request.conversation_id){
    const saved=JSON.parse(await readFile(hub.threadFile,'utf8').catch(()=>'{}'));
    const info=saved[id];
    if(info?.provider!=='aimode'||!/^https:\/\/(?:www\.)?google\.com\//.test(info.url||''))
      fail(409,'conversation_not_restored','AI Mode conversation URL not available');
    url=info.url;
   }
   page=await hub.contexts.get('gemini').newPage();ownPage=true;
   await page.goto(url,{waitUntil:'domcontentloaded',timeout:55000});
  }
  if(!['google.com','www.google.com'].includes(new URL(page.url()).hostname))
   fail(503,'aimode_navigation','AI Mode did not open');
  const editor=page.locator(editorSelectors).filter({visible:true}).first();
  await editor.waitFor({state:'visible',timeout:20000}).catch(()=>fail(503,'aimode_ui_unverified','AI Mode composer unavailable; sign-in or selectors may be required'));
  // Google's AI Mode labels every generated reply with an accessible H3.
  // Read its immediate parent, not the whole Search results page or sidebar.
  const snapshot=()=>page.locator('h3').evaluateAll(nodes=>{
    const replies=nodes.filter(h=>(h.textContent||'').startsWith('AI Mode reply for'))
      .map(h=>(h.parentElement?.innerText||'').trim()).filter(Boolean);
    return replies.at(-1)||'';
  }).catch(()=>'');
  const before=await snapshot();
  const prompt=request.messages?.filter(x=>x.role==='user').at(-1)?.content;
  if(typeof prompt!=='string'||!prompt.trim())fail(400,'invalid_prompt','User message required');
  await editor.fill(prompt,{timeout:12000});
  await editor.press('Enter',{timeout:8000});
  submitted=true;
  const verificationRequired=async()=>page.frames().some(frame=>/recaptcha|google.com\/sorry/i.test(frame.url()))||
    await page.locator('iframe[src*="recaptcha"],iframe[src*="/sorry/"],#recaptcha,.g-recaptcha').count().then(n=>n>0).catch(()=>false);
  let result='',stable=0;
  const limit=Date.now()+Math.min(90000,Number(hub.config.requestTimeoutMs||240000)-10000);
  while(Date.now()<limit){
   if(await verificationRequired())fail(503,'google_verification_required','Google requires manual human verification in the AI Mode browser profile');
   const text=(await snapshot()).trim();
   if(text&&text!==before){
    if(text===result)stable++;else{result=text;stable=0;onProgress?.(text);}
    if(stable>=3)break;
   }
   await page.waitForTimeout(1200);
  }
  if(!result){
   if(await verificationRequired())fail(503,'google_verification_required','Google requires manual human verification');
   fail(503,'aimode_answer_unverified','No verified AI Mode reply found; do not retry blindly');
  }
  if(!/^https:\/\/(?:www\.)?google\.com\//.test(page.url()))fail(503,'aimode_history_unverified','AI Mode conversation URL not confirmed');
  hub.threads.set(id,{provider,page,nativeProjectId:null});ownPage=false;
  const saved=JSON.parse(await readFile(hub.threadFile,'utf8').catch(()=>'{}'));
  saved[id]={provider,url:page.url(),updated_at:new Date().toISOString()};
  await mkdir(path.dirname(hub.threadFile),{recursive:true});
  const temp=hub.threadFile+'.tmp-'+process.pid;
  await writeFile(temp,JSON.stringify(saved,null,2),{mode:0o600});await rename(temp,hub.threadFile);
  console.info('[ORBIT-AIMODE]',JSON.stringify({phase:'completed',chars:result.length}));
  return {text:result,conversation_id:id,actual_model:'google_ai_mode_auto',selection_verified:false};
 }catch(error){
  console.warn('[ORBIT-AIMODE]',JSON.stringify({phase:'failed',submitted,code:error.code||error.name}));
  throw error;
 }finally{
  if(ownPage)await page?.close().catch(()=>{});
  hub.locks.delete(provider);
 }
}
