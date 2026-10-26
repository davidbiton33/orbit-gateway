import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fail} from './errors.mjs';
export class ProjectStore {
 constructor(file){this.file=file;this.pending=Promise.resolve();}
 async list(){try{const v=JSON.parse(await readFile(this.file,'utf8'));return Array.isArray(v)?v:[]}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 async create(name){if(typeof name!=='string'||name.trim().length<2||name.length>80)fail(400,'invalid_name','Project name must be 2-80 characters');
  const run=async()=>{const all=await this.list();if(all.length>=200)fail(429,'project_limit','Too many projects');const p={id:randomUUID(),name:name.trim(),type:'local',created_at:new Date().toISOString()};all.push(p);await mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp.'+process.pid;await writeFile(tmp,JSON.stringify(all,null,2),{mode:0o600});await rename(tmp,this.file);return p;};
  const out=this.pending.then(run);this.pending=out.catch(()=>{});return out;
 }
 async assertExists(id){if(id&&!((await this.list()).some(x=>x.id===id)))fail(404,'project_not_found','Local project not found');}
}
