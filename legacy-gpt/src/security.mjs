import crypto from 'node:crypto';
import net from 'node:net';

export class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function tokenMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authorize(header, expected) {
  const match = /^Bearer (\S+)$/i.exec(header ?? '');
  if (!match || !tokenMatches(match[1], expected)) throw new GatewayError(401, 'unauthorized', 'Missing or invalid Bearer token');
}

export function validateOrigin(origin, allowedOrigins = []) {
  if (!origin) return; // CLI requests have no Origin
  let url;
  try { url = new URL(origin); } catch { throw new GatewayError(403, 'forbidden_origin', 'Invalid request Origin'); }
  const localOrigin = url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname) && url.port === '4981' && url.pathname === '/';
  const explicitOrigin = allowedOrigins.includes(url.origin) && url.pathname === '/';
  if (!localOrigin && !explicitOrigin) {
    throw new GatewayError(403, 'forbidden_origin', 'Origin is not allowed');
  }
}

const IMAGE_HOSTS = new Set(['gemini.google.com', 'lh3.googleusercontent.com']);
export function isAllowedImageHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return IMAGE_HOSTS.has(h) || h.endsWith('.googleusercontent.com') || h.endsWith('.gstatic.com');
}

export function classifyImageUrl(input) {
  if (typeof input !== 'string') throw new GatewayError(502, 'unsafe_image_url', 'Invalid image URL');
  if (input.startsWith('data:image/')) {
    if (input.length > 28 * 1024 * 1024) throw new GatewayError(502,'image_too_large','Data image URL is too large');
    return {kind: 'data', url: input};
  }
  if (input.length > 25000) throw new GatewayError(502, 'unsafe_image_url', 'Invalid image URL');
  if (input.startsWith('blob:')) {
    let origin;
    try { origin = new URL(input.slice(5)); } catch { throw new GatewayError(502, 'unsafe_image_url', 'Invalid blob URL'); }
    if (origin.protocol !== 'https:' || origin.origin !== 'https://gemini.google.com') {
      throw new GatewayError(502, 'unsafe_image_url', 'Blob URL origin is not Gemini');
    }
    return {kind: 'blob', url: input};
  }
  let parsed;
  try { parsed = new URL(input); } catch { throw new GatewayError(502, 'unsafe_image_url', 'Image URL could not be parsed'); }
  if (parsed.protocol !== 'https:' || !isAllowedImageHost(parsed.hostname) || parsed.username || parsed.password || parsed.port || net.isIP(parsed.hostname)) {
    throw new GatewayError(502, 'unsafe_image_url', 'Image URL host is not allowed');
  }
  return {kind: 'https', url: parsed.toString()};
}

export function detectImageMime(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii',0,4) === 'RIFF' && buf.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return null;
}

export function validateImageBuffer(buf, maxBytes) {
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > maxBytes) throw new GatewayError(413,'image_limit','Image is missing or too large');
  const mime = detectImageMime(buf);
  if (!mime) throw new GatewayError(400, 'invalid_image', 'Expected PNG, JPEG or WebP bytes');
  return mime;
}

export function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw new GatewayError(400, 'invalid_prompt', 'Prompt length must be between 1 and 12000 characters');
  return value.trim();
}

export function validateOptions({model, n, response_format} = {}) {
  if (model !== undefined && model !== 'gemini-web-image') throw new GatewayError(400,'unsupported_model','Only gemini-web-image is available');
  if (n !== undefined && Number(n) !== 1) throw new GatewayError(400,'unsupported_n','Only n=1 is supported');
  if (response_format !== undefined && response_format !== 'b64_json') throw new GatewayError(400,'unsupported_format','Only b64_json is supported');
}

export class SerialQueue {
  #tail = Promise.resolve(); #waiting = 0; #active = false;
  constructor(maxWaiting = 4) { this.maxWaiting = maxWaiting; }
  get status() { return {busy:this.#active, queued:this.#waiting}; }
  async run(fn) {
    if (this.#waiting >= this.maxWaiting) throw new GatewayError(429,'queue_full','Gateway is busy');
    this.#waiting++;
    let release;
    const gate = new Promise(r => { release = r; });
    const previous = this.#tail;
    this.#tail = gate;
    await previous;
    this.#waiting--;
    this.#active = true;
    try { return await fn(); }
    finally { this.#active = false; release(); }
  }
}
