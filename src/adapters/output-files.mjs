// Local-only provider output artifact handling. No cookies or arbitrary URLs exported.
import {mkdir,stat,readFile,writeFile,rm,readdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {GatewayError} from '../lib/errors.mjs';

const EXTENSIONS=new Map(Object.entries({
  '.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip':'application/zip','.csv':'text/csv','.txt':'text/plain',
  '.md':'text/markdown','.json':'application/json','.rtf':'application/rtf'
}));
const MAX_BYTES=20*1024*1024;
const FILE_ID=/^file_(gpt|gemini|claude|aimode)_([a-f0-9]{32})$/;
const PROVIDERS=new Set(['gemini','claude','aimode']);
export function cleanFilename(input){
 const value=String(input||'').replace(/\\/g,'/').split('/').at(-1).replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').trim();
 return value.slice(0,120).replace(/^\.+/,'')||'attachment';
}
export function fileExtension(name){return path.extname(cleanFilename(name)).toLowerCase();}
export function isFileCandidate(link,provider){
 if(!PROVIDERS.has(provider))return false;
 const name=cleanFilename(link?.filename||link?.text||'');
 let ext=fileExtension(name);
 if(!EXTENSIONS.has(ext)){try{ext=fileExtension(decodeURIComponent(new URL(String(link?.href||'')).pathname));}catch{}}
 if(!EXTENSIONS.has(ext))return false;
 if(link?.kind==='button'||link?.kind==='card')return true;
 try{
  const url=new URL(String(link?.href||''));
  if(url.protocol==='blob:'){
   const host=new URL(url.pathname).hostname;
   return trustedHost(host,provider);
  }
  if(url.protocol==='sandbox:')return /^\/mnt\/data\/[^/]+$/i.test(url.pathname);
  return url.protocol==='https:'&&trustedHost(url.hostname,provider);
 }catch{return false;}
}
function trustedHost(host,provider){
 const hostname=String(host).toLowerCase();
 if(provider==='claude')return hostname==='claude.ai'||hostname.endsWith('.claude.ai')||hostname==='anthropic.com';
 return hostname==='gemini.google.com'||hostname==='www.google.com'||hostname==='google.com'
  ||hostname==='drive.google.com'||hostname==='docs.google.com'
  ||hostname.endsWith('.googleusercontent.com');
}
export function validArtifactId(id){return FILE_ID.test(String(id||''));}
export function artifactProvider(id){return FILE_ID.exec(String(id||''))?.[1]||null;}
function artifactFolder(config){return path.join(config.dataDir,'generated-files');}
function assertValidBytes(buf,filename){
 const ext=fileExtension(filename);
 if(!EXTENSIONS.has(ext))throw new GatewayError(422,'file_type_unsupported','Unsupported file extension');
 if(buf.length<1||buf.length>MAX_BYTES)throw new GatewayError(413,'file_size_invalid','Generated file is empty or too large');
 if(ext==='.pdf'&&!buf.subarray(0,5).equals(Buffer.from('%PDF-')))
  throw new GatewayError(502,'file_signature_invalid','PDF signature mismatch');
 if(['.docx','.xlsx','.pptx','.zip'].includes(ext)){
  if(buf.length<4||buf[0]!==80||buf[1]!==75||![[3,4],[5,6],[7,8]].some(([a,b])=>buf[2]===a&&buf[3]===b))
   throw new GatewayError(502,'file_signature_invalid','ZIP/Office signature mismatch');
 }
 return EXTENSIONS.get(ext);
}
export async function pruneExpiredArtifacts(config,now=Date.now()){
 const root=artifactFolder(config);const idMatcher=FILE_ID;
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
export async function storeGeneratedDownload(download,provider,config,fallbackName=''){
 if(!PROVIDERS.has(provider))throw new GatewayError(400,'invalid_provider','Invalid provider');
 const suggested=cleanFilename(download.suggestedFilename());
 const filename=EXTENSIONS.has(fileExtension(suggested))?suggested:cleanFilename(fallbackName);
 const ext=fileExtension(filename);
 if(!EXTENSIONS.has(ext))throw new GatewayError(422,'file_type_unsupported','Unsupported file extension');
 const id='file_'+provider+'_'+randomUUID().replaceAll('-','');
 const folder=artifactFolder(config);await mkdir(folder,{recursive:true,mode:0o700});
 await pruneExpiredArtifacts(config);
 const output=path.join(folder,id+'.bin');
 try{
  await download.saveAs(output);
  const info=await stat(output);
  if(!info.isFile()||info.size>MAX_BYTES||info.size<1)
   throw new GatewayError(413,'file_size_invalid','Downloaded file exceeds 20 MB or is empty');
  const bytes=await readFile(output);
  const mime_type=assertValidBytes(bytes,filename);
  const metadata={id,provider,filename,mime_type,size:bytes.length,created_at:Date.now()};
  await writeFile(path.join(folder,id+'.json'),JSON.stringify(metadata),{flag:'wx',mode:0o600});
  return {id,filename,mime_type,size:bytes.length,download_url:'/v1/files/'+id+'/content'};
 }catch(e){await rm(output,{force:true}).catch(()=>{});throw e;}
}
// Orbit-created CSV derived from an assistant table, never a claimed provider-native file.
export async function storeConvertedCsv(csv,provider,config,requestedName='gemini-table.csv'){
 if(provider!=='gemini')throw new GatewayError(400,'invalid_provider','Table export is supported for Gemini');
 const bytes=Buffer.from(String(csv),'utf8');
 if(!bytes.length||bytes.length>2*1024*1024)throw new GatewayError(413,'converted_csv_size','Converted table exceeds 2 MB');
 const filename=cleanFilename(requestedName);
 if(fileExtension(filename)!=='.csv')throw new GatewayError(422,'file_type_unsupported','Converted table must be CSV');
 const id='file_'+provider+'_'+randomUUID().replaceAll('-','');
 const folder=artifactFolder(config);
 await mkdir(folder,{recursive:true,mode:0o700});
 await pruneExpiredArtifacts(config);
 const bin=path.join(folder,id+'.bin'),meta=path.join(folder,id+'.json');
 try{
  await writeFile(bin,bytes,{mode:0o600,flag:'wx'});
  await writeFile(meta,JSON.stringify({id,provider,filename,mime_type:'text/csv',size:bytes.length,source:'orbit_table_conversion',created_at:Date.now()}),{mode:0o600,flag:'wx'});
  return {id,filename,mime_type:'text/csv',size:bytes.length,source:'orbit_table_conversion',download_url:'/v1/files/'+id+'/content'};
 }catch(e){await rm(bin,{force:true}).catch(()=>{});await rm(meta,{force:true}).catch(()=>{});throw e;}
}
export async function storeConvertedPdf(bytes,provider,config,requestedName='gemini-document.pdf',originalWordId=null){
 if(provider!=='gemini')throw new GatewayError(400,'invalid_provider','PDF conversion supports Gemini only');
 if(!Buffer.isBuffer(bytes))throw new GatewayError(422,'invalid_pdf','Expected PDF bytes');
 const filename=cleanFilename(requestedName);
 if(fileExtension(filename)!=='.pdf')throw new GatewayError(422,'invalid_pdf_name','PDF filename is required');
 const mime_type=assertValidBytes(bytes,filename);
 const id='file_'+provider+'_'+randomUUID().replaceAll('-','');
 const folder=artifactFolder(config);await mkdir(folder,{recursive:true,mode:0o700});
 await pruneExpiredArtifacts(config);
 const bin=path.join(folder,id+'.bin'),meta=path.join(folder,id+'.json');
 try{
  await writeFile(bin,bytes,{flag:'wx',mode:0o600});
  await writeFile(meta,JSON.stringify({id,provider,filename,mime_type,size:bytes.length,source:'orbit_docx_to_pdf',original_word_id:originalWordId,created_at:Date.now()}),{flag:'wx',mode:0o600});
  return {id,filename,mime_type,size:bytes.length,source:'orbit_docx_to_pdf',download_url:'/v1/files/'+id+'/content'};
 }catch(error){await rm(bin,{force:true}).catch(()=>{});await rm(meta,{force:true}).catch(()=>{});throw error;}
}
export async function readStoredArtifact(id,config){
 if(!validArtifactId(id))throw new GatewayError(400,'invalid_file_id','Invalid file identifier');
 if(config.workerProvider && config.workerProvider!==artifactProvider(id)
    && !(config.workerProvider==='gemini'&&artifactProvider(id)==='aimode'))
  throw new GatewayError(403,'worker_scope','Wrong file provider');
 const folder=artifactFolder(config);
 let meta,bytes;
 try{meta=JSON.parse(await readFile(path.join(folder,id+'.json'),'utf8'));bytes=await readFile(path.join(folder,id+'.bin'));}
 catch{throw new GatewayError(404,'file_not_found','Generated file not found');}
 if(meta.id!==id||meta.provider!==artifactProvider(id)||meta.created_at>Date.now()+60000||Date.now()-meta.created_at>48*3600*1000)
  throw new GatewayError(410,'file_expired','Generated file expired');
 const mime=assertValidBytes(bytes,meta.filename);
 if(mime!==meta.mime_type||bytes.length!==meta.size)throw new GatewayError(502,'file_corrupt','File metadata mismatch');
 return {bytes,metadata:meta};
}
export async function snapshotOutputLinks(page,provider){
 if(!PROVIDERS.has(provider))return [];
 const list=await page.evaluate(provider=>{
  let root=null;
  if(provider==='claude'){
   const nodes=[...document.querySelectorAll('[data-testid="assistant-message"],[data-message-author-role="assistant"],.font-claude-response')];
   root=nodes.at(-1)||null;
  }else if(provider==='gemini'){
   root=[...document.querySelectorAll('model-response,[data-test-id="model-response"]')].at(-1)||null;
  }else{
   const headings=[...document.querySelectorAll('h3')].filter(h=>(h.textContent||'').startsWith('AI Mode reply for'));
   root=headings.at(-1)?.parentElement||null;
  }
  if(!root)return [];
  const ext=/([\p{L}\p{N}_. -]+\.(?:pdf|docx|xlsx|pptx|zip|csv|txt|md|json|rtf))(?:$|[\s,;])/iu;
  const getFilename=el=>{
   const fields=[el.getAttribute('download'),el.getAttribute('data-filename'),el.getAttribute('title'),el.getAttribute('aria-label'),el.innerText,el.parentElement?.innerText?.slice(0,160)];
   for(const value of fields){
    const m=ext.exec(String(value||'').trim());
    if(m)return m[1].trim();
   }
   return '';
  };
  const links=[...root.querySelectorAll('a[href]')].slice(0,50).map(a=>({
   kind:'link',href:a.href,filename:getFilename(a)||a.getAttribute('download')||a.getAttribute('title')||a.textContent?.trim()||'',
   text:a.textContent?.trim()||''
  }));
  const buttons=[...root.querySelectorAll('button')].slice(0,60).flatMap((b,index)=>{
   const label=[b.getAttribute('aria-label'),b.getAttribute('title'),b.getAttribute('data-testid')].join(' ');
   if(!/download|הורד|הורדה|export|ייצוא/i.test(label))return [];
   const filename=getFilename(b);
   return filename?[{kind:'button',index,filename,href:'',text:''}]:[];
  });
  const cards=provider==='gemini'?[...root.querySelectorAll('button')].slice(0,80).flatMap((b,index)=>{
   if(!/^open$/i.test((b.innerText||b.textContent||'').trim()))return [];
   let card=b.parentElement;
   for(let depth=0;depth<5&&card;depth++,card=card.parentElement){
    const raw=(card.innerText||'').trim();
    if(raw.length>200||!/\bDOCX\b/i.test(raw))continue;
    const match=raw.match(/([^\n]{1,100})\s*\n\s*DOCX\b/i);
    if(!match)continue;
    const base=match[1].trim().replace(/\.docx$/i,'').replace(/[<>:"|?*]/g,'_').slice(0,90);
    if(!base||/^(open|docx)$/i.test(base))continue;
    return [{kind:'card',index,filename:base+'.docx',href:'',text:''}];
   }
   return [];
  }):[];
  return [...links,...buttons,...cards];
 },provider).catch(()=>[]);
 return list.filter(item=>isFileCandidate(item,provider));
}
export function newOutputLinks(before,now){
 const key=x=>x.kind==='button'||x.kind==='card'?x.kind+':'+x.index+':'+x.filename:'link:'+x.href;
 const old=new Set((before||[]).map(key));
 return (now||[]).filter(x=>!old.has(key(x))).slice(0,4);
}
export async function captureOutputLinks(page,provider,candidates,config){
 const results=[],seen=new Set();
 for(const link of candidates.slice(0,4)){
  const scope=provider==='gemini'?page.locator('model-response,[data-test-id="model-response"]').last():
   provider==='claude'?page.locator('[data-testid="assistant-message"],[data-message-author-role="assistant"],.font-claude-response').last():
   page.locator('h3').filter({hasText:/^AI Mode reply for/}).last().locator('..');
  let target=null;
  if(link.kind==='card'){
   target=scope.locator('button').nth(link.index);
   if(!await target.isVisible().catch(()=>false))continue;
   const confirmed=await target.evaluate(el=>{
    if(!/^open$/i.test((el.innerText||el.textContent||'').trim()))return false;
    let parent=el.parentElement;
    for(let i=0;i<5&&parent;i++,parent=parent.parentElement){
     const raw=(parent.innerText||'').trim();
     if(raw.length<=200 && /\bDOCX\b/i.test(raw))return true;
    }
    return false;
   }).catch(()=>false);
   if(!confirmed)continue;
  }else if(link.kind==='button'){
   target=scope.locator('button').nth(link.index);
   const label=[await target.getAttribute('aria-label').catch(()=>''),await target.getAttribute('title').catch(()=>''),await target.getAttribute('data-testid').catch(()=>'')].join(' ');
   if(!/download|הורד|הורדה|export|ייצוא/i.test(label))continue;
   if(!await target.isVisible().catch(()=>false))continue;
  }else{
   const loc=scope.locator('a[href]');
   const count=Math.min(await loc.count(),80);
   for(let i=0;i<count;i++){
    const item=loc.nth(i);
    const href=await item.evaluate(el=>el.href).catch(()=>null);
    if(href===link.href && await item.isVisible().catch(()=>false)){target=item;break;}
   }
  }
  if(!target)continue;
  const candidatesFromNetwork=[],browserDownloadEvents=[];
  let cdp=null,downloadDir=null;
  if(link.kind==='card'){
   try{
    downloadDir=await mkdtemp(path.join(tmpdir(),'orbit-gemini-download-'));
    cdp=await page.context().newCDPSession(page);
    cdp.on('Browser.downloadWillBegin',event=>{
     if(typeof event.suggestedFilename==='string'&&event.suggestedFilename.toLowerCase().endsWith('.docx')&&/^[0-9a-f-]{36}$/i.test(event.guid))
      browserDownloadEvents.push({guid:event.guid,filename:event.suggestedFilename,status:'started'});
    });
    cdp.on('Browser.downloadProgress',event=>{
     if(!['completed','canceled'].includes(event.state))return;
     const found=browserDownloadEvents.find(item=>item.guid===event.guid);
     if(found)found.status=event.state;
    });
    await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:downloadDir,eventsEnabled:true});
   }catch{await cdp?.detach().catch(()=>{});cdp=null;}
  }
  const observe=response=>{
   if(link.kind!=='card')return;
   try{
    const uri=new URL(response.url());
    if(uri.protocol!=='https:'||!trustedHost(uri.hostname,provider))return;
    const headers=response.headers(),type=String(headers['content-type']||''),disposition=String(headers['content-disposition']||'');
    if(!/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/i.test(type)&&
       !/attachment[^\n]*\.docx/i.test(disposition))return;
    const declared=Number(headers['content-length']||0);
    if(declared>MAX_BYTES)return;
    const promise=response.body().then(body=>{
     if(body?.length>4&&body.length<=MAX_BYTES&&body[0]===0x50&&body[1]===0x4b)
      candidatesFromNetwork.push(body);
    }).catch(()=>{});
    void promise;
   }catch{}
  };
  if(link.kind==='card')page.on('response',observe);
  try{
   const pending=page.waitForEvent('download',{timeout:link.kind==='card'?2400:10000}).catch(()=>null);
   await target.click({timeout:6000});
   let download=await pending;
   if(!download&&link.kind==='card'){
    // Gemini's viewer controls may only appear after hovering over its header.
    await page.mouse.move(1270,38).catch(()=>{});
    await page.waitForTimeout(500);
    // The document viewer uses an exact, standalone div with aria-label=Download.
    // Avoid broad matches such as "Download code" on the Gemini response itself.
    const toolbar=page.locator('div[aria-label="Download"]');
    const visible=toolbar.filter({visible:true});
    const count=await visible.count().catch(()=>0);
    if(count){
     const follow=page.waitForEvent('download',{timeout:11000}).catch(()=>null);
     const button=visible.first();
     await button.click({timeout:6000});
     download=await follow;
    }
   }
   let saved=null;
   if(download)saved=await storeGeneratedDownload(download,provider,config,link.filename);
   else if(candidatesFromNetwork.length){
    const body=candidatesFromNetwork.at(-1);
    saved=await storeGeneratedDownload({suggestedFilename:()=>link.filename,saveAs:destination=>writeFile(destination,body)},provider,config,link.filename);
   }
   if(!saved&&cdp&&downloadDir){
    // Gemini's native document viewer saves into Browser.setDownloadBehavior's
    // isolated directory as a GUID, but Chromium does NOT always forward
    // Browser.downloadWillBegin to a page-scoped CDP session.
    // Chrome renames .crdownload -> GUID only on completion.
    let completeFile=null;
    for(let tries=0;tries<24&&!completeFile;tries++){
     const names=await readdir(downloadDir).catch(()=>[]);
     const matching=names.filter(name=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name));
     if(matching.length===1){
      const filepath=path.join(downloadDir,matching[0]);
      const info=await stat(filepath).catch(()=>null);
      if(info?.isFile()&&info.size>4&&info.size<=MAX_BYTES)completeFile=filepath;
     }
     if(!completeFile)await page.waitForTimeout(200);
    }
    if(completeFile){
     const bytes=await readFile(completeFile);
     saved=await storeGeneratedDownload({suggestedFilename:()=>link.filename,saveAs:destination=>writeFile(destination,bytes)},provider,config,link.filename);
     console.info('[ORBIT-GEMINI-DOWNLOAD-ACTION]',JSON.stringify({phase:'verified_chrome_directory',bytes:bytes.length}));
    }
   }
   if(!saved)throw Error('No verified browser download, CDP download or DOCX network response');
   if(seen.has(saved.filename))continue;
   seen.add(saved.filename);
   results.push({...saved,source:'provider_native'});
  }catch(error){
   console.warn('[ORBIT-FILE]',JSON.stringify({provider,phase:'capture_unavailable',kind:link.kind||'link',networkCandidates:candidatesFromNetwork.length,cdpDownloads:browserDownloadEvents.map(item=>item.status),code:error?.code||error?.name||'unknown'}));
  }finally{
   if(link.kind==='card')page.off('response',observe);
   if(cdp){await cdp.send('Browser.setDownloadBehavior',{behavior:'default'}).catch(()=>{});await cdp.detach().catch(()=>{});}
   if(downloadDir)await rm(downloadDir,{recursive:true,force:true}).catch(()=>{});
  }
 }
 return results;
}
