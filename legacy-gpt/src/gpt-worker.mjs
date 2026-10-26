/** Standalone OWN ChatGPT browser worker, private to Docker Compose. */
import Fastify from 'fastify';
import { NativeGpt } from './gpt-native.mjs';
import { GatewayError, authorize, validateImageBuffer } from './security.mjs';

const token=process.env.GATEWAY_TOKEN||'';
if(token.length<43)throw new Error('GATEWAY_TOKEN must be 43+ characters');
const native=new NativeGpt({
  gptProfileDir:'/home/pwuser/profile',gptChannel:process.env.GPT_BROWSER_CHANNEL||'chrome',gptDriver:'patchright',gptHeadless:false,
  gptTimeoutMs:Math.min(Math.max(Number(process.env.GPT_GENERATION_TIMEOUT_MS)||360000,20000),600000),
  maxInputBytes:10*1024*1024,maxOutputBytes:20*1024*1024,
});
const app=Fastify({logger:{level:'warn'},bodyLimit:15*1024*1024,requestTimeout:615000,trustProxy:false});
app.addHook('onRequest',async(req,reply)=>{
  reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');
  if(req.headers.origin)throw new GatewayError(403,'forbidden_origin','Browser cross-origin requests are forbidden');
  authorize(req.headers.authorization,token);
});
app.setErrorHandler((err,req,reply)=>{
  if(err instanceof GatewayError)return reply.status(err.status).send({error:{code:err.code,message:err.message}});
  req.log.error({name:err?.name,code:err?.code},'GPT worker failure');
  return reply.status(500).send({error:{code:'internal_error',message:'GPT worker internal error'}});
});
app.get('/health',async()=>({alive:true,worker:'native-gpt-docker',display:'xvfb',session_in_docker:true}));
app.post('/session',async()=>({editor_ready:await native.probe()}));
// Read-only project link discovery from the user's already authenticated browser.
app.get('/projects',async()=>native.listProjects());
app.get('/projects/:projectId/chats',async req=>native.listProjectChats(req.params.projectId));
app.post('/projects/chats/open',async req=>native.openProjectChat(req.body?.project_id,req.body?.chat_url));
app.post('/projects/create',async req=>native.createProject(req.body?.name));
// Protected diagnostics only; screenshot is never logged or persisted by the worker.
app.post('/diagnostics',async()=>native.diagnostics());
app.post('/diagnostics/screenshot',async(req,reply)=>{
  const png=await native.screenshotActiveTab();
  reply.header('Content-Type','image/png');
  reply.header('Content-Disposition','attachment; filename="gpt-active-tab.png"');
  return reply.send(png);
});
app.post('/chat',async(req)=>native.chat(req.body));
app.post('/chat/stream',async(req,reply)=>{
  const response=await native.openChatStream(req.body);
  reply.hijack();
  reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
  try {for await(const chunk of response.body){if(reply.raw.destroyed)break;reply.raw.write(chunk);}}
  catch {if(!reply.raw.destroyed)reply.raw.write('event: gateway.error\ndata: {"error":{"code":"worker_stream_closed"}}\n\ndata: [DONE]\n\n');}
  finally {if(!reply.raw.destroyed)reply.raw.end();}
  return reply;
});
app.post('/images/generations',async(req)=>native.generate(req.body));
app.post('/images/edits',async(req)=>{
  const {prompt,inputMime,imageBase64,n,aspect_ratio}=req.body||{};
  if(typeof imageBase64!=='string'||imageBase64.length>14*1024*1024||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64))
    throw new GatewayError(400,'invalid_image','Invalid image payload');
  const bytes=Buffer.from(imageBase64,'base64');
  const mime=validateImageBuffer(bytes,10*1024*1024);
  if(mime!==inputMime)throw new GatewayError(400,'mime_mismatch','Invalid image MIME');
  return native.edit({prompt,imageBytes:bytes,inputMime:mime,n,aspect_ratio});
});

try {
  await native.openLoginPage();
  await app.listen({host:'0.0.0.0',port:4982});
  console.log('GPT Docker worker ready on port 4982. Chrome runs HEADFUL under Xvfb.');
} catch(e) {console.error('GPT worker startup failed:',String(e?.message||e).slice(0,400));await native.close();process.exit(1);}
async function stop(){await app.close().catch(()=>{});await native.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
