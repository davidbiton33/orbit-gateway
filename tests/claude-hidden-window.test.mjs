import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hideGatewayBrowserWindow} from '../src/adapters/windows-hide.mjs';
test('never spawns non-Windows process',()=>{assert.equal(hideGatewayBrowserWindow('C:/profile',{platform:'linux',spawnProcess:()=>{throw Error('spawned')}}),false)});
test('Windows invokes profile-specific PowerShell without a visible shell',()=>{let args,options;const result=hideGatewayBrowserWindow('C:\\profile',{platform:'win32',spawnProcess:(command,a,o)=>{args=a;options=o;assert.equal(command,'powershell.exe');return {on(){},unref(){}};}});assert.equal(result,true);assert.equal(args.at(-1),'C:\\profile');assert.equal(options.windowsHide,true);assert.equal(options.stdio,'ignore')});
test('only Claude starts Windows hide watcher',async()=>{const src=await readFile(new URL('../src/adapters/browser.mjs',import.meta.url),'utf8');assert.match(src,/provider==='claude'&&!login&&process.platform==='win32'&&!this.config.claudeHeadless/);});
test('PowerShell checks dedicated profile and process command line',async()=>{const src=await readFile(new URL('../src/adapters/windows-hide.ps1',import.meta.url),'utf8');assert.match(src,/--user-data-dir/);assert.match(src,/GetWindowThreadProcessId/);assert.doesNotMatch(src,/Stop-Process/);});
