import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG, ROOT, assertConfigured } from './config.mjs';
import { GatewayError, SerialQueue, authorize, validateImageBuffer, validateOptions, validateOrigin, validatePrompt } from './security.mjs';
import { GeminiHeadless } from './gemini.mjs';
import { parseChatRequest, chatResponse } from './chat.mjs';
import { resolveProvider, modelsList } from './providers.mjs';
import { NativeGpt } from './gpt-native.mjs';
import { DockerGptClient } from './gpt-docker-client.mjs';
import { GeminiSseWriter, streamHeaders } from './streaming.mjs';
import { JobManager, validateWebhookConfig, validatePriority, validateIdempotencyKey } from './jobs.mjs';
import { validateJobBody, validateCompareBody, createJobRunner } from './job-runner.mjs';

assertConfigured();
const app = Fastify({logger:{level:'warn'},bodyLimit:CONFIG.maxJsonBodyBytes,requestTimeout:615000,trustProxy:false});
await app.register(multipart,{limits:{files:1,fields:10, parts:12, fileSize:CONFIG.maxInputBytes},throwFileSizeLimit:true});
const browser = new GeminiHeadless(CONFIG);
const queue = new SerialQueue(CONFIG.maxQueue);
const gpt = CONFIG.gptBackend==='docker' ? new DockerGptClient(CONFIG) : new NativeGpt(CONFIG);

app.addHook('onRequest',async(req,reply)=>{
  reply.header('X-Content-Type-Options','nosniff');
  reply.header('Referrer-Policy','no-referrer');
  reply.header('Cache-Control','no-store');
  reply.header('X-Frame-Options','DENY');
  reply.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if(req.url.startsWith('/v1/')) {
    validateOrigin(req.headers.origin,CONFIG.allowedOrigins);
    authorize(req.headers.authorization,CONFIG.token);
  }
});

app.setErrorHandler((err,req,reply)=>{
  if (err instanceof GatewayError) return reply.status(err.status).send({error:{code:err.code,message:err.message,...(err.diagnosticId?{diagnostic_id:err.diagnosticId,phase:err.phase}:{})}});
  if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || err?.statusCode === 413) {
    return reply.status(413).send({error:{code:'image_limit',message:'Upload is too large'}});
  }
  req.log.error({err},'Request failed');
  return reply.status(500).send({error:{code:'internal_error',message:'The gateway encountered an internal error'}});
});

app.get('/',async(_req,reply)=>{
  reply.header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  reply.type('text/html; charset=utf-8');
  return fs.readFile(path.join(ROOT,'public/index.html'));
});
app.get('/healthz',()=>({status:'ok',headless:true}));
app.get('/v1/status',async()=>({
  ready:browser.started,headless:true,streaming:{gemini:'dom-snapshots-or-best-effort-deltas',gpt:'headless-dom-snapshots-and-deltas'},
  models:modelsList().map(item=>item.id),
  providers:{
    gemini:{ready:browser.started,engine:'headless-chromium'},
    gpt:{configured:true,ready:gpt.started,engine:CONFIG.gptBackend==='docker'?'own-docker-headful-xvfb':'native-headless-chrome',profile:'isolated'},
  },
  jobs:{active:jobs.activeCount(),stored:jobs.jobs.size,retention_hours:CONFIG.jobsTtlHours,queue:jobs.queueStatus()},
  ...queue.status,
}));
app.get('/v1/models',()=>({object:'list',data:modelsList()}));

async function processRequest(params) {
  const {provider}=resolveProvider(params,'image');
  const prompt=validatePrompt(params.prompt);
  if(provider==='gemini') {
    validateOptions(params);
    if(params.aspect_ratio && params.aspect_ratio!=='auto') throw new GatewayError(400,'unsupported_aspect_ratio','Gemini web gateway does not support explicit aspect ratio');
    return queue.run(async()=>{
      const {bytes,mime} = await browser.generate({prompt,imageBytes:params.imageBytes,inputMime:params.inputMime});
      return {created:Math.floor(Date.now()/1000),provider:'gemini',data:[{b64_json:bytes.toString('base64')}],mime_type:mime};
    });
  }
  if(params.imageBytes) return gpt.edit({prompt,imageBytes:params.imageBytes,inputMime:params.inputMime,n:params.n||1,aspect_ratio:params.aspect_ratio||'1:1'});
  return gpt.generate({prompt,n:params.n||1,aspect_ratio:params.aspect_ratio||'1:1'});
}

