/** Native Node.js example. No external dependency. */
const url=process.env.AI_GATEWAY_URL||'http://127.0.0.1:4984/v1';
const token=process.env.AI_GATEWAY_TOKEN;
if(!token)throw Error('Set AI_GATEWAY_TOKEN as a server-side environment variable');
const response=await fetch(url+'/chat/completions',{
 method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
 body:JSON.stringify({model:'gpt',messages:[{role:'user',content:'Explain the JavaScript event loop concisely'}]})
});
const data=await response.json();if(!response.ok)throw Error(data.error?.message||'Gateway request failed');
console.log(data.choices[0].message.content);
console.log('Continue with conversation_id:',data.conversation_id);
