/* Robust, scoped assistant response detection. Never infer answers from user bubbles or page body. */
export const GPT_ASSISTANT_FALLBACK = [
  // Current ChatGPT DIL renderer: the assistant owns this root, not the user bubble.
  'main [class*="DilResponseRoot-"]',
  'main [data-testid^="conversation-turn-"] .agent-turn',
  'main [data-testid^="conversation-turn-"].agent-turn',
  'main [data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
  'main [data-testid^="conversation-turn-"]:has(.agent-turn) .markdown',
  // Alternative modern response wrappers, still assistant-scoped (never raw page text).
  'main .agent-turn',
  'main [data-testid="assistant-message"]',
  'main [data-role="assistant"]',
  'main [data-author="assistant"]',
  'main article[data-testid*="assistant"]',
];
const clean = value => String(value ?? '').replace(/\u200b/g,'').trim();
export function chooseReply(baseline, current) {
  if (!Array.isArray(current) || !current.length) return '';
  const items = current.map(clean).filter(Boolean);
  if (!items.length) return '';
  const first = (baseline || []).map(clean).filter(Boolean);
  // New assistant bubble, or an in-place DOM update that replaces the final assistant message.
  if (items.length > first.length) return items.at(-1);
  if (items.length && items.at(-1) !== first.at(-1)) return items.at(-1);
  return '';
}
async function texts(page, selector) {
  if (!selector) return [];
  return await page.locator(selector).allTextContents().catch(() => []);
}
export async function assistantSnapshot(page, provider, pack) {
  const primary = await texts(page,pack.assistant.join(','));
  let fallback = [];
  if (provider === 'gpt') {
    // Prefer a whole assistant bubble rather than its individual Markdown fragments.
    for (const selector of GPT_ASSISTANT_FALLBACK) {
      fallback = await texts(page,selector);
      if (fallback.length) break;
    }
  }
  return {primary, fallback};
}
export function newReply(before, now) {
  // Primary provider-specific DOM role beats broad scoped Markdown fallback.
  return chooseReply(before.primary,now.primary) || chooseReply(before.fallback,now.fallback);
}
export async function browserResponseDiagnostics(page, provider, pack, initial, latest) {
  const safe = {provider,primary_before:initial.primary.length,primary_now:latest.primary.length,
    fallback_before:initial.fallback.length,fallback_now:latest.fallback.length,
    primary_last_chars:clean(latest.primary.at(-1)).length,
    fallback_last_chars:clean(latest.fallback.at(-1)).length};
  try {const url=new URL(page.url());safe.origin=url.origin;safe.pathname=url.pathname.slice(0,100);}catch{}
  try {safe.editor_visible=await page.locator(pack.editor.join(',')).first().isVisible();}catch{}
  try {safe.stop_visible=await page.locator(pack.stop.join(',')).first().isVisible();}catch{}
  try {safe.dialog_count=await page.locator('[role="dialog"]').count();}catch{}
  try {safe.visible_dialog_count=await page.locator('[role="dialog"]:visible').count();}catch{}
  try {safe.agent_turn_count=await page.locator('main .agent-turn').count();}catch{}
  try {safe.main_article_count=await page.locator('main article').count();}catch{}
  try {safe.main_markdown_count=await page.locator('main .markdown').count();}catch{}
  try {safe.conversation_turn_count=await page.locator('[data-testid^="conversation-turn-"]').count();}catch{}
  return safe;
}
