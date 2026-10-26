import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,readlink,writeFile,readFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareDockerProfile,activeProfilePids} from '../src/adapters/profile-lock.mjs';
const noop={info(){},warn(){}};
async function fixture(fn){
 const {rm}=await import('node:fs/promises');const t=await mkdtemp(path.join(tmpdir(),'orbit-lock-test-'));
 const profile=path.join(t,'profiles','gpt');const proc=path.join(t,'proc');await mkdir(profile,{recursive:true});await mkdir(proc);
 const env={ORBIT_ROLE:'worker',WORKER_PROVIDER:'gpt',GATEWAY_DATA_DIR:t};
 try{await fn({t,profile,proc,env});}finally{await rm(t,{recursive:true,force:true});}
}
async function chrome(proc,pid,argv){const d=path.join(proc,String(pid));await mkdir(d);await writeFile(path.join(d,'cmdline'),Buffer.from(argv.join('\0')+'\0'));}
test('Stale Chrome symlinks are removed only from matching Docker worker profile',()=>fixture(async({profile,proc,env})=>{
 for(const name of ['SingletonLock','SingletonSocket','SingletonCookie'])await symlink('oldhost-4321',path.join(profile,name));
 const out=await prepareDockerProfile(profile,'gpt',{env,platform:'linux',procRoot:proc,log:noop});
 assert.equal(out.status,'recovered');assert.equal(out.removed.length,3);
 for(const name of out.removed)await assert.rejects(()=>lstat(path.join(profile,name)),{code:'ENOENT'});
}));
test('Refuses to remove locks while live Chrome is using same profile',()=>fixture(async({profile,proc,env})=>{
 await symlink('orbit-gpt-321',path.join(profile,'SingletonLock'));
 await chrome(proc,321,['/opt/google/chrome/chrome','--user-data-dir='+profile]);
 await assert.rejects(()=>prepareDockerProfile(profile,'gpt',{env,platform:'linux',procRoot:proc,log:noop}),e=>e.code==='browser_profile_in_use'&&e.message.includes('gpt')&&e.status===409);
 assert.equal(await readlink(path.join(profile,'SingletonLock')),'orbit-gpt-321');
}));
test('Does not remove a lock created as a regular file',()=>fixture(async({profile,proc,env})=>{
 await writeFile(path.join(profile,'SingletonLock'),'protected');
 await assert.rejects(()=>prepareDockerProfile(profile,'gpt',{env,platform:'linux',procRoot:proc,log:noop}),e=>e.code==='profile_lock_unexpected_type');
 assert.equal(await readFile(path.join(profile,'SingletonLock'),'utf8'),'protected');
}));
test('Leaves profiles unchanged outside the intended Docker worker',()=>fixture(async({profile,proc,env})=>{
 await symlink('old',path.join(profile,'SingletonLock'));
 assert.deepEqual(await prepareDockerProfile(profile,'gpt',{env:{...env,WORKER_PROVIDER:'gemini'},platform:'linux',procRoot:proc,log:noop}),{status:'not_docker_worker'});
 assert.deepEqual(await prepareDockerProfile(profile,'gpt',{env,platform:'win32',procRoot:proc,log:noop}),{status:'not_docker_worker'});
 assert.equal(await readlink(path.join(profile,'SingletonLock')),'old');
}));
test('Prevents cleanup of a path outside isolated profile root',()=>fixture(async({t,proc,env})=>{
 await assert.rejects(()=>prepareDockerProfile(t,'gpt',{env,platform:'linux',procRoot:proc,log:noop}),e=>e.code==='profile_path_mismatch');
}));
test('Chrome scan matches exact user-data-dir, ignoring unrelated Chrome and prefixed paths',()=>fixture(async({profile,proc})=>{
 await chrome(proc,101,['/usr/bin/google-chrome-stable','--user-data-dir='+profile+'-other']);
 await chrome(proc,102,['/opt/google/chrome/chrome','--user-data-dir',profile]);
 await chrome(proc,103,['/bin/bash','-c','echo --user-data-dir='+profile]);
 assert.deepEqual(await activeProfilePids(profile,{procRoot:proc}),[102]);
}));
test('No markers and no Chrome leaves profile ready',()=>fixture(async({profile,proc,env})=>{
 const result=await prepareDockerProfile(profile,'gpt',{env,platform:'linux',procRoot:proc,log:noop});
 assert.equal(result.status,'ready');assert.deepEqual(result.removed,[]);
}));
