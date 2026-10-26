/* Limited ChatGPT UI modal recovery. No dialog text or message bodies are logged.
   Only a recognized, dismissible informational overlay may be closed; never
   click arbitrary Continue/Confirm/Allow buttons or dismiss login prompts. */
const NOTICE=/too many requests|too many chats|rate.limit|try again later|something went wrong|history (?:is |isn't |is not )?available|שיחות רבות מדי|יותר מדי בקשות|נסה שוב מאוחר יותר|משהו השתבש/i;
const AUTH=/log\s?in|sign\s?in|verify|verification|two.factor|2fa|authentication|התחבר|אימות|סיסמה/i;
const CLOSE=/^(?:close|dismiss|סגור|סגירה|×|✕|✖)$/i;
export function classifyGptDialog(text){const t=String(text||'').slice(0,2000);return AUTH.test(t)?'authentication':NOTICE.test(t)?'recoverable_notice':'unknown';}
export async function inspectGptDialogs(page){
 const visible=page.locator('[role="dialog"]:visible');
 const n=await visible.count().catch(()=>0);
 if(!n)return {visible_dialogs:0,dialog_type:'none'};
 const d=visible.first();
 // Used locally for classification only, not printed or persisted.
 const text=await d.innerText({timeout:1000}).catch(()=>'');
 return {visible_dialogs:n,dialog_type:classifyGptDialog(text)};
}
export async function dismissKnownGptNotice(page,{log=console}={}){
 const info=await inspectGptDialogs(page);
 if(info.dialog_type!=='recoverable_notice')return {...info,dismissed:false};
 const dialog=page.locator('[role="dialog"]:visible').first();
 const close=dialog.locator('button[aria-label="Close"],button[aria-label="Dismiss"],button[aria-label="סגור"],button[data-testid="close-button"],button[data-testid="close-modal-button"]').first();
 let candidate=close;
 if(!await candidate.isVisible().catch(()=>false))candidate=dialog.getByRole('button',{name:CLOSE}).first();
 if(!await candidate.isVisible().catch(()=>false))return {...info,dismissed:false};
 await candidate.click({timeout:3000}).catch(()=>{});
 const dismissed=(await inspectGptDialogs(page)).visible_dialogs===0;
 if(dismissed)log.info('[ORBIT-GPT-NOTICE-CLOSED]',JSON.stringify({kind:info.dialog_type}));
 return {...info,dismissed};
}
