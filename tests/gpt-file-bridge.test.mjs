import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {legacyChat} from '../src/adapters/legacy.mjs';
import {makeNativeSse} from '../legacy-gpt/src/gpt-native.mjs';
const file={id:'file_gpt_0123456789abcdef0123456789abcdef',filename:'report.pdf',mime_type:'application/pdf',size:36,download_url:'/v1/files/file_gpt_0123456789abcdef0123456789abcdef/content'};
for(const [label,text] of [['file-only',''],['text-and-file','Attached the PDF.']]){
 test('GPT legacy SSE bridge preserves '+label+' attachments and warnings',async()=>{
  const server=http.createServer(async(req,res)=>{
   if(req.url!=='/chat/stream'||req.headers.authorization!=='Bearer TEST_TOKEN'){res.writeHead(401);res.end();return;}
   const wire=makeNativeSse();res.writeHead(200,{'content-type':'text/event-stream'});
   res.end(wire.start()+(text?wire.progress(text):'')+wire.complete(text,'conversation-test','gpt-dom',[file],'One link could not be verified'));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const data=await legacyChat('gpt',{gptOrigin:'http://127.0.0.1:'+server.address().port,token:'TEST_TOKEN',requestTimeoutMs:3000},{messages:[{role:'user',content:'file'}]},null);
   assert.equal(data.text,text);
   assert.deepEqual(data.attachments,[file]);
   assert.equal(data.file_warning,'One link could not be verified');
   assert.equal(data.conversation_id,'conversation-test');
  }finally{server.close();}
 });
}
