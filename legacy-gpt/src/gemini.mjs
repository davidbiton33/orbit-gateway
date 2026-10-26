import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { reportGeminiFailure } from './diagnostics.mjs';
import { CONFIG } from './config.mjs';
import { GatewayError, classifyImageUrl, detectImageMime, validateImageBuffer } from './security.mjs';
import { attachImage, confirmAttachment } from './uploader.mjs';
import { GeminiNetworkShadow } from './gemini-network-shadow.mjs';

const COMPOSER = [
  'rich-textarea .ql-editor[contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"][aria-label*="prompt" i]',
  'textarea[aria-label*="prompt" i]',
];
const REPLY_ROOT = [
  '[id^="model-response-message-content"]',
  'model-response',
  '[data-message-author-role="model"]',
  '[data-message-author-role="assistant"]',
  'div[class*="response-container"]',
].join(',');

async function getComposer(page) {
  for (const selector of COMPOSER) {
    const candidate = page.locator(selector).first();
    try { await candidate.waitFor({state:'visible',timeout:2500}); return candidate; } catch {}
  }
  throw new GatewayError(503, 'gemini_login_or_ui_changed', 'Gemini editor is unavailable. Authenticate once or update the Gemini selectors.');
}

async function ensureSession(page) {
  const signIn = page.locator('a[href*="ServiceLogin"], button[aria-label="Sign in"], button[aria-label="כניסה"]');
  if (await signIn.count() > 0) {
    throw new GatewayError(503,'needs_login','Gemini appears signed out. Run npm run auth once to authenticate.');
  }
  await getComposer(page);
}

// Never silently append a new caller's prompt to an existing Gemini chat.
async function ensureBlankChat(page) {
  const before = await page.locator(REPLY_ROOT).count();
  if (!before) return;
  const candidates = [
    page.getByRole('button',{name:/new chat|צ[׳']אט חדש|שיחה חדשה|צ'אט חדש|שיחה חדשה|新对话/i}),
    page.getByRole('link',{name:/new chat|צ[׳']אט חדש|שיחה חדשה|צ'אט חדש|新对话/i}),
    page.locator('a[href="/app"]'),
  ];
  for (const candidate of candidates) {
    try {
      const control = candidate.first();
      if (!(await control.isVisible())) continue;
      await control.click({timeout:3000});
      await page.waitForTimeout(1500);
      if (!(await page.locator(REPLY_ROOT).count())) return;
    } catch {}
  }
  throw new GatewayError(503,'new_chat_unavailable','Gemini did not open a clean new chat. Request was not sent to protect conversation separation.');
}

async function snapshotImages(page) {
  return page.locator('img').evaluateAll((images, replySelector) =>
    images.map((img) => ({
      src: img.currentSrc || img.src || '',
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      inReply: Boolean(img.closest(replySelector)),
    })).filter(x => x.src && x.width >= 400 && x.height >= 400), REPLY_ROOT
  ).catch(() => []);
}

async function writePrompt(page, prompt) {
  const composer = await getComposer(page);
  await composer.fill(`Generate or edit an image and output the image itself. ${prompt}`);
}

async function submit(page) {
  const button = page.getByRole('button',{name:/send|submit|שלח|שליחה|发送|送信/i}).first();
  if (await button.count()) { try { await button.click({timeout:3500}); return; } catch {} }
  const editor = await getComposer(page);
  await editor.press('Enter');
}

async function waitForNewImage(page, baseline, timeoutMs) {
  const start = Date.now();
  let imageFirstSeen = 0;
  let chosen = null;
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) throw new GatewayError(503,'browser_closed','Gemini browser closed unexpectedly');
    const images = await snapshotImages(page);
    // Do not return a user's own reference upload or a sidebar image as the model output.
    const newImages = images.filter(x => !baseline.has(x.src) && x.inReply);
    const preferred = [...newImages].sort((a,b) => (Number(b.inReply)-Number(a.inReply)) || (b.width*b.height-a.width*a.height));
    if (preferred.length) {
      if (!imageFirstSeen) imageFirstSeen = Date.now();
      chosen = preferred[0];
      // Short settle time to allow Gemini to swap a placeholder for the real generated image.
      if (Date.now() - imageFirstSeen > 3500) return chosen.src;
    }
    await page.waitForTimeout(1250);
  }
  if (chosen) return chosen.src;
  throw new GatewayError(504,'no_generated_image','Gemini did not return a detectable image before timeout. It may have replied with text or changed its UI.');
}