// v0.7 jobs are persisted locally. Requests are intentionally NOT written to disk.
const jobs=new JobManager({
  dir:CONFIG.jobsDir,
  runner:createJobRunner({browser,queue,gpt,processImage:processRequest,maxInputBytes:CONFIG.maxInputBytes}),
  maxActive:CONFIG.jobsMaxActive,
  maxConcurrent:CONFIG.jobsMaxConcurrent,
  providerLimits:{gemini:CONFIG.jobsGeminiConcurrent,gpt:CONFIG.jobsGptConcurrent},
  retryLimit:CONFIG.jobsRetryLimit,agingMs:CONFIG.jobsPriorityAgingMs,
  ttlMs:CONFIG.jobsTtlHours*3600000,
  webhook:validateWebhookConfig({url:CONFIG.jobsWebhookUrl,host:CONFIG.jobsWebhookHost,secret:CONFIG.jobsWebhookSecret}),
});
await jobs.init();
const pruneTimer=setInterval(()=>void jobs.prune().catch(()=>{}),60*60*1000);
pruneTimer.unref?.();

function requestKey(req){
  const header=validateIdempotencyKey(req.headers['idempotency-key']);
  const body=validateIdempotencyKey(req.body?.idempotency_key);
  if(header&&body&&header!==body)throw new GatewayError(400,'idempotency_key_mismatch','Header and body Idempotency-Key differ');
  return header||body||null;
}
app.get('/v1/queue',async()=>jobs.queueStatus());
app.post('/v1/queue/pause',async(req)=>jobs.pause(req.body?.provider??'all'));
app.post('/v1/queue/resume',async(req)=>jobs.resume(req.body?.provider??'all'));
app.post('/v1/jobs',async(req,reply)=>{
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new GatewayError(415,'content_type','Expected JSON');
  const spec=validateJobBody(req.body,{maxInputBytes:CONFIG.maxInputBytes});
  const job=await jobs.create({...spec,priority:validatePriority(req.body.priority??'normal'),idempotencyKey:requestKey(req)});
  return reply.status(job.reused?200:202).header('Location',`/v1/jobs/${job.id}`).send({job,...job,links:{status:`/v1/jobs/${job.id}`,events:`/v1/jobs/${job.id}/events`,result:`/v1/jobs/${job.id}/result`}});
});
app.post('/v1/compare',async(req,reply)=>{
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new GatewayError(415,'content_type','Expected application/json');
  const spec=validateCompareBody(req.body,{maxInputBytes:CONFIG.maxInputBytes});
  const comparison=await jobs.createComparison({...spec,idempotencyKey:requestKey(req)});
  return reply.status(comparison.reused?200:202).header('Location',`/v1/compare/${comparison.id}`).send(comparison);
});
app.get('/v1/comparisons',async()=>({data:jobs.listComparisons()}));
app.get('/v1/compare/:id',async(req)=>jobs.comparison(req.params.id));
app.get('/v1/jobs',async()=>({data:jobs.list()}));
app.get('/v1/jobs/:id',async(req)=>jobs.getMeta(req.params.id));
app.get('/v1/jobs/:id/result',async(req)=>jobs.result(req.params.id));
app.delete('/v1/jobs/:id',async(req)=>jobs.cancel(req.params.id));
app.get('/v1/jobs/:id/events',async(req,reply)=>{
  const cursor=String(req.headers['last-event-id']||req.query?.after||'0');
  if(!/^(0|[1-9]\d{0,15})$/.test(cursor))throw new GatewayError(400,'invalid_cursor','Invalid event cursor');
  const after=Number(cursor);
  // Check before hijacking so invalid IDs and cursors are normal JSON errors.
  jobs.replay(req.params.id,after);
  reply.hijack();streamHeaders(reply.raw);
  let lastSent=after,closed=false;
  const send=(entry)=>{
    if(closed||reply.raw.destroyed||entry.id<=lastSent)return;
    lastSent=entry.id;
    reply.raw.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
    if(['job.completed','job.failed','job.cancelled','job.interrupted'].includes(entry.event))close();
  };
  const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);unsubscribe();if(!reply.raw.destroyed)reply.raw.end();};
  // Subscribe BEFORE replay: no events can fall between snapshot and subscription.
  const unsubscribe=jobs.subscribe(req.params.id,send);
  const heartbeat=setInterval(()=>{if(!closed&&!reply.raw.destroyed)reply.raw.write(': heartbeat\n\n');},12000);
  heartbeat.unref?.();
  reply.raw.once('close',close);
  const replay=jobs.replay(req.params.id,after);
  if(replay.reset)reply.raw.write(`event: job.reset\ndata: ${JSON.stringify(replay.reset)}\n\n`);
  for(const entry of replay.events){if(closed)break;send(entry);}
  if(replay.terminal&&!closed)close();
  return reply;
});

