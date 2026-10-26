/**
 * Ready-state gated ChatGPT submission, built for v0.9.9.4.
 * React may briefly unmount the composer or Send control during hydration.
 * We only click after the composer is visibly stable and the exact prompt is
 * still present. No blind Enter fallback and never a second click.
 * Only a confirmed conversation-history limit overlay may be dismissed.
 */
import { dismissChatHistoryRateLimitDialog } from './gpt-history-modal.mjs';

export class GptSubmitFlowError extends Error {
  constructor(code, detail, cause) {
    super(detail, cause ? {cause} : undefined);
    this.name='GptSubmitFlowError'; this.code=code;
  }
}

const EDITOR_SEL='#prompt-textarea,[data-testid="prompt-textarea"],textarea[name="prompt-textarea"],[contenteditable="true"][role="textbox"]';
const SEND_SEL=[
  'button[data-testid="send-button"]','button[data-testid="composer-submit-button"]',
  'button#composer-submit-button','button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]','button[aria-label="Send"]',
  'button[aria-label="שלח הודעה"]','button[aria-label="שלח"]',
].join(',');
const norm=s=>String(s||'').replace(/\s+/gu,' ').trim();
const sleep=(page,ms)=>page.waitForTimeout(ms);

/** Returns only boolean/geometry metadata; never logs prompt contents. */
export async function probeGptComposer(page,expectedText='') {
  return page.evaluate(({selector,expected})=>{
    const visible=el=>{
      if(!el||!(el instanceof Element))return false;
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none';
    };
    const editors=[...document.querySelectorAll(selector)].filter(visible);
    const area=editors.length===1?editors[0]:null;
    const normValue=s=>String(s||'').replace(/\s+/gu,' ').trim();
    const value=area?('value' in area?area.value:area.innerText||area.textContent||''):'';
    const r=area?.getBoundingClientRect();
    return {
      count:editors.length,editorVisible:Boolean(area),
      valuePresent:Boolean(normValue(value)),
      matches:area?normValue(value)===normValue(expected):false,
      // position deliberately coarse: no textual or personal data
      geometry:r?`${Math.round(r.width/8)*8}x${Math.round(r.height/8)*8}`:null,
      readyState:document.readyState,
    };
  },{selector:EDITOR_SEL,expected:expectedText}).catch(()=>({count:0,editorVisible:false,matches:false,probeFailed:true}));
}

/** The native selector is preferred, and never targets a global generic form submit. */
export async function findActualGptSendButton(page,area) {
  const form=area.locator('xpath=ancestor::form[1]');
  const hasForm=(await form.count().catch(()=>0))===1;
  const selectors=hasForm? `${SEND_SEL},button[type="submit"]` : SEND_SEL;
  const candidates=(hasForm?form:page).locator(selectors);
  const count=Math.min(await candidates.count().catch(()=>0),24);
  const matches=[];
  for(let i=0;i<count;i++){
    const b=candidates.nth(i);
    if(!await b.isVisible().catch(()=>false))continue;
    if(!await b.isEnabled().catch(()=>false))continue;
    if(await b.getAttribute('aria-disabled').catch(()=>null)==='true')continue;
    matches.push(b);
  }
  if(matches.length===1)return matches[0];
  if(matches.length>1)throw new GptSubmitFlowError('send_button_ambiguous','Multiple visible Send controls. Nothing clicked.');
  // A new ChatGPT build can render an unlabeled up-arrow button. Select only
  // when exactly ONE blue upward-arrow control sits at the right of the editor.
  const geometric=await page.evaluate(selector=>{
    const visible=el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return r.width>8&&r.height>8&&s.visibility!=='hidden'&&s.display!=='none';
    };
    const area=[...document.querySelectorAll(selector)].filter(visible)[0];
    if(!area)return [];
    const ar=area.getBoundingClientRect();
    return [...document.querySelectorAll('button')].flatMap((b,index)=>{
      if(b.disabled||b.getAttribute('aria-disabled')==='true'||!visible(b))return [];
      const r=b.getBoundingClientRect();
      if(r.width>70||r.height>70||r.width<22||r.height<22)return [];
      if(r.left<ar.right-115||r.right>ar.right+65||r.top<ar.top-30||r.bottom>ar.bottom+42)return [];
      const paths=[...b.querySelectorAll('svg path')].map(p=>p.getAttribute('d')||'').join(' ');
      // A recognizable upward arrow; a microphone, menu or attachment icon
      // must not be submitted as a message by accident.
      const upward=/M12\s*19\s*[Vv]\s*5|m5\s*12\s*7\s*-7\s*7\s*7|M5\s*12\s*[lL]\s*7\s*-7/i.test(paths);
      const hint=/send|submit|שלח/i.test([b.getAttribute('aria-label'),b.title,b.getAttribute('data-testid')].join(' '));
      if(!upward&&!hint)return [];
      const rgb=getComputedStyle(b).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number)||[];
      const blue=rgb.length>=3&&rgb[2]>rgb[0]*1.16&&rgb[2]>rgb[1]*1.04;
      if(!blue&&!hint)return [];
      return [index];
    });
  },EDITOR_SEL).catch(()=>[]);
  if(geometric.length===1){
    const b=page.locator('button').nth(geometric[0]);
    if(await b.isVisible().catch(()=>false)&&await b.isEnabled().catch(()=>false))return b;
  }
  if(geometric.length>1)throw new GptSubmitFlowError('send_button_ambiguous','Several unlabeled arrow controls; no click attempted.');
  throw new GptSubmitFlowError('send_button_not_ready','No enabled Send button found yet.');
}