async function fetchResultImage(page, context, rawUrl, maxBytes) {
  let next = classifyImageUrl(rawUrl);
  if (next.kind === 'data') {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/s.exec(next.url);
    if (!match || match[2].length > Math.ceil(maxBytes*4/3)+20) throw new GatewayError(502,'bad_data_image','Image data URL is invalid or too large');
    const body = Buffer.from(match[2], 'base64');
    return {bytes:body,mime:validateImageBuffer(body,maxBytes)};
  }
  if (next.kind === 'blob') {
    const base64 = await page.evaluate(async ({ url, maxBytes, replySelector }) => {
      let imageBlob;
      try {
        // Fast path: preserve the original bytes while the Blob URL is valid.
        const response = await fetch(url);
        if (!response.ok) throw new Error('Blob fetch returned an error');
        imageBlob = await response.blob();
      } catch {
        // Gemini can revoke Blob URLs while the <img> still displays the pixels.
        // Draw ONLY the exact generated image inside the model's reply.
        const image = [...document.querySelectorAll('img')].reverse().find(img =>
          img.closest(replySelector) &&
          (img.currentSrc === url || img.src === url) &&
          img.complete && img.naturalWidth > 0 && img.naturalHeight > 0
        );
        if (!image) throw new Error('Gemini Blob fetch failed and the rendered image is unavailable');
        if (image.naturalWidth * image.naturalHeight > 30_000_000) {
          throw new Error('Generated image exceeds the safe canvas pixel limit');
        }
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Cannot create a 2D canvas');
        ctx.drawImage(image, 0, 0);
        imageBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!imageBlob) throw new Error('Canvas could not export the generated image');
      }
      if (imageBlob.size > maxBytes) throw new Error('Generated image exceeds output size limit');
      const bytes = new Uint8Array(await imageBlob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return btoa(binary);
    }, { url: next.url, maxBytes, replySelector: REPLY_ROOT });

    const bytes = Buffer.from(base64, 'base64');
    return { bytes, mime: validateImageBuffer(bytes, maxBytes) };
  }
  // Follow at most three redirects manually; validate each URL before making any request.
  for (let hops=0; hops<4; hops++) {
    next = classifyImageUrl(next.url);
    if (next.kind !== 'https') throw new GatewayError(502,'unsafe_image_redirect','Unsafe image redirect');
    const response = await context.request.get(next.url,{maxRedirects:0, timeout:20000,failOnStatusCode:false});
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers()['location'];
      if (!location) throw new GatewayError(502,'bad_image_redirect','Missing image redirect URL');
      const absolute = new URL(location,next.url).href;
      next = classifyImageUrl(absolute);
      continue;
    }
    if (status !== 200) throw new GatewayError(502,'image_download_failed',`Gemini image download failed (HTTP ${status})`);
    const contentLength = Number(response.headers()['content-length'] || 0);
    if (contentLength > maxBytes) throw new GatewayError(502,'image_too_large','Generated image is too large');
    const bytes = await response.body();
    return {bytes,mime:validateImageBuffer(bytes,maxBytes)};
  }
  throw new GatewayError(502,'too_many_redirects','Generated image redirected too many times');
}


// Keep code payloads usable as Markdown for coding clients. This is extraction
// of the answer's visible DOM, not arbitrary script injection or eval from users.
const CHAT_REPLY_SELECTORS = [
  '[id^="model-response-message-content"]',
  'model-response',
  '[data-message-author-role="model"]',
  '[data-message-author-role="assistant"]',
  'div[class*="response-container"]',
];

async function replyLocator(page) {
  for (const selector of CHAT_REPLY_SELECTORS) {
    const nodes = page.locator(selector);
    if (await nodes.count() > 0) return nodes;
  }
  return page.locator(CHAT_REPLY_SELECTORS[0]);
}

