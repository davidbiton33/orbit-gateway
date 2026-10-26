import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServers} from '../src/server.mjs';
import {ProjectStore} from '../src/lib/store.mjs';
import {normalizeProviderProject,discoverProviderProjects} from '../src/adapters/native-projects.mjs';
const token='T'.repeat(54);
test('project-link discovery accepts only exact provider origins and project routes',()=>{
 assert.equal(normalizeProviderProject('gpt',{href:'https://chatgpt.com/g/g-p-demo-123456',name:'My App'}).name,'My App');
 assert.equal(normalizeProviderProject('gpt',{href:'https://chatgpt.com/c/not-a-project',name:'Private chat'}),null);
 assert.equal(normalizeProviderProject('gpt',{href:'https://chatgpt.com.evil.com/g/g-p-demo-123456',name:'Injected'}),null);
 assert.equal(normalizeProviderProject('claude',{href:'/project/0123456789abcdef',name:'Claude Work'}).provider,'claude');
 assert.equal(normalizeProviderProject('claude',{href:'/new',name:'New Chat'}),null);
 assert.equal(normalizeProviderProject('gemini',{href:'/notebook/32b2403e-59ab-4e53-a902-d60e4d88d655',name:'מחברת Gemini'}).provider,'gemini');
 assert.equal(normalizeProviderProject('gemini',{href:'/notebooks/create',name:'New notebook'}),null);
});
test('native project discovery deduplicates links and refuses to claim completeness if no matches',async()=>{
 const page={locator:()=>({evaluateAll:async callback=>callback([
  {getAttribute:k=>k==='href'?'/project/0123456789abcdef':null,innerText:'Work'},
  {getAttribute:k=>k==='href'?'/project/0123456789abcdef':null,innerText:'Work'},
  {getAttribute:k=>k==='href'?'/new':null,innerText:'New chat'}
 ])})};
 const data=await discoverProviderProjects(page,'claude');
 assert.equal(data.projects.length,1);assert.equal(data.status,'ok');
 const empty=await discoverProviderProjects({locator:()=>({evaluateAll:async()=>[]})},'gpt');
 assert.equal(empty.status,'unverified_empty');
});
test('ChatGPT sidebar exposes real project ids, not guessed links',async()=>{
 const entries=[
 {id:'g-p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',name:'GIMPEL'},
 {id:'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'בדיקה'},
 {id:'malicious-http-url',name:'Ignore'}
 ];
 const page={locator:()=>({evaluateAll:async()=>[]}),evaluate:async()=>entries};
 const result=await discoverProviderProjects(page,'gpt');
 assert.equal(result.status,'ok');
 assert.equal(result.projects.length,2);
 assert.deepEqual(result.projects.map(x=>x.name),['GIMPEL','בדיקה']);
 assert.ok(result.projects.every(x=>x.url==='https://chatgpt.com/g/'+x.id+'/project'));
});
test('Native project id is allowed only for GPT chat, not for unknown backend or images',async()=>{
 const {validateRequest}=await import('../src/lib/catalog.mjs');
 const project='g-p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
 assert.equal(validateRequest({model:'gpt',native_project_id:project}).native_project_id,project);
 assert.equal(validateRequest({model:'claude',native_project_id:'/project/11111111-1111-4111-8111-111111111111'}).native_project_id,'/project/11111111-1111-4111-8111-111111111111');
 assert.throws(()=>validateRequest({model:'claude',native_project_id:project}),e=>e.code==='native_project_unverified');
 assert.throws(()=>validateRequest({model:'gpt',native_project_id:'p-1'}),e=>e.code==='native_project_unverified');
 assert.throws(()=>validateRequest({model:'gpt',native_project_id:project},'image'),e=>e.code==='native_project_unverified');
});
test('Orbit distinguishes saved local projects from read-only provider project discovery',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'orbit-projects-'));
 const projects=new ProjectStore(path.join(dataDir,'projects.json'));
 const manager={nativeProjects:async provider=>({provider,status:'ok',projects:[{name:'Existing project',url:'https://chatgpt.com/g/g-p-example1234'}]}),mode:async()=> 'legacy',chat:async()=>({text:'ok'})};
 const srv=createServers({token,dataDir,workerProvider:''},{projects,manager});
 await new Promise(ok=>srv.api.listen(0,'127.0.0.1',ok));
 t.after(async()=>{await new Promise(ok=>srv.api.close(ok));await rm(dataDir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+srv.api.address().port,h={Authorization:'Bearer '+token};
 const initial=await(await fetch(base+'/v1/projects',{headers:h})).json();
 assert.equal(initial.projects.length,0);
 const remote=await(await fetch(base+'/v1/projects/native?provider=gpt',{headers:h})).json();
 assert.equal(remote.projects[0].name,'Existing project');
 const local=await fetch(base+'/v1/projects',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify({name:'New local project',type:'local'})});
 assert.equal(local.status,201);
 const after=await(await fetch(base+'/v1/projects',{headers:h})).json();
 assert.equal(after.projects.length,1);
 assert.equal(after.projects[0].type,'local');
 assert.equal((await fetch(base+'/v1/projects/native?provider=unknown',{headers:h})).status,400);
});
test('projects UI has local create, native browsing, and explicit unsupported routing warning',async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const js=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 for(const key of ['nativeProjectList','refreshNative','projectForm','projectName','quickCreateProject','openNativeBrowser','chatNativeProject','refreshChatProjects'])assert.ok(html.includes('id="'+key+'"'),key);
 assert.match(js,/loadNativeProjects/);
 assert.match(html,/יצירת פרויקטים/);
 assert.match(html,/פרויקט מקומי/);
});