export async function isPreparedPromptStillInComposer(page,expectedText) {
  const result=await probeGptComposer(page,expectedText);
  if(!result.editorVisible)return null;
  return result.matches;
}

async function awaitComposerAcceptance(page,text,timeoutMs=4200) {
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    const same=await isPreparedPromptStillInComposer(page,text);
    if(same===false)return true;
    await sleep(page,180);
  }
  return false;
}

async function reportFailure(page,error,phase,details) {
  const probe=await probeGptComposer(page);
  console.warn('[GPT-SEND-FLOW]',JSON.stringify({
    phase,code:error?.code||'unexpected_error',error_type:String(error?.name||'Error').slice(0,50),
    ...details,editor_present:probe.count>0,editor_visible:probe.editorVisible,
    page_ready:probe.readyState==='complete',submission_confirmed:false,
  }));
  try {
    await page.screenshot({path:'/tmp/gpt-send-flow-failure.png',timeout:4500,animations:'disabled'});
    console.warn('[GPT-SEND-SCREENSHOT]',JSON.stringify({path:'/tmp/gpt-send-flow-failure.png'}));
  }catch{}
}

/**
 * Two paths: no history modal => normal send; positively identified history
 * modal => dismiss it first, then the very same normal send. Neither path
 * submits while React is remounting the composer.
 */
export async function sendGptPromptWithModalGuard(page,text,{
  getComposer,dismissModal=dismissChatHistoryRateLimitDialog,
  verify=awaitComposerAcceptance,
  probe=probeGptComposer,
  maxWaitMs=22000,
  settleMs=900,
  pause=ms=>sleep(page,ms),
  now=()=>Date.now(),
}={}) {
  if(typeof getComposer!=='function'||typeof text!=='string'||!text.trim())
    throw new GptSubmitFlowError('invalid_submit_args','Composer provider or message missing.');
  const started=now(),end=started+maxWaitMs;
  let phase='wait_for_editor_stability',clicked=false,dismissed=false;
  let refillCount=0,stableSince=0,readySamples=0,send=null,area=null,lastModalAt=0;
  try {
    dismissed=Boolean(await dismissModal(page));
    // Stage 1: wait for a real editor to survive a window of hydration.
    let lastGeometry=null;
    while(now()<end){
      const check=await probe(page,text);
      if(check.editorVisible&&check.count===1&&check.geometry===lastGeometry){
        if(!stableSince)stableSince=now();
        readySamples++;
        if(readySamples>=3&&now()-stableSince>=settleMs)break;
      }else{stableSince=0;readySamples=0;lastGeometry=check.geometry||null;}
      if(now()-lastModalAt>=650){dismissed=Boolean(await dismissModal(page))||dismissed;lastModalAt=now();}
      await pause(180);
    }
    if(readySamples<3||now()-stableSince<settleMs)
      throw new GptSubmitFlowError('composer_not_ready','ChatGPT editor did not stabilize. No message submitted.');

    // Stage 2: fill only when composer is stable. React can still remount it,
    // in which case re-fill ONLY BEFORE any click, not after an ambiguous click.
    phase='fill_and_wait_for_send';
    let eligibleSince=0,eligibleSamples=0;
    while(now()<end){
      const state=await probe(page,text);
      if(!state.editorVisible||state.count!==1){
        eligibleSince=0;eligibleSamples=0;await pause(180);continue;
      }
      if(!state.matches){
        area=await getComposer();
        await area.fill(text,{timeout:6000});
        refillCount++;
        eligibleSince=0;eligibleSamples=0;send=null;
        await pause(220);continue;
      }
      area=await getComposer();
      try{send=await findActualGptSendButton(page,area);}
      catch(e){
        if(!(e instanceof GptSubmitFlowError)||e.code!=='send_button_not_ready')throw e;
        send=null;
      }
      if(send){
        if(!eligibleSince)eligibleSince=now();
        eligibleSamples++;
        if(eligibleSamples>=3&&now()-eligibleSince>=700)break;
      }else{eligibleSince=0;eligibleSamples=0;}
      if(now()-lastModalAt>=650){dismissed=Boolean(await dismissModal(page))||dismissed;lastModalAt=now();}
      await pause(180);
    }
    if(!send||eligibleSamples<3||now()-eligibleSince<700)
      throw new GptSubmitFlowError('send_button_not_ready','Composer/send control did not stabilize. No click attempted.');

    phase='click_send';
    const final=await probe(page,text);
    if(!final.editorVisible||!final.matches)
      throw new GptSubmitFlowError('editor_replaced_before_click','Prompt disappeared during hydration. No click attempted.');
    // One click only. Do NOT fall back to Enter or retry after ambiguous click.
    clicked=true;
    await send.click({timeout:7000});
    phase='confirm_submission';
    if(!await verify(page,text))
      throw new GptSubmitFlowError('submission_unconfirmed','Send clicked but composer did not clear. Do not resend automatically.');
    console.info('[GPT-SEND-FLOW]',JSON.stringify({path:dismissed?'history_modal_then_normal':'normal',
      clicked:true,composer_cleared:true,refill_count:refillCount,ready_wait_ms:Math.max(0,now()-started)}));
    return {path:dismissed?'history_modal_then_normal':'normal'};
  }catch(error){
    await reportFailure(page,error,phase,{modal_dismissed:dismissed,click_attempted:clicked,
      refill_count:refillCount,ready_wait_ms:Math.max(0,now()-started)});
    throw error;
  }
}