async function readLatestReply(page) {
  const nodes = await replyLocator(page);
  const count = await nodes.count();
  if (!count) return {text:'',count:0};
  const root = nodes.last();
  const text = await root.evaluate(el => {
    let raw = (el.innerText || '').trim();
    for (const pre of el.querySelectorAll('pre')) {
      const code = (pre.innerText || pre.textContent || '').trimEnd();
      if (!code || raw.includes('```'+code)) continue;
      const index = raw.indexOf(code);
      if (index < 0) continue;
      const cls = pre.querySelector('code')?.className || '';
      const lang = /language-([a-zA-Z0-9+#-]+)/.exec(cls)?.[1] || '';
      raw = raw.slice(0,index) + '```' + lang + '\n' + code + '\n```' + raw.slice(index+code.length);
    }
    return raw;
  }).catch(() => '');
  return {text:text.trim(), count};
}

async function waitForReply(page,before,baselineImages,timeoutMs,onProgress=null) {
  const deadline = Date.now()+timeoutMs;
  let current = null;
  let unchangedSince = 0;
  let lastSignature = '';
  while (Date.now()<deadline) {
    if (page.isClosed()) throw new GatewayError(503,'browser_closed','Gemini closed unexpectedly');
    const reading = await readLatestReply(page);
    const novel = reading.count>before.count || (reading.text && reading.text!==before.text);
    const newImages = (await snapshotImages(page)).filter(im=>im.inReply && !baselineImages.has(im.src));
    if (novel || newImages.length) {
      const signature = `${reading.text}##${newImages.map(x=>x.src).join('|')}`;
      if (signature !== lastSignature) {lastSignature=signature;unchangedSince=Date.now();}
      const stop = page.getByRole('button',{name:/stop response|stop generating|stop output|עצור תגובה|עצור יצירה/i}).first();
      const generating = await stop.isVisible().catch(()=>false);
      current = {text:reading.text,images:newImages};
      if(onProgress) await onProgress(reading.text);
      // Avoid returning a partial code snippet when the site is streaming output.
      // Short pauses are normal during code generation. Streaming continues
      // from live DOM snapshots; wait longer before treating a quiet UI as complete.
      const settleMs = onProgress ? 6000 : 3500;
      if (!generating && Date.now()-unchangedSince>settleMs && (reading.text || newImages.length)) return current;
    }
    await page.waitForTimeout(onProgress ? 350 : 650);
  }
  // A stream must never claim successful completion just because the deadline
  // expired while partial output was visible.
  if (onProgress && (current?.text || current?.images?.length)) {
    throw new GatewayError(504,'gemini_response_incomplete','Gemini output remained incomplete at the streaming deadline.');
  }
  if (current?.text || current?.images?.length) return current;
  throw new GatewayError(504,'no_gemini_response','No Gemini response was detected. The web UI may have changed, or the model timed out.');
}

function stableGeminiConversationUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin === 'https://gemini.google.com' && /^\/app\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) return parsed.origin+parsed.pathname;
  } catch {}
  return null;
}

