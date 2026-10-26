/* Hide ONLY the window owned by the Gateway's Claude profile. No changes to login sessions. */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'windows-hide.ps1');
export function hideGatewayBrowserWindow(profileDir,{platform=process.platform,spawnProcess=spawn}={}){
 if(platform!=='win32')return false;
 const child=spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',script,'-ProfileDir',profileDir],{windowsHide:true,detached:true,stdio:'ignore'});
 child.on?.('error',err=>console.warn('[CLAUDE-HIDE] Window hiding failed:',err.message));
 child.unref?.();
 return true;
}