app.post('/v1/chat/completions',async(req,reply)=>{
  if(req.headers['content-type']?.split(';')[0] !== 'application/json') throw new GatewayError(415,'content_type','Expected application/json');
  const {provider,model}=resolveProvider(req.body,'chat');
  const streaming=req.body?.stream===true;
  if(provider==='gpt') {
    if(!streaming)return gpt.chat(req.body);
    // Native GPT emits its own SSE from live DOM snapshots; it is not a token API.
    const upstream=await gpt.openChatStream(req.body);
    reply.hijack();
    streamHeaders(reply.raw);
    try {
      let bytes=0;
      for await(const fragment of upstream.body) {
        if(reply.raw.destroyed) {await upstream.body?.cancel?.().catch(()=>{}); break;}
        bytes+=fragment.byteLength;
        if(bytes>32*1024*1024) throw new GatewayError(502,'gpt_stream_limit','Upstream GPT stream exceeded limit');
        reply.raw.write(fragment);
      }
    } catch(error) {
      if(!reply.raw.destroyed) {
        reply.raw.write(`event: gateway.error\ndata: ${JSON.stringify({error:{code:error.code||'gpt_stream_failed',message:'Native GPT streaming was interrupted'}})}\n\n`);
        reply.raw.write('data: [DONE]\n\n');
      }
    } finally {if(!reply.raw.destroyed) reply.raw.end();}
    return reply;
  }
  if(req.body.thinking_mode) throw new GatewayError(400,'unsupported_thinking_mode','thinking_mode is supported only by GPT');
  const input=parseChatRequest(req.body,{maxInputBytes:CONFIG.maxInputBytes});
  if(!streaming) return queue.run(async()=>({...chatResponse(await browser.chat(input)),provider:'gemini'}));
  // Reliable UI rendering: stream_mode=snapshots sends a complete, replaceable
  // view of each observed DOM state. stream_mode=deltas sends OpenAI-style SSE
  // and is best effort if the website retrospectively rewrites prior text.
  reply.hijack();
  const writer=new GeminiSseWriter(reply.raw,{model,mode:req.body.stream_mode||'deltas'});
  writer.status('queued');
  try {
    const response=await queue.run(async()=>{
      writer.status('running');
      return browser.chat({...input,onProgress:(text)=>writer.snapshot(text)});
    });
    writer.finish(response);
  } catch(error) {writer.error(error);}
  return reply;
});

app.delete('/v1/conversations/:id',async(req)=>{
  if (!/^[a-f0-9-]{36}$/.test(req.params.id)) throw new GatewayError(400,'invalid_conversation_id','Invalid conversation ID');
  // ChatGPT and Gemini maintain distinct in-memory conversation maps.
  // Legacy delete route currently clears only Gemini; no cross-provider deletion.
  return {deleted:browser.deleteConversation(req.params.id),provider:'gemini'};
});

app.post('/v1/images/generations',async(req)=>{
  if(req.headers['content-type']?.split(';')[0] !== 'application/json') throw new GatewayError(415,'content_type','Expected application/json');
  const body = req.body;
  if(!body || typeof body!=='object' || Array.isArray(body)) throw new GatewayError(400,'invalid_request','Invalid JSON body');
  return processRequest(body);
});
app.post('/v1/images/edits',async(req)=>{
  if(!req.isMultipart()) throw new GatewayError(415,'content_type','Expected multipart/form-data');
  const fields = {};
  let imageBytes = null, inputMime = null;
  for await (const part of req.parts()) {
    if(part.type === 'file') {
      if(imageBytes) throw new GatewayError(400,'too_many_images','Only one image can be uploaded');
      imageBytes = await part.toBuffer();
      inputMime = part.mimetype;
    } else {
      if (['provider','prompt','model','n','response_format','aspect_ratio'].includes(part.fieldname)) {
        fields[part.fieldname] = String(part.value);
      }
    }
  }
  if(!imageBytes) throw new GatewayError(400,'missing_image','Required image file is missing');
  const actualMime=validateImageBuffer(imageBytes,CONFIG.maxInputBytes);
  if(inputMime !== actualMime) throw new GatewayError(400,'mime_mismatch','Input image MIME must match actual bytes');
  return processRequest({...fields,imageBytes,inputMime});
});

const shutdown = async()=> {clearInterval(pruneTimer); try {await browser.close();await gpt.close();await app.close();jobs.close();} finally {process.exit(0);} };
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
try {
  await app.listen({host:CONFIG.hostname,port:CONFIG.port});
  console.log(`Unified AI Gateway (Gemini + GPT): http://${CONFIG.hostname}:${CONFIG.port}`);
  console.log(CONFIG.gptBackend==='docker'?'GPT: OWN Docker worker, headful Chrome under Xvfb; use npm run setup:gpt:docker and docker compose.':'GPT: native isolated Chrome profile; run npm run auth:gpt once to log in.');
  console.log('Gemini: Headless Chromium. GPT: '+(CONFIG.gptBackend==='docker'?'Xvfb virtual desktop':'Headless Chrome')+'. No desktop window.');
} catch(err) {
  console.error(`Gateway startup failed: ${err.message}`);
  process.exit(1);
}
