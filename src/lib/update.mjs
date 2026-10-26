/** Strict signed remote updates for versioned source/UI/selector files. Requires owner-pinned Ed25519 SPKI public key.
    No executable updates without detached signature AND SHA256 for every replaced file.
    Existing .env, profiles, data, SQLite and node_modules are never updated. */
import {readFile,writeFile,mkdir,stat,rename,rm,cp} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash,createPublicKey,verify} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {ROOT} from './config.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function isAllowed(rel,adaptersOnly=false){if(typeof rel!=='string'||rel.length>180||rel.startsWith('/')||rel.includes('\\')||rel.split('/').includes('..'))return false;
 const allowed=/^(src\/(?:server\.mjs|(?:adapters|lib)\/[a-z0-9-]+\.mjs)|public\/(?:app\.js|style\.css|index\.html)|config\/selectors\.json|tests\/[a-z0-9-]+\.test\.mjs|docs\/[A-Za-z0-9_.-]+\.md|skill\/SKILL\.md)$/;
 if(adaptersOnly)return /^config\/selectors\.json$/.test(rel)||/^src\/adapters\/[a-z0-9-]+\.mjs$/.test(rel);
 return allowed.test(rel);
}
async function bytesFrom(url,max){const u=new URL(url);if(u.protocol!=='https:')throw Error('Update sources must use HTTPS');const res=await fetch(u,{signal:AbortSignal.timeout(35000),redirect:'error'});if(!res.ok)throw Error('HTTP '+res.status+' fetching update');let all=[],size=0;for await(const chunk of res.body){size+=chunk.length;if(size>max)throw Error('Download exceeds size limit');all.push(chunk);}return Buffer.concat(all);}
function validateManifest(m,adaptersOnly){if(!m||typeof m!=='object'||!Array.isArray(m.files)||m.files.length<1||m.files.length>150||typeof m.version!=='string'||!/^[\d.a-z-]{1,40}$/.test(m.version))throw Error('Invalid update manifest');const paths=new Set();for(const f of m.files){if(!isAllowed(f.path,adaptersOnly)||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Manifest contains forbidden path/hash: '+f.path);if(paths.has(f.path))throw Error('Duplicate manifest path');paths.add(f.path);}return m;}
export async function applyUpdate(config,{adaptersOnly=false,dryRun=false}={}){
 if(!config.updateManifestUrl||!config.updatePublicKey)throw Error('Signed update URL/key not configured. No changes made.');
 const manifestBytes=await bytesFrom(config.updateManifestUrl,1e6),sig=await bytesFrom(config.updateManifestUrl+'.sig',8192);
 const pub=createPublicKey({key:Buffer.from(config.updatePublicKey,'base64'),format:'der',type:'spki'});
 if(!verify(null,manifestBytes,pub,sig))throw Error('Manifest signature verification failed. No changes made.');
 const manifest=validateManifest(JSON.parse(manifestBytes),adaptersOnly);
 const origin=new URL(config.updateManifestUrl);for(const f of manifest.files){const u=new URL(f.url);if(u.protocol!=='https:'||u.origin!==origin.origin)throw Error('Update file URL origin differs from pinned manifest origin');}
 const staging=await mkdir(path.join(ROOT,'.staging'),{recursive:true}).then(()=>path.join(ROOT,'.staging','update-'+process.pid));
 await mkdir(staging,{recursive:true});const approved=[];
 try{
   for(const f of manifest.files){const bytes=await bytesFrom(f.url,8e6);if(hash(bytes)!==f.sha256)throw Error('SHA mismatch for '+f.path);const name=path.join(staging,f.path);await mkdir(path.dirname(name),{recursive:true});await writeFile(name,bytes);if(f.path.endsWith('.mjs')||f.path.endsWith('.js')){const check=spawnSync(process.execPath,['--check',name],{encoding:'utf8'});if(check.status!==0)throw Error('Syntax validation failed for '+f.path+': '+check.stderr.slice(0,200));}approved.push(f.path);}
   if(dryRun)return {version:manifest.version,verified:true,files:approved,applied:false};
   const stamp=new Date().toISOString().replace(/[.:]/g,'-');const backup=path.join(ROOT,'.backups','update-'+stamp);await mkdir(backup,{recursive:true});
   const changes=[];
   try{
     for(const file of approved){const dst=path.join(ROOT,file),old=path.join(backup,file);await mkdir(path.dirname(old),{recursive:true});const present=await stat(dst).then(()=>true).catch(()=>false);if(present)await cp(dst,old);const tmp=dst+'.orbit-update-'+process.pid;await cp(path.join(staging,file),tmp);await rename(tmp,dst);changes.push({dst,old,present});}
     const state=path.join(ROOT,'data','last-update.json');await mkdir(path.dirname(state),{recursive:true});await writeFile(state,JSON.stringify({backup,files:approved,version:manifest.version,timestamp:new Date().toISOString()},null,2),{mode:0o600});
     return {version:manifest.version,verified:true,files:approved,applied:true,backup};
   }catch(e){for(const {dst,old,present} of changes.reverse()){if(present)await cp(old,dst);else await rm(dst,{force:true});}throw e;}
 }finally{await rm(staging,{recursive:true,force:true});}
}
export async function rollback(){const stateFile=path.join(ROOT,'data','last-update.json');const saved=JSON.parse(await readFile(stateFile,'utf8'));if(!saved.backup.startsWith(path.join(ROOT,'.backups')+path.sep))throw Error('Unsafe backup directory');for(const file of saved.files){if(!isAllowed(file))throw Error('Unsafe rollback path');const old=path.join(saved.backup,file),dst=path.join(ROOT,file);if(await stat(old).then(()=>true).catch(()=>false))await cp(old,dst);else await rm(dst,{force:true});}await rm(stateFile,{force:true});return {rolled_back:true,files:saved.files};}