export class GeminiHeadless {
  #context = null;
  #page = null;
  #bootPromise = null;
  #conversations = new Map();
  #networkShadow = null;
  constructor(config = CONFIG) { this.config = config; }
  get started() { return Boolean(this.#page && !this.#page.isClosed()); }
  async start() {
    if (this.started) return;
    if (this.#bootPromise) return this.#bootPromise;
    this.#bootPromise = (async () => {
      // Explicitly headless; never attaches to a user's personal Chrome profile.
      this.#context = await chromium.launchPersistentContext(this.config.profileDir,{
        headless:true,
        ...(this.config.channel ? {channel:this.config.channel}:{}),
        acceptDownloads:false,
        permissions:[],
        viewport:{width:1280,height:900},
      });
      this.#page = this.#context.pages()[0] ?? await this.#context.newPage();
      // Opt-in passive observation; it cannot replace or delay DOM-based replies.
      this.#networkShadow = new GeminiNetworkShadow(this.#page, {enabled:Boolean(this.config.geminiNetworkShadow)});
    })();
    try { await this.#bootPromise; }
    catch (err) { await this.close(); throw new GatewayError(503,'browser_start_failed',`Headless browser failed to start: ${err.message}`); }
    finally { this.#bootPromise = null; }
  }
  async generate({prompt, imageBytes = null, inputMime = null}) {
    // A diagnostic phase is updated only after the preceding action succeeded.
    // No prompt, cookie, image bytes or page URL is recorded in diagnostic logs.
    let phase = 'start_browser';
    let page = null;
    try {
      await this.start();
      page = this.#page;
      phase = 'navigate_to_gemini';
      await page.goto(this.config.geminiUrl,{waitUntil:'domcontentloaded',timeout:35000});
      phase = 'verify_session';
      await ensureSession(page);
      phase = 'open_new_chat';
      await ensureBlankChat(page);
      if (imageBytes) {
        phase = 'validate_source_image';
        const actualMime = validateImageBuffer(imageBytes,this.config.maxInputBytes);
        if (inputMime && inputMime !== actualMime) throw new GatewayError(400,'mime_mismatch','Image content does not match the declared MIME type');
        phase = 'upload_source_image';
        const attachmentFilename = await attachImage(page,imageBytes,actualMime);
        phase = 'confirm_source_image';
        await confirmAttachment(page,attachmentFilename);
      }
      phase = 'capture_existing_images';
      const baseline = new Set((await snapshotImages(page)).map(x=>x.src));
      phase = 'write_image_prompt';
      await writePrompt(page,prompt);
      phase = 'submit_image_prompt';
      await submit(page);
      phase = 'detect_generated_image';
      const src = await waitForNewImage(page,baseline,this.config.generationTimeoutMs);
      phase = 'download_generated_image';
      const result = await fetchResultImage(page,this.#context,src,this.config.maxOutputBytes);
      return result;
    } catch (err) {
      throw await reportGeminiFailure({error:err,phase,page,operation:'image'});
    }
  }
  async chat({prompt,imageBytes=null,inputMime=null,conversationId=null,includeImages=false,onProgress=null}) {
    await this.start();
    const page = this.#page;
    const previous = conversationId ? this.#conversations.get(conversationId) : null;
    if (conversationId && !previous) {
      throw new GatewayError(404,'conversation_not_found','Conversation is unknown or was lost after gateway restart; resend full messages without conversation_id.');
    }
    try {
      await page.goto(previous || this.config.geminiUrl,{waitUntil:'domcontentloaded',timeout:35000});
      await ensureSession(page);
      if (previous && stableGeminiConversationUrl(page.url) !== previous) {
        throw new GatewayError(503,'conversation_navigation_failed','Gemini did not open the requested conversation. Request was not submitted.');
      }
      if (!previous) await ensureBlankChat(page);
      if (imageBytes) {
        const actualMime = validateImageBuffer(imageBytes,this.config.maxInputBytes);
        if (inputMime !== actualMime) throw new GatewayError(400,'mime_mismatch','Input image MIME is invalid');
        const name = await attachImage(page,imageBytes,actualMime);
        await confirmAttachment(page,name);
      }
      const before = await readLatestReply(page);
      const baselineImages = new Set((await snapshotImages(page)).map(im=>im.src));
      const composer = await getComposer(page);
      await composer.fill(prompt);
      this.#networkShadow?.begin();
      await submit(page);
      const response = await waitForReply(page,before,baselineImages,this.config.generationTimeoutMs,onProgress);
      this.#networkShadow?.finish(response.text);
      let images = [];
      if (includeImages) {
        for (const candidate of response.images.slice(0,2)) {
          try { images.push(await fetchResultImage(page,this.#context,candidate.src,this.config.maxOutputBytes)); }
          catch { /* Text reply remains available even if an optional attachment fails. */ }
        }
      }
      let url = stableGeminiConversationUrl(page.url);
      // Gemini sometimes updates /app -> /app/<id> after DOM output stabilizes.
      for (let attempt=0; !url && attempt<12; attempt++) {
        await page.waitForTimeout(450);
        url = stableGeminiConversationUrl(page.url);
      }
      let finalId = conversationId;
      if (!finalId && url) finalId = randomUUID();
      if (finalId && url) {
        if (this.#conversations.size >= 64 && !this.#conversations.has(finalId)) {
          this.#conversations.delete(this.#conversations.keys().next().value);
        }
        this.#conversations.set(finalId,url);
      }
      return {text:response.text || (response.images.length?'[Gemini returned an image]':''),conversationId:finalId || null,images};
    } catch(err) {
      this.#networkShadow?.finish('');
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(502,'gemini_ui_error',`Gemini interaction failed (${err.name ?? 'unknown'}). Check authentication or selectors.`);
    }
  }

  deleteConversation(id) {return this.#conversations.delete(id);}

  async close() {
    const c = this.#context;
    this.#context = null; this.#page = null; this.#networkShadow = null;
    if (c) { try { await c.close(); } catch {} }
  }
}
