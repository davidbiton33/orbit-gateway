/**
 * EXPERIMENTAL, opt-in Gemini network shadow. Never alters page traffic or
 * changes the DOM-based answer. Stores no prompts, URLs, cookies or response
 * bodies. Gemini uses undocumented RPC variants; unrecognized is NOT failure.
 */
import { createHash } from 'node:crypto';

const MAX_BODY = 128 * 1024;
export function isGeminiShadowEndpoint(url) {
  try {
    const u=new URL(url);
    return u.origin==='https://gemini.google.com' &&
      /(?:StreamGenerate|batchexecute|GenerateContent|BardChatUi|Assistant)/i.test(u.pathname);
  }catch{return false;}
}

/** Conservative: return text only when a response explicitly names a candidate. */
export function extractExplicitGeminiCandidate(payload) {
  if (!payload || typeof payload!=='object') return null;
  const candidates=payload.candidates ?? payload.response?.candidates;
  if (!Array.isArray(candidates) || !candidates.length)return null;
  const first=candidates[0];
  const parts=first?.content?.parts;
  if (!Array.isArray(parts))return null;
  const value=parts.map(x=>typeof x?.text==='string'?x.text:'').filter(Boolean).join('\n');
  return value && value.length<100000?value:null;
}

export class GeminiNetworkShadow {
  constructor(page, {enabled=false}={}) {
    this.page=page;this.enabled=enabled;this.active=false;this.counters=null;
    if(enabled)page.on('response',r=>this.onResponse(r).catch(()=>{}));
  }
  begin() {
    if(!this.enabled)return;
    this.active=true;
    this.counters={seen:0,completed:0,structuredCandidates:0,bodySkipped:0,match:'unknown',candidateHash:null,startedAt:Date.now()};
  }
  async onResponse(response) {
    if(!this.active || !isGeminiShadowEndpoint(response.url()))return;
    const c=this.counters;if(!c)return;
    c.seen++;
    const headers=response.headers();
    const type=headers['content-type']||'';
    const length=Number(headers['content-length']||0);
    if(!type.includes('application/json') || !length || length>MAX_BODY){c.bodySkipped++;return;}
    try {
      const body=await response.text();
      if(!this.active || c!==this.counters || body.length>MAX_BODY)return;
      c.completed++;
      const candidate=extractExplicitGeminiCandidate(JSON.parse(body));
      if(candidate) {c.structuredCandidates++;c.candidateHash=createHash('sha256').update(candidate.trim()).digest('hex');}
    }catch {/* Protocol drift, binary framing, or network errors are expected. */}
  }
  finish(finalText) {
    if(!this.enabled || !this.counters)return null;
    this.active=false;
    const c=this.counters;
    const finalHash=typeof finalText==='string' && finalText.trim()?createHash('sha256').update(finalText.trim()).digest('hex'):null;
    const report={seen:c.seen,completed:c.completed,structured_candidates:c.structuredCandidates,body_skipped:c.bodySkipped,
      comparison:c.candidateHash&&finalHash?(c.candidateHash===finalHash?'match':'different'):'unknown',
      elapsed_ms:Date.now()-c.startedAt};
    this.counters=null;
    // Metadata only; neither prompts nor generated content leave the process.
    console.info('[GEMINI-NETWORK-SHADOW]',JSON.stringify(report));
    return report;
  }
}
