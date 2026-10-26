import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const file = async path => readFile(new URL(path, import.meta.url),'utf8');
test('Every fresh installation uses unique project and random credential',async()=>{
  const setup=await file('../setup-docker.ps1');
  assert.match(setup,/NewGuid\(\)\.ToString\('N'\)\.Substring\(0,10\)/);
  assert.match(setup,/COMPOSE_PROJECT_NAME=\$project/);
  assert.match(setup,/GATEWAY_TOKEN=\$\(New-Token 48\)/);
  assert.match(setup,/if \(\$CleanTest -and \(Test-Path/);
  assert.doesNotMatch(setup,/unified-ai-gateway_gpt_browser_profile|docker volume prune|down\s+-v/);
});
test('Clean test creates an independent sibling copy without env or browser data',async()=>{
  const script=await file('../start-clean-test.ps1');
  assert.match(script,/Orbit-Clean-Test-\$id/);
  assert.match(script,/\bsetup-docker\.ps1'\) -CleanTest/);
  assert.match(script,/\bverify-clean\.ps1'\)/);
  assert.doesNotMatch(script,/Copy-Item[^\n]*\.env\.docker|Copy-Item[^\n]*profiles|Remove-Item|docker volume rm/);
});
test('Compose legacy profile is Compose-owned and every port binds loopback',async()=>{
  const compose=await file('../docker-compose.yml');
  assert.match(compose,/^name: \$\{COMPOSE_PROJECT_NAME:-orbit-gateway\}/m);
  assert.match(compose,/  legacy-gpt-profile:\n/);
  assert.doesNotMatch(compose,/\bexternal:\s*true|unified-ai-gateway_gpt_browser_profile/);
  for(const line of compose.split('\n').filter(x=>/\$\{ORBIT_.*PORT:/.test(x))){
    assert.match(line,/127\.0\.0\.1:/);
  }
  const mappings=compose.match(/127\.0\.0\.1:\$\{ORBIT_[A-Z_]+_PORT:-\d+\}/g)||[];
  assert.equal(mappings.length,6);
});
test('Clean verification rejects any foreign mounted volume',async()=>{
  const script=await file('../verify-clean.ps1');
  assert.match(script,/com\.docker\.compose\.project/);
  assert.match(script,/NOT ISOLATED/);
  assert.match(script,/\$mount\.Name\.StartsWith/);
});
