/**
 * Orbit image lifecycle signal classifier, Hebrew + English.
 * Read only provider-owned answer/status elements; NEVER scan prompts, page body,
 * browser history, sidebars or credentials. Signals are clues, never proof of output.
 * The primary success condition is still a NEW, verified image element.
 */
export function normalizeImageUiText(value) {
 return String(value??'').normalize('NFKC')
   .replace(/[\u0591-\u05c7]/g,'') // Hebrew niqqud and cantillation
   .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'')
   .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
const nounEN=/^(?:images?|pictures?|photos?|illustrations?|graphics?|artworks?|visuals?|drawings?|renders?)$/;
const nounHE=/^(?:ו|ב|ל|כ)?(?:ה)?(?:תמונ(?:ה|ת|ות)|איור(?:ים|ות)?|ציור(?:ים)?|גרפיק(?:ה|ת|ות)|צילום|תצלומ(?:ים)?|דימוי(?:ים)?|ויזואל(?:י|ית)?|עיצוב(?:ים)?)$/;
const actEN=/^(?:creating|generating|rendering|drawing|painting|making|preparing|processing|crafting|producing|designing|building)$/;
const actHE=/^(?:ו|ה)?(?:יוצר(?:ת|ים|ות)?|מייצר(?:ת|ים|ות)?|מכין(?:ה|ים|ות)?|מצייר(?:ת|ים|ות)?|מעבד(?:ת|ים|ות)?|מפיק(?:ה|ים|ות)?|מרנדר(?:ת|ים|ות)?|מתחיל(?:ה|ים|ות)?|יצירת|ייצור|הכנת|יצירה|הפקת|יצירה|ליצור|לייצר|מכינה|מכינים|עובד(?:ת|ים|ות)?|מכונן)$/;
function nearby(tokens, testA, testB, gap=14) {
 const a=[],b=[];
 for(let i=0;i<tokens.length;i++){
  if(testA.test(tokens[i]))a.push(i);
  if(testB.test(tokens[i]))b.push(i);
 }
 return a.some(x=>b.some(y=>Math.abs(x-y)<=gap));
}
export function isImageFailureText(value) {
 const t=normalizeImageUiText(value);
 if(!t)return false;
 return [
  /\b(?:cannot|can t|could not|couldn t|unable|not able|not possible|failed|failure|refused|denied)\b.{0,125}\b(?:create|created|creating|generate|generated|generating|make|making|render|image|picture|photo|illustration|content|access|that)\b/,
  /\b(?:image|picture|photo|illustration|generation)\b.{0,65}\b(?:cannot|can t|could not|couldn t|failed|failure|unavailable|not available|isn t supported|not supported)\b/,
  /\b(?:don t|do not|doesn t|no longer)\b.{0,80}\b(?:access|permission|available|support|create|generate|make)\b/,
  /\b(?:something went wrong|an error occurred|generation failed|request failed|unable to access|not supported|try again later|couldn t sign in)\b/,
  /(?:לא ניתן|אי אפשר|לא אפשרי|לא הצלחתי|לא הצלחנו|לא יכול(?:ה|ים|ות)?|לא אוכל|אין (?:לי )?(?:גישה|אפשרות|יכולת|הרשאה)|אין באפשרותי|לא זמינ(?:ה|ים)?|לא נתמך|לא נתמכת|לא נוצר(?:ה)?|נכשל(?:ה)?|שגיאה|תקלה|משהו השתבש|אין לי אפשרות|אי יכולת)/,
  /(?:מצטער(?:ת)?|סליחה).{0,95}(?:לא|שגיאה|תקלה|גישה|אפשרות|יכולת|נכשל)/,
 ].some(r=>r.test(t));
}
export function isImageCompletionText(value) {
 const t=normalizeImageUiText(value);
 if(!t||isImageFailureText(t))return false;
 return [
  /\b(?:here is|here s|here are|attached is|presenting|i created|i made|i generated)\b.{0,105}\b(?:image|picture|photo|illustration|graphic|artwork)\b/,
  /\b(?:image|picture|photo|illustration|graphic|artwork)\b.{0,65}\b(?:is ready|is complete|has been created|has been generated|created successfully|generated successfully|ready to download)\b/,
  /(?:הנה|זאת|זו|מצורפ(?:ת)?|יצרתי|הכנתי|הפקתי|סיימתי ליצור).{0,90}(?:תמונ|איור|ציור|גרפיק|צילום|דימוי)/,
  /(?:תמונ|איור|ציור|גרפיק|צילום).{0,55}(?:מוכנ(?:ה|ים)?|הושלמ(?:ה|ו)?|נוצר(?:ה|ו)?|הופק(?:ה|ו)?|מוכנה להורדה)/,
 ].some(r=>r.test(t));
}
export function isImageProgressText(value) {
 const t=normalizeImageUiText(value);
 if(!t||isImageFailureText(t)||isImageCompletionText(t))return false;
 // Questions about making an image are NOT provider generation statuses.
 if(/^(?:איך|כיצד|למה|האם|מדוע|מתי|מה|how|can you|could you|would you|please explain)(?:\s|$)/.test(t))return false;
 if(/^(?:אתה|את|אתם|אתן)\s+(?:יכול|יכולה|יכולים|יכולות)(?:\s|$)/.test(t))return false;
 if([ /\b(?:your|the|an?)\b.{0,45}\b(?:image|picture|photo|illustration|graphic)\b.{0,50}\b(?:on its way|in progress|coming soon|almost ready|being (?:created|generated|rendered|drawn|prepared))\b/,
      /\b(?:working on|putting the finishing touches on)\b.{0,65}\b(?:image|picture|photo|illustration|artwork)\b/,
      /\b(?:image|picture|photo|illustration)\b.{0,65}\b(?:generation in progress|creation in progress|in progress)\b/,
      /(?:תמונ|איור|ציור|גרפיק|צילום).{0,60}(?:בדרך|בתהליך|בהכנה|ביצירה|בייצור|כמעט מוכנ|עוד רגע|בקרוב|נוצרת|מיוצרת)/,
      /(?:בתהליך|בעיצומו|עכשיו|כרגע).{0,65}(?:יצירת|הכנת|הפקת|תמונ|איור)/,
   ].some(r=>r.test(t)))return true;
 const words=t.split(' ');
 return nearby(words,actEN,nounEN)||nearby(words,actHE,nounHE);
}
/**
 * Snapshot classification is independent of exact sentence wording. Status text
 * may be transient or stale, so explicit new answer text beats an older status.
 * UI changes must not turn a text refusal into a silent 4-minute wait.
 */
