import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {storeGeneratedDownload,pruneExpiredArtifacts} from '../src/adapters/output-files.mjs';
import {storeGptDownload,pruneExpiredGptFiles} from '../legacy-gpt/src/gpt-files.mjs';
const pdf=Buffer.from('%PDF-1.5\n%%EOF\n');
const fake={suggestedFilename:()=> 'report.pdf',saveAs:name=>writeFile(name,pdf)};
async function missing(file){try{await access(file);return false;}catch{return true;}}
test('Gemini artifact retention removes old files but leaves unrelated files untouched',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'orbit-retention-google-'));
 const config={dataDir:dir,workerProvider:'gemini'};
 try{
  const old=await storeGeneratedDownload(fake,'gemini',config);
  const base=path.join(dir,'generated-files');
  const metadata=path.join(base,old.id+'.json');
  const item=JSON.parse(await readFile(metadata,'utf8'));item.created_at=Date.now()-49*3600000;
  await writeFile(metadata,JSON.stringify(item));
  await writeFile(path.join(base,'unrelated.json'),'keep');
  assert.equal(await pruneExpiredArtifacts(config),1);
  assert.ok(await missing(metadata));
  assert.ok(await missing(path.join(base,old.id+'.bin')));
  assert.equal(await readFile(path.join(base,'unrelated.json'),'utf8'),'keep');
  const fresh=await storeGeneratedDownload(fake,'gemini',config);
  assert.equal(await pruneExpiredArtifacts(config),0);
  assert.equal(await missing(path.join(base,fresh.id+'.bin')),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('ChatGPT legacy artifact retention removes old files only',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'orbit-retention-gpt-'));
 try{
  const old=await storeGptDownload(fake,dir);
  const base=path.join(dir,'orbit-generated-files');
  const metadata=path.join(base,old.id+'.json');
  const item=JSON.parse(await readFile(metadata,'utf8'));item.created_at=Date.now()-49*3600000;
  await writeFile(metadata,JSON.stringify(item));
  assert.equal(await pruneExpiredGptFiles(dir),1);
  assert.ok(await missing(path.join(base,old.id+'.bin')));
  const fresh=await storeGptDownload(fake,dir);
  assert.equal(await pruneExpiredGptFiles(dir),0);
  assert.equal(await missing(path.join(base,fresh.id+'.bin')),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
