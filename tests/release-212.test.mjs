import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const file=async name=>readFile(new URL('../'+name,import.meta.url),'utf8');
test('Studio ports are loaded from the current instance without leaking secrets',async()=>{
 const server=await file('src/server.mjs'),app=await file('public/app.js'),html=await file('public/index.html');
 assert.match(server,/p==='\/play\/v1\/instance'/);
 assert.match(server,/process\.env\.ORBIT_API_PORT/);
 assert.match(server,/process\.env\.ORBIT_GEMINI_VNC_PORT/);
 assert.doesNotMatch(html,/API 4984 · UI 4983/);
 assert.match(app,/fetch\('\/play\/v1\/instance'/);
 assert.match(app,/instancePorts\?\.vnc/);
 assert.doesNotMatch(app,/127\.0\.0\.1:4984/);
});
test('Tailscale only proxies authenticated API and uses instance-specific port',async()=>{
 const cmd=await file('tailscale-api.ps1');
 assert.match(cmd,/ORBIT_API_PORT/);
 assert.match(cmd,/StatusCode -ne 401/);
 assert.match(cmd,/tailscale serve --bg/);
 assert.match(cmd,/http:\/\/127\.0\.0\.1:\$localPort/);
 assert.doesNotMatch(cmd,/tailscale funnel|serve.*ORBIT_UI_PORT|serve.*VNC_PORT/i);
});
test('Clean test copies remote API manager and shows actual directory',async()=>{
 const s=await file('start-clean-test.ps1');
 assert.match(s,/'tailscale-api.ps1'/);
 assert.match(s,/Set-Location -LiteralPath/);
 assert.match(s,/release source folder/);
});