export function classifyImageText(value) {
 if(isImageFailureText(value))return 'failure';
 if(isImageCompletionText(value))return 'completion';
 if(isImageProgressText(value))return 'progress';
 return 'other';
}
export class ImageProgressTracker {
 constructor({startedAt=Date.now(),plainTextGraceMs=11000,afterProgressGraceMs=30000,refusalGraceMs=1800,progressIdleMs=65000}={}){
  this.startedAt=startedAt;
  this.plainTextGraceMs=plainTextGraceMs;this.afterProgressGraceMs=afterProgressGraceMs;
  this.refusalGraceMs=refusalGraceMs;this.progressIdleMs=progressIdleMs;
  this.text='';this.textSeenAt=0;this.status='';this.statusSeenAt=0;
  this.progressEver=false;this.progressChangedAt=0;this.progressSignature='';
  this.lastPhase='submitted';
 }
 observe({now=Date.now(),imageReady=false,text='',statusText='',busy=false}={}){
  const reply=normalizeImageUiText(text),status=normalizeImageUiText(statusText);
  if(imageReady)return this.#out('image_ready',reply);
  if(reply!==this.text){this.text=reply;this.textSeenAt=reply?now:0;}
  if(status!==this.status){this.status=status;this.statusSeenAt=status?now:0;}
  const replyKind=classifyImageText(reply),statusKind=classifyImageText(status);
  // A final refusal in the new assistant reply takes precedence over a
  // stale "generating" progress indicator from the rest of the page.
  if(replyKind==='failure'&&this.textSeenAt&&now-this.textSeenAt>=this.refusalGraceMs && !busy)
    return this.#out('text_error',reply);
  if(replyKind==='completion'){
   const grace=this.progressEver?this.afterProgressGraceMs:this.plainTextGraceMs;
   if(this.textSeenAt&&now-this.textSeenAt>=grace&&!busy)return this.#out('text_only',reply);
   return this.#out('finalizing',reply);
  }
  if(statusKind==='failure'&&!reply&&this.statusSeenAt&&now-this.statusSeenAt>=this.refusalGraceMs&&!busy)
    return this.#out('text_error',status);
  // A final normal answer can beat an unchanged stale progress toast.
  if(reply&&replyKind==='other'&&this.textSeenAt&&!busy){
   const grace=(this.progressEver||statusKind==='progress')?this.afterProgressGraceMs:this.plainTextGraceMs;
   if(now-this.textSeenAt>=grace)return this.#out('text_only',reply);
  }
  const progressing=replyKind==='progress'||statusKind==='progress';
  if(progressing){
   const signature=(replyKind==='progress'?reply:'')+'|'+(statusKind==='progress'?status:'');
   if(signature!==this.progressSignature){this.progressSignature=signature;this.progressChangedAt=now;}
   this.progressEver=true;
   // A frozen status without a busy indicator is not proof that work continues.
   if(!busy&&this.progressChangedAt&&now-this.progressChangedAt>=this.progressIdleMs)
    return this.#out('stalled',reply||status);
   return this.#out('generating',reply);
  }
  if(busy)return this.#out(this.progressEver?'generating':'waiting',reply);
  if(reply&&this.textSeenAt){
   const grace=this.progressEver?this.afterProgressGraceMs:this.plainTextGraceMs;
   if(now-this.textSeenAt>=grace)return this.#out(replyKind==='failure'?'text_error':'text_only',reply);
  }
  return this.#out(this.progressEver?'finalizing':'waiting',reply);
 }
 #out(phase,text){const changed=phase!==this.lastPhase;this.lastPhase=phase;return {phase,changed,text};}
}
