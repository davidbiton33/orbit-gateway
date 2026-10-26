/**
 * ChatGPT image-output reader for the 2026 app-shell UI.
 * The app may render images directly under <main> without assistant turns,
 * articles or markdown roots. The text DOM reader must not gate image output.
 *
 * This module never fetches remote images itself. Source URLs are compared
 * in the page only as fingerprints and are never printed to diagnostics.
 */
export const GPT_IMAGE_ELEMENTS = 'main img, [role="main"] img';

/** Serializable DOM snapshot; safe to run as page.evaluate(scanGptImageElements). */
export function scanGptImageElements(doc=globalThis.document) {
  const results=[];
  const nodes=[...doc.querySelectorAll('main img, [role="main"] img')];
  for(let index=0;index<nodes.length;index++) {
    const el=nodes[index];
    const src=String(el.currentSrc||el.src||'');
    const width=Number(el.naturalWidth||0),height=Number(el.naturalHeight||0);
    if (!el.complete || width<350 || height<350 || !src) continue;
    if (/^(?:data:image\/svg\+xml|data:image\/gif)/i.test(src) || /\.svg(?:\?|$)/i.test(src))continue;
    if(el.closest?.('form,aside,nav,header,[contenteditable="true"],[data-message-author-role="user"],[data-role="user"],[data-message-author="user"],[data-testid="composer-attachment"],[data-testid*="upload-preview"]')) continue;
    const rect=el.getBoundingClientRect?.()||{width:0,height:0};
    if(rect.width<180 || rect.height<180)continue;
    const style=doc.defaultView?.getComputedStyle?.(el);
    if(style?.display==='none' || style?.visibility==='hidden'||Number(style?.opacity)===0)continue;
    // Opaque bounded fingerprint instead of leaking authenticated image URLs.
    let hash=2166136261;
    for(let i=0;i<src.length;i++)hash=Math.imul(hash^src.charCodeAt(i),16777619)>>>0;
    results.push({index,signature:`${hash.toString(16)}:${src.length}:${width}x${height}`,
      width,height,renderedWidth:Math.round(rect.width),renderedHeight:Math.round(rect.height)});
  }
  return {examined:nodes.length,candidates:results};
}

/** Never choose an old image, including a reference image already on screen. */
export function pickNewGptImage(before,now) {
  const baseline=new Set((before?.candidates||[]).map(x=>x.signature));
  const unseen=(now?.candidates||[]).filter(x=>x?.signature && !baseline.has(x.signature));
  return unseen.at(-1)||null; // latest output, never the first old reference image
}

export async function snapshotGptImages(page) {
  return page.evaluate(scanGptImageElements).catch(()=>({examined:0,candidates:[],inspectionFailed:true}));
}

/** Poll independently of text/assistant/markdown selectors until a new image is ready. */
export async function waitForGptGeneratedImage(page,before,{
  network=null, timeoutMs=360000, pollMs=450, afterStreamGraceMs=45000,
}={}) {
  const started=Date.now();
  let completeAt=0, stableKey='',stableAt=0,lastLog=started;
  while(Date.now()-started<timeoutMs) {
    if(page.isClosed())throw new Error('GPT image tab closed');
    const net=network?.snapshot?.()||{};
    if(net.complete && !completeAt)completeAt=Date.now();
    const scan=await snapshotGptImages(page);
    const chosen=pickNewGptImage(before,scan);
    if(chosen){
      if(chosen.signature!==stableKey){stableKey=chosen.signature;stableAt=Date.now();}
      const settled=Date.now()-stableAt>=1700;
      // A DOM stop button may disappear a little after the image finishes.
      const stopVisible=await page.locator('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="עצור"]').first().isVisible().catch(()=>false);
      const streamFinished=Boolean(net.complete);
      // Without a readable SSE stream, allow a stable, fully-loaded image once
      // the website stops showing a generation-in-progress state.
      // A POST stream with unknown completion must not mistake a newly moved
      // reference attachment for the generated output. Require the stream to
      // finish whenever its completion tracking is available.
      const noNetworkCompletion=Date.now()-stableAt>=8000 && !stopVisible && !(net.networkPosts>0 && net.events>0);
      if(settled && !stopVisible && (streamFinished||noNetworkCompletion))
        return {candidate:chosen,networkComplete:streamFinished,source:'rendered_image'};
    }else {stableKey='';stableAt=0;}
    if(Date.now()-lastLog>10000){
      lastLog=Date.now();
      console.warn('[GPT-IMAGE-DIAGNOSTIC]',JSON.stringify({
        elapsed_seconds:Math.round((Date.now()-started)/1000),
        scanned_images:scan.examined||0,ready_candidates:scan.candidates?.length||0,
        new_image_detected:Boolean(chosen),network_complete:Boolean(net.complete),
        network_events:net.events||0,
      }));
    }
    // If the browser's own conversation stream has ended, don't poll for
    // six minutes when the image node never materializes.
    if(completeAt && Date.now()-completeAt>afterStreamGraceMs){
      const error=new Error('Image output was not detected after the GPT stream completed');
      error.code='gpt_image_render_missing';throw error;
    }
    await page.waitForTimeout(pollMs);
  }
  const error=new Error('GPT image not ready before timeout');
  error.code='gpt_image_timeout';throw error;
}
