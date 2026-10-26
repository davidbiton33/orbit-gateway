import { randomUUID } from 'node:crypto';
import { GatewayError } from './security.mjs';

function categoryOf(error) {
  const description = String(error?.message || '');
  const name = String(error?.name || '');
  if (/TimeoutError|timeout|timed out|exceeded/i.test(name+' '+description)) return 'timeout';
  if (/Target closed|page.*closed|context.*closed|browser.*closed/i.test(description)) return 'browser_closed';
  if (/detached|not attached|execution context was destroyed/i.test(description)) return 'dom_changed';
  if (/net::ERR_|navigation failed|ERR_NAME_NOT_RESOLVED/i.test(description)) return 'navigation_or_network';
  if (/fetch|HTTP \d{3}|status code/i.test(description)) return 'image_fetch_or_http';
  if (/decode|image|blob|base64|invalid URL|unsupported/i.test(description)) return 'image_processing';
  if (/strict mode violation|element is not|locator|selector/i.test(description)) return 'ui_selector';
  return 'unknown';
}

// Counts and image SOURCE TYPES only. Never serialize page content, image URLs,
// innerText, HTML, request headers, prompts, stack traces, or cookies.
export async function safeGeminiPageStats(page) {
  if (!page || page.isClosed?.()) return {page_available:false};
  try {
    return await page.evaluate(() => {
      const roots = [
        '[id^="model-response-message-content"]',
        'model-response',
        '[data-message-author-role="model"]',
        '[data-message-author-role="assistant"]',
        'div[class*="response-container"]'
      ];
      const selector = roots.join(',');
      const all = Array.from(document.querySelectorAll('img'));
      const kind = img => {
        const src = img.currentSrc || img.src || '';
        if (src.startsWith('blob:')) return 'blob';
        if (src.startsWith('data:')) return 'data';
        if (src.startsWith('https:')) return 'https';
        return 'other';
      };
      const replyImages = all.filter(img => img.closest(selector));
      return {
        page_available:true,
        reply_roots:document.querySelectorAll(selector).length,
        image_elements:all.length,
        reply_image_elements:replyImages.length,
        large_reply_images:replyImages.filter(img => img.naturalWidth >= 400 && img.naturalHeight >= 400).length,
        image_source_types:replyImages.reduce((acc,img)=>{const k=kind(img);acc[k]=(acc[k]||0)+1;return acc;},{}),
      };
    });
  } catch {
    return {page_available:false,reason:'dom_unavailable'};
  }
}

export async function reportGeminiFailure({error,phase,page,operation='image',log=console.error}) {
  const diagnosticId = randomUUID();
  const category = categoryOf(error);
  const stats = await safeGeminiPageStats(page);
  const report = {
    diagnostic_id: diagnosticId,
    operation,
    phase,
    cause_category: category,
    cause_type: /^(Error|TimeoutError|TypeError|ReferenceError|RangeError)$/.test(error?.name||'') ? error.name : 'other',
    cause_code: error instanceof GatewayError ? error.code : 'unexpected_error',
    page:stats,
  };
  log('[GEMINI-DIAGNOSTIC] '+JSON.stringify(report));
  if (error instanceof GatewayError) {
    // Preserve the original status/code/message of actionable failures.
    error.diagnosticId = diagnosticId;
    error.phase = phase;
    return error;
  }
  const wrapped = new GatewayError(502,'gemini_ui_error',
    `Gemini ${operation} failed at ${phase} (${category}). Diagnostic ID: ${diagnosticId}`);
  wrapped.diagnosticId = diagnosticId;
  wrapped.phase = phase;
  return wrapped;
}
