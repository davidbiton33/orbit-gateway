/* Detect access challenges; never automate solving them. */
import {GatewayError} from '../lib/errors.mjs';

export async function inspectGptAccessChallenge(page){
  try {
    const result=await page.evaluate(()=>{
      const title=(document.title||'').toLowerCase();
      const body=(document.body?.innerText||'').slice(0,4000).toLowerCase();
      const markup=(document.body?.outerHTML||'').slice(0,30000).toLowerCase();
      const isChallenge = title.includes('just a moment') ||
        title.includes('attention required') ||
        title.includes('verify you are human') ||
        body.includes('verify you are human') ||
        body.includes('checking your browser') ||
        markup.includes('cf-turnstile') ||
        markup.includes('challenge-platform') ||
        Boolean(document.querySelector('input[name="cf-turnstile-response"], #challenge-stage, #cf-challenge-running'));
      return {isChallenge,kind:isChallenge?'cloudflare_verification':'none'};
    });
    return result;
  } catch {return {isChallenge:false,kind:'unknown'};}
}
export async function requireGptAccess(page){
 const challenge=await inspectGptAccessChallenge(page);
 if(challenge.isChallenge) throw new GatewayError(403,'gpt_human_verification_required',
    'ChatGPT is asking for human verification in its Docker browser. The GPT Docker browser requires human verification. If the challenge repeats, use switch-gpt.ps1 -Backend legacy from the installed Orbit directory, then sign in through the Legacy noVNC address printed by the command. No prompt was submitted.');
 return challenge;
}
