/* Read-only discovery of links rendered in the authenticated provider browser.
   This is not a provider API, and cannot guarantee a complete projects listing. */
const PROVIDERS={
  gpt:{origin:'https://chatgpt.com',paths:[/^\/g\/g-p-[^/?#]{5,}/i,/^\/project\/[^/?#]{5,}/i]},
  gemini:{origin:'https://gemini.google.com',paths:[/^\/notebook\/[a-f0-9-]{36}$/i]}
};
export function normalizeProviderProject(provider,record) {
 const rule=PROVIDERS[provider];if(!rule)return null;
 try{
  const url=new URL(record.href,rule.origin);
  if(url.origin!==rule.origin||!rule.paths.some(p=>p.test(url.pathname)))return null;
  const name=String(record.name||'').replace(/\s+/g,' ').trim().slice(0,150);
  if(!name)return null;
  return {id:url.pathname,name,url:url.origin+url.pathname,provider,scope:'native_link'};
 }catch{return null;}
}
export async function discoverProviderProjects(page,provider) {
 if(!PROVIDERS[provider])return {provider,scope:'native',status:'unsupported',projects:[]};
 const links=await page.locator('a[href]').evaluateAll((els,source)=>els.map(e=>({
  href:e.getAttribute('href'),name:source==='gemini'?(e.getAttribute('aria-label')||e.innerText||''):(e.innerText||e.getAttribute('aria-label')||e.getAttribute('title')||'')
 })),provider);
 const dedup=new Map();
 for(const item of links) {
  const project=normalizeProviderProject(provider,item);
  if(project&&!dedup.has(project.url))dedup.set(project.url,project);
 }
 let projects=[...dedup.values()];
 // The current ChatGPT sidebar exposes the authoritative project ID on the row.
 // A click on the project name only expands its conversations; do NOT click or
 // infer a project from a bare display name.
 if(provider==='gpt' && typeof page.evaluate==='function'){
   const rows=await page.evaluate(()=>[...document.querySelectorAll('[data-app-action-sidebar-project-id]')].map(el=>({
      id:el.getAttribute('data-app-action-sidebar-project-id'),
      name:el.getAttribute('data-app-action-sidebar-project-label')||el.innerText?.trim()||''
   }))).catch(()=>[]);
   const confirmed=[];
   for(const row of rows){
     if(!/^g-p-[A-Za-z0-9_-]{6,90}$/.test(row.id||''))continue;
     const name=String(row.name||'').trim().slice(0,150);
     if(!name)continue;
     confirmed.push({id:row.id,name,provider:'gpt',url:'https://chatgpt.com/g/'+row.id+'/project',scope:'native_verified_id'});
   }
   if(confirmed.length)projects=[...new Map(confirmed.map(p=>[p.id,p])).values()];
 }
 return {provider,scope:'native',status:projects.length?'ok':'unverified_empty',projects};
}
