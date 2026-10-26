/* GPT input recovery for dynamic web UI. Retries only before submit. */
import {GatewayError} from '../lib/errors.mjs';

export function visibleComposer(page, editorSelectors) {
  // Without :visible, .first() can select a stale/hidden composer retained by React.
  return page.locator(editorSelectors.join(',')).filter({visible:true}).first();
}
export async function fillGptComposer(page, editorSelectors, content, {onRetry=()=>{}}={}) {
  let lastError;
  for (let attempt=1; attempt<=3; attempt++) {
    const editor=visibleComposer(page,editorSelectors); // Re-resolve after every rerender.
    try {
      await editor.waitFor({state:'visible',timeout:attempt===1?12000:7000});
      await editor.fill(content,{timeout:attempt===1?9000:7000});
      return editor;
    } catch(error) {
      lastError=error;
      if(page.isClosed?.())break;
      if(attempt<3) {
        onRetry(attempt);
        await page.waitForTimeout(500).catch(()=>{});
      }
    }
  }
  throw new GatewayError(503,'gpt_editor_unstable',
    'The ChatGPT message editor changed or disappeared before sending. No prompt was submitted. Try a new chat after the page settles.',
    String(lastError?.name||'editor_unavailable').slice(0,70));
}
