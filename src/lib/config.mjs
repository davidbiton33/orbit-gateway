import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function parseEnv(content){const result={};for(const line of String(content).split(/\r?\n/)){
 const m=/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);if(!m)continue;
 let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
 result[m[1]]=v;
}return result;}
export async function loadConfig(overrides={}){
 const env={...parseEnv(await readFile(path.join(ROOT,'.env'),'utf8').catch(()=>'')),...process.env,...overrides};
 // GPT_BACKEND is an Orbit-front routing decision, never a worker override.
 const backend=env.GPT_BACKEND&&(!env.WORKER_PROVIDER)?env.GPT_BACKEND:null;
 if(backend&&!['legacy','docker'].includes(backend))throw new Error('GPT_BACKEND must be legacy or docker');
 return {gptBackend:backend,token:env.GATEWAY_TOKEN||'',apiHost:env.GATEWAY_API_HOST||'127.0.0.1',uiHost:env.GATEWAY_UI_HOST||'127.0.0.1',uiDisabled:env.GATEWAY_UI_DISABLED==='true',remoteStudioHost:env.ORBIT_REMOTE_STUDIO_HOST||'',workerProvider:env.WORKER_PROVIDER||'',apiPort:Number(env.API_PORT||4984),uiPort:Number(env.STUDIO_PORT||4983),
  gptOrigin:backend==='legacy'?(env.GPT_LEGACY_ORIGIN||'http://gpt-legacy:4982'):(env.GPT_ORIGIN||'http://127.0.0.1:4982'),geminiOrigin:env.GEMINI_ORIGIN||'http://127.0.0.1:4981',aimodeOrigin:env.AIMODE_ORIGIN||'http://127.0.0.1:4986',aimodeMode:env.AIMODE_MODE||'remote',
  gptMode:backend?(backend==='legacy'?'legacy':'remote'):(env.GPT_MODE||'auto'),geminiMode:env.GEMINI_MODE||'auto',
  dataDir:path.resolve(env.GATEWAY_DATA_DIR||path.join(ROOT,'data')),browserHeadless:env.BROWSER_HEADLESS==='true',browserChannel:env.GATEWAY_BROWSER_CHANNEL||'auto',
  requestTimeoutMs:Number(env.REQUEST_TIMEOUT_MS||240000),updateManifestUrl:env.UPDATE_MANIFEST_URL||'',updatePublicKey:env.UPDATE_PUBLIC_KEY||''};
}
