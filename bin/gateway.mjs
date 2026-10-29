#!/usr/bin/env node
import {spawnSync} from 'node:child_process';import {readFile,writeFile,mkdir,cp,rename,rm,stat} from 'node:fs/promises';import path from 'node:path';import {createHash,createPublicKey,verify,randomBytes} from 'node:crypto';
import {ROOT,loadConfig} from '../src/lib/config.mjs';import {BrowserHub,loginBrowser} from '../src/adapters/browser.mjs';
import {diagnoseBrowserLaunch} from '../src/adapters/browser-launch.mjs';import {applyUpdate,rollback} from '../src/lib/update.mjs';
const args=process.argv.slice(2),cmd=args[0]||'help';
const SHA=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=async p=>stat(p).then(()=>true).catch(()=>false);
async function doctor(){const cfg=await loadConfig();let problems=0;console.log('ORBIT GATEWAY Doctor · 2.1.0');console.log('Node:',process.version);if(Number(process.versions.node.split('.')[0])<22){console.log('✗ Node >=22 required');problems++;}
 console.log('Token:',cfg.token.length>=43?'configured':'MISSING');if(cfg.token.length<43)problems++;
 for(const [name,origin] of [['GPT legacy',cfg.gptOrigin],['Gemini legacy',cfg.geminiOrigin]]){let ok=false;try{ok=(await fetch(origin+'/health',{headers:{authorization:'Bearer '+cfg.token},signal:AbortSignal.timeout(1900)})).ok;}catch{}console.log(name+':',ok?'reachable':'not reachable; browser mode fallback available');}
 console.log('Browser:',(await exists(path.join(ROOT,'node_modules','playwright')))?'playwright installed':'playwright missing');
 console.log('UI: http://127.0.0.1:'+cfg.uiPort);console.log('API: http://127.0.0.1:'+cfg.apiPort);
 console.log('Windows setup:',path.join(ROOT,'setup-docker.ps1'));
 if(problems)process.exitCode=1;
}
async function update(){
 const cfg=await loadConfig();const adaptersOnly=args.includes('--adapters-only'),dryRun=args.includes('--dry-run');
 const result=await applyUpdate(cfg,{adaptersOnly,dryRun});console.log('Signed update:',JSON.stringify(result,null,2));
 console.log('Restart your gateway process to activate the updated release.');
}
async function init(){const env=path.join(ROOT,'.env');if(await exists(env)){console.log('Existing .env preserved.');return;}
 const legacyRoot=process.env.LEGACY_ROOT||path.resolve(ROOT,'legacy-gpt');
 const legacyContents=await readFile(path.join(legacyRoot,'.env'),'utf8').catch(()=>'');
 const matching=/^\s*GATEWAY_TOKEN\s*=\s*[\"\']?([^\s\"\'#]+)[\"\']?/m.exec(legacyContents);
 const token=matching?.[1]?.length>=43?matching[1]:randomBytes(48).toString('base64url');const data=`# Keep private - do not commit\nGATEWAY_TOKEN=${token}\nAPI_PORT=4984\nSTUDIO_PORT=4983\nGPT_MODE=auto\nGEMINI_MODE=auto\n`;
 await writeFile(env,data,{flag:'wx',mode:0o600});await mkdir(path.join(ROOT,'data'),{recursive:true});console.log('Created .env and data directory. '+(matching?.[1]?.length>=43?'Legacy token reused for worker compatibility.':'New token created.')+' Token not printed.');}
switch(cmd){
 case 'init':await init();break;
 case 'doctor':{
  if(args[1]==='browser'){
   const result=await diagnoseBrowserLaunch(await loadConfig());
   console.log('ORBIT BROWSER Doctor · isolated temporary profile · interactive window');
   console.log(JSON.stringify(result,null,2));
   if(!result.ok)process.exitCode=1;
  }else await doctor();
  break;
 }
 case 'login':{const p=args[1];if(!['gpt','gemini'].includes(p)){console.log('Usage: gateway login gpt|gemini');process.exitCode=2;}else{
  try{
   const cfg=await loadConfig();
   await loginBrowser(p,cfg);
  }
  catch(e){console.error('Browser login failed:',e.message);if(e.detail)console.error('Browser launch details:\n'+e.detail);console.error('If the error mentions a locked profile, close regular Chrome windows before retrying.');process.exitCode=1;}
 }break;}
 case 'update':await update();break;
 case 'rollback':console.log(JSON.stringify(await rollback(),null,2));break;
 case 'help':console.log('gateway init | doctor [browser] | login <gpt|gemini> | update [--from release.zip] | rollback');break;
 default:console.log('Unknown command. Run: node bin/gateway.mjs help');process.exitCode=2;
}
