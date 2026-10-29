import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {remoteChat} from '../src/adapters/remote.mjs';
const file={id:'file_gemini_0123456789abcdef0123456789abcdef',filename:'דוח.pdf',mime_type:'application/pdf',size:100,download_url:'/v1/files/file_gemini_0123456789abcdef0123456789abcdef/content'};
async function fixture(replyText){
 const server=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer TEST_TOKEN'){res.writeHead(401);res.end();return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(replyText)res.write('data: '+JSON.stringify({object:'chat.completion.chunk',choices:[{delta:{content:replyText},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({object:'chat.completion.chunk',conversation_id:'file-test',attachments:[file],choices:[{delta:{},finish_reason:'stop'}]})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {server,origin:'http://127.0.0.1:'+server.address().port};
}
for(const [label,reply] of [['file-only',''],['mixed reply','Attached is the file.']]){
 test('Remote SSE preserves '+label+' attachments from authenticated worker',async()=>{
  const {server,origin}=await fixture(reply);
  try{
   const result=await remoteChat('gemini',{geminiOrigin:origin,token:'TEST_TOKEN',requestTimeoutMs:3000},{messages:[{role:'user',content:'Create report'}],effort:'auto'},null);
   assert.equal(result.text,reply);
   assert.equal(result.attachments.length,1);
   assert.deepEqual(result.attachments[0],file);
   assert.equal(result.conversation_id,'file-test');
  }finally{server.close();}
 });
}
