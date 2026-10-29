import {mkdir,readFile,writeFile,stat,rm,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {GatewayError} from './security.mjs';
export const FILE_ID=/^file_gpt_[a-f0-9]{32}$/;
const MAX=20*1024*1024;
const MIME=new Map(Object.entries({
 '.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 '.zip':'application/zip','.csv':'text/csv','.txt':'text/plain',
 '.md':'text/markdown','.json':'application/json','.rtf':'application/rtf'
}));
export function safeFilename(value){
 return (String(value||'').replace(/\\/g,'/').split('/').at(-1)
  .replace(/[<>:"|?*]/g,'_').trim().slice(0,120).replace(/^\.+/,'')||'attachment');
}
const ext=name=>path.extname(safeFilename(name)).toLowerCase();
function hostAllowed(host){
 const h=String(host||'').toLowerCase();
 return h==='chatgpt.com'||h.endsWith('.chatgpt.com')||
  h==='files.oaiusercontent.com'||h.endsWith('.oaiusercontent.com');
}
export function isGptFileLink(link){
 let extension=ext(link?.filename||link?.text||'');
 let url;try{url=new URL(String(link?.href||''));}catch{return false;}
 if(!MIME.has(extension)){try{extension=ext(decodeURIComponent(url.pathname));}catch{}}
 if(!MIME.has(extension))return false;
 if(url.protocol==='sandbox:')return /^\/mnt\/data\/[^/]+$/i.test(url.pathname);
 if(url.protocol==='blob:'){try{return hostAllowed(new URL(url.pathname).hostname);}catch{return false;}}
 return url.protocol==='https:'&&hostAllowed(url.hostname);
}
function checkBytes(bytes,name){
 const extension=ext(name),mime=MIME.get(extension);
 if(!mime)throw new GatewayError(422,'file_type_unsupported','Unsupported file type');
 if(!bytes.length||bytes.length>MAX)throw new GatewayError(413,'file_size_invalid','Empty or oversized file');
 if(extension==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))
  throw new GatewayError(502,'file_signature_invalid','PDF signature mismatch');
 if(['.zip','.docx','.pptx','.xlsx'].includes(extension) &&
    !(bytes.length>=4&&bytes[0]===80&&bytes[1]===75&&[[3,4],[5,6],[7,8]].some(([a,b])=>bytes[2]===a&&bytes[3]===b)))
  throw new GatewayError(502,'file_signature_invalid','Archive/Office signature mismatch');
 return mime;
}
const folder=dir=>path.join(dir,'orbit-generated-files');
export async function pruneExpiredGptFiles(dir,now=Date.now()){
 const root=folder(dir);const idMatcher=FILE_ID;
 const cutoff=now-48*3600*1000;
 let names=[];try{names=await readdir(root);}catch{return 0;}
 let removed=0;
 for(const name of names.slice(0,2000)){
  if(!name.endsWith('.json'))continue;
  const id=name.slice(0,-5);
  if(!idMatcher.test(id))continue;
  let meta;try{meta=JSON.parse(await readFile(path.join(root,name),'utf8'));}catch{continue;}
  if(meta.id!==id||!Number.isFinite(meta.created_at)||meta.created_at>=cutoff)continue;
  await rm(path.join(root,id+'.bin'),{force:true}).catch(()=>{});
  await rm(path.join(root,name),{force:true}).catch(()=>{});
  removed++;
 }
 return removed;
}
export async function storeGptDownload(download,dir,fallbackName=''){
 const suggested=safeFilename(download.suggestedFilename());
 const filename=MIME.has(ext(suggested))?suggested:safeFilename(fallbackName);
 if(!MIME.has(ext(filename)))throw new GatewayError(422,'file_type_unsupported','Unsupported file type');
 const id='file_gpt_'+randomUUID().replaceAll('-','');
 const dirpath=folder(dir);await mkdir(dirpath,{recursive:true,mode:0o700});
 await pruneExpiredGptFiles(dir);
 const output=path.join(dirpath,id+'.bin');
 try{
  await download.saveAs(output);
  const info=await stat(output);
  if(!info.isFile()||info.size<1||info.size>MAX)throw new GatewayError(413,'file_size_invalid','File size out of range');
  const bytes=await readFile(output),mime_type=checkBytes(bytes,filename);
  await writeFile(path.join(dirpath,id+'.json'),JSON.stringify({id,filename,mime_type,size:bytes.length,created_at:Date.now()}),{mode:0o600,flag:'wx'});
  return {id,filename,mime_type,size:bytes.length,download_url:'/v1/files/'+id+'/content'};
 }catch(e){await rm(output,{force:true}).catch(()=>{});throw e;}
}
export async function readGptFile(id,dir){
 if(!FILE_ID.test(String(id||'')))throw new GatewayError(400,'invalid_file_id','Invalid file identifier');
 const base=folder(dir);
 let metadata,bytes;
 try{metadata=JSON.parse(await readFile(path.join(base,id+'.json'),'utf8'));bytes=await readFile(path.join(base,id+'.bin'));}
 catch{throw new GatewayError(404,'file_not_found','Generated file not found');}
 if(metadata.id!==id||!Number.isFinite(metadata.created_at)||metadata.created_at>Date.now()+60000||Date.now()-metadata.created_at>48*3600000)
  throw new GatewayError(410,'file_expired','Generated file has expired');
 if(metadata.mime_type!==checkBytes(bytes,metadata.filename)||metadata.size!==bytes.length)
  throw new GatewayError(502,'file_corrupt','File metadata mismatch');
 return {metadata,bytes};
}
export async function gptResponseLinks(page){
 const candidates=await page.evaluate(()=>{
  // Generated artifact cards may be siblings of the assistant text, not nested in it.
  // Search the chat main only, excluding user turns and the composer.
  const root=document.querySelector('main');
  if(!root)return [];
  const allowed=el=>!el.closest('[data-message-author-role="user"],[data-role="user"],form,[contenteditable="true"],nav,aside');
  const extension=/([\p{L}\p{N}_. -]+\.(?:pdf|docx|xlsx|pptx|zip|csv|txt|md|json|rtf))(?:$|[\s,;])/iu;
  const nameFrom=el=>{
   const bits=[el.getAttribute('download'),el.getAttribute('title'),el.getAttribute('aria-label'),el.innerText,el.parentElement?.innerText?.slice(0,220)];
   for(const bit of bits){
    const match=extension.exec(String(bit||'').trim());
    if(match)return match[1].trim().split(/\s{2,}/).at(-1);
   }
   return '';
  };
  const links=[...root.querySelectorAll('a[href]')].filter(allowed).slice(0,48).map(a=>({
   kind:'link',href:a.href,filename:nameFrom(a)||a.getAttribute('download')||a.getAttribute('title')||a.innerText?.trim()||'',text:a.innerText?.trim()||''
  }));
  const roleLinks=[...root.querySelectorAll('[role="link"]')].slice(0,60).flatMap((element,index)=>{
   if(!allowed(element))return [];
   const filename=nameFrom(element);
   return filename?[{kind:'role-link',index,filename,href:'',text:''}]:[];
  });
  const buttons=[...root.querySelectorAll('button')].slice(0,48).flatMap((button,index)=>{
   if(!allowed(button))return [];
   const identifying=[button.getAttribute('title'),button.getAttribute('aria-label'),button.getAttribute('data-testid')].join(' ');
   if(!/download|הורד|הורדה|export|ייצוא/i.test(identifying) && !/\.(?:csv|pdf|docx|xlsx|pptx|zip|txt|md|json|rtf)(?:$|\s)/i.test(button.innerText?.trim()||''))return [];
   const filename=nameFrom(button);
   return filename?[{kind:'button',index,filename,href:'',text:''}]:[];
  });
  return [...links,...roleLinks,...buttons];
 }).catch(()=>[]);
 return candidates.filter(link=>['button','role-link'].includes(link.kind)?MIME.has(ext(link.filename)):isGptFileLink(link));
}
export function newGptLinks(baseline,current){
 const key=x=>['button','role-link'].includes(x.kind)?x.kind+':'+x.index+':'+x.filename:'link:'+x.href;
 const prior=new Set((baseline||[]).map(key));
 return (current||[]).filter(x=>!prior.has(key(x))).slice(0,4);
}
export async function captureGptLinks(page,links,dir){
 const result=[],handled=new Set();
 for(const link of (links||[]).slice(0,4)){
  const root=page.locator('main').first();
  let target=null;
  if(link.kind==='role-link'){
   target=root.locator('[role="link"]').nth(link.index);
   const text=(await target.innerText().catch(()=>''))||'';
   const shortName=String(link.filename||'').match(/[\p{L}\p{N}_.-]+\.(?:csv|pdf|docx|xlsx|pptx|zip|txt|md|json|rtf)/iu)?.[0]||'';
   if(!shortName||!text.includes(shortName)||!await target.isVisible().catch(()=>false))continue;
   if(!await target.evaluate(el=>!el.closest('[data-message-author-role="user"],[data-role="user"],form,[contenteditable="true"]')).catch(()=>false))continue;
  }else if(link.kind==='button'){
   target=root.locator('button').nth(link.index);
   const label=(await target.getAttribute('aria-label').catch(()=>''))||'';
   const title=(await target.getAttribute('title').catch(()=>''))||'';
   const testid=(await target.getAttribute('data-testid').catch(()=>''))||'';
   const labelText=(await target.innerText().catch(()=>''))||'';
   const shortName=String(link.filename||'').match(/[\p{L}\p{N}_.-]+\.(?:csv|pdf|docx|xlsx|pptx|zip|txt|md|json|rtf)/iu)?.[0]||'';
   if(!/download|הורד|הורדה|export|ייצוא/i.test(label+' '+title+' '+testid) && !(shortName&&labelText.includes(shortName)))continue;
   if(!await target.isVisible().catch(()=>false))continue;
  }else{
   const anchors=root.locator('a[href]');
   for(let i=0,n=Math.min(await anchors.count(),60);i<n;i++){
    const element=anchors.nth(i);
    const actual=await element.evaluate(el=>el.href).catch(()=>null);
    if(actual===link.href&&await element.isVisible().catch(()=>false)){target=element;break;}
   }
  }
  if(!target)continue;
  try{
   const pending=page.waitForEvent('download',{timeout:3500}).catch(()=>null);
   await target.click({timeout:6500});
   let download=await pending;
   if(!download){
    // ChatGPT spreadsheet/Artifact cards first open a preview. Its toolbar
    // has a separate Download action that triggers the real browser event.
    const toolbar=page.locator('button[aria-label*="download" i],button[title*="download" i],button[data-testid*="download" i],a[download]').filter({visible:true});
    if(await toolbar.count()){
     const action=toolbar.last();
     const secondary=page.waitForEvent('download',{timeout:11000}).catch(()=>null);
     await action.click({timeout:5000});
     download=await secondary;
    }
   }
   if(!download)throw Error('No browser download event');
   const artifact=await storeGptDownload(download,dir,link.filename);
   if(handled.has(artifact.filename))continue;
   handled.add(artifact.filename);
   result.push(artifact);
  }catch(e){
   console.warn('[GPT-FILE]',JSON.stringify({phase:'capture_unavailable',kind:link.kind||'link',code:e?.code||e?.name||'unknown'}));
  }
 }
 return result;
}
