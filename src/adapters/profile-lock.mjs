/* Safely recover Chrome ProcessSingleton symlinks for an isolated Docker worker.
 * Never remove browser profile data, cookies, or locks while a matching Chrome process is alive.
 * Only operates for the worker's own provider + dedicated Docker volume.
 */
import {readdir,readFile,lstat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {GatewayError} from '../lib/errors.mjs';

const MARKERS=['SingletonLock','SingletonSocket','SingletonCookie'];
const processName=/^(?:google-chrome(?:-stable)?|chrome|chromium(?:-browser)?)$/i;
export async function activeProfilePids(profileDir,{procRoot='/proc'}={}){
 const items=await readdir(procRoot,{withFileTypes:true});
 const match=[];const target=path.resolve(profileDir);
 for(const item of items){
  if(!item.isDirectory()||!/^[0-9]+$/.test(item.name))continue;
  let raw;
  try{raw=await readFile(path.join(procRoot,item.name,'cmdline'));}
  catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')continue;throw e;}
  const args=raw.toString('utf8').split('\0').filter(Boolean);
  if(!args.length||!processName.test(path.basename(args[0])))continue;
  const idx=args.findIndex(x=>x.startsWith('--user-data-dir='));
  const separateIdx=args.indexOf('--user-data-dir');
  const profile=idx>=0?args[idx].slice('--user-data-dir='.length):
    (separateIdx>=0?args[separateIdx+1]||'':'');
  if(profile&&path.resolve(profile)===target)match.push(Number(item.name));
 }
 return match;
}
export async function prepareDockerProfile(profileDir,provider,{
 env=process.env,platform=process.platform,procRoot='/proc',log=console
}={}){
 if(platform!=='linux'||env.ORBIT_ROLE!=='worker'||env.WORKER_PROVIDER!==provider)return {status:'not_docker_worker'};
 const expected=path.resolve(env.GATEWAY_DATA_DIR||'/app/data','profiles',provider);
 if(path.resolve(profileDir)!==expected)throw new GatewayError(500,'profile_path_mismatch','Refusing recovery outside the expected provider profile');
 const active=await activeProfilePids(profileDir,{procRoot});
 if(active.length){
  log.warn('[ORBIT-PROFILE-IN-USE]',JSON.stringify({provider,active_pids:active}));
  throw new GatewayError(409,'browser_profile_in_use',
   `${provider} Chrome is still running in noVNC (PID ${active.join(', ')}). Close its window in noVNC, then send the request again. The prompt has NOT been submitted.`);
 }
 const removed=[];
 for(const marker of MARKERS){
  const file=path.join(profileDir,marker);
  let info;
  try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  // Only Chrome-created symlinks; never remove arbitrary files, directories or user data.
  if(!info.isSymbolicLink())throw new GatewayError(409,'profile_lock_unexpected_type',`${provider} profile has a non-symlink ${marker}; refusing to change it.`);
  await unlink(file);removed.push(marker);
 }
 if(removed.length)log.info('[ORBIT-PROFILE-RECOVERED]',JSON.stringify({provider,removed}));
 return {status:removed.length?'recovered':'ready',removed};
}
