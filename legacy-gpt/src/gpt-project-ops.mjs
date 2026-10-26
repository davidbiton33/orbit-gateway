import {GatewayError} from './security.mjs';

export const PROJECT_ID_PATTERN=/^g-p-[a-zA-Z0-9_-]{6,90}$/;
export function validateProjectId(id){
 if(typeof id!=='string'||!PROJECT_ID_PATTERN.test(id))
  throw new GatewayError(422,'invalid_native_project','Expected a ChatGPT project ID (g-p-...). No action was taken.');
 return id;
}
export function validateProjectName(name){
 if(typeof name!=='string'||!name.trim()||name.trim().length<2||name.trim().length>80||/[\u0000-\u001F]/.test(name))
  throw new GatewayError(422,'invalid_project_name','Project name must contain 2–80 printable characters.');
 return name.trim();
}
export function validateProjectChatUrl(projectId,raw){
 validateProjectId(projectId);
 try{
  const u=new URL(raw,'https://chatgpt.com');
  if(u.origin!=='https://chatgpt.com'||u.username||u.password||u.search||u.hash)throw Error('url_rejected');
  if(!new RegExp('^/g/'+projectId+'/c/[a-zA-Z0-9_-]{6,90}/?$').test(u.pathname))throw Error('route_mismatch');
  return u.origin+u.pathname.replace(/\/$/,'');
 }catch{throw new GatewayError(422,'invalid_project_chat','The conversation URL does not belong to the selected ChatGPT project. Nothing was sent.');}
}
export async function readProjectChatLinks(page,projectId){
 validateProjectId(projectId);
 const entries=await page.locator('a[href]').evaluateAll((anchors,id)=>{
  return anchors.map(a=>({href:a.getAttribute('href'),title:(a.innerText||a.getAttribute('aria-label')||'').trim()}))
    .filter(x=>x.href?.startsWith('/g/'+id+'/c/'));
 },projectId);
 const found=new Map();
 for(const entry of entries){
   try{
     const url=validateProjectChatUrl(projectId,entry.href);
     if(entry.title&&!found.has(url))found.set(url,{id:url.split('/').at(-1),title:entry.title.slice(0,150),url,project_id:projectId});
   }catch{}
 }
 return {project_id:projectId,status:found.size?'ok':'unverified_empty',chats:[...found.values()].slice(0,80),source:'rendered_sidebar_links'};
}
