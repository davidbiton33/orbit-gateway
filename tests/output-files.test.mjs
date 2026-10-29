import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {cleanFilename,isFileCandidate,validArtifactId,artifactProvider,storeGeneratedDownload,readStoredArtifact,newOutputLinks} from '../src/adapters/output-files.mjs';
test('file names are stripped of directories, control chars and unsafe bytes',()=>{
 assert.equal(cleanFilename('../../report.pdf'),'report.pdf');
 assert.equal(cleanFilename('C:\\\\temp\\\\note.docx'),'note.docx');
 assert.equal(cleanFilename('bad<name>.zip'),'bad_name_.zip');
});
test('only allowed formats from relevant provider hosts are download candidates',()=>{
 assert.equal(isFileCandidate({href:'https://claude.ai/api/artifact/report.pdf',filename:'report.pdf'},'claude'),true);
 assert.equal(isFileCandidate({href:'https://evil.example/report.pdf',filename:'report.pdf'},'claude'),false);
 assert.equal(isFileCandidate({href:'javascript:alert(1)',filename:'report.pdf'},'claude'),false);
 assert.equal(isFileCandidate({href:'https://gemini.google.com/download/doc.docx',filename:'doc.docx'},'gemini'),true);
 assert.equal(isFileCandidate({href:'https://gemini.google.com/download/tool.exe',filename:'tool.exe'},'gemini'),false);
 assert.equal(isFileCandidate({href:'https://claude.ai/download/report.pdf',filename:'report.pdf'},'gemini'),false);
 assert.equal(isFileCandidate({kind:'button',filename:'export.csv',href:''},'claude'),true);
 assert.equal(isFileCandidate({kind:'button',filename:'export.csv',href:''},'gemini'),true);
 assert.equal(isFileCandidate({kind:'button',filename:'malware.exe',href:''},'claude'),false);
 assert.equal(isFileCandidate({kind:'link',filename:'report.csv',href:'sandbox:/mnt/data/report.csv'},'claude'),true);
});
test('new link snapshots exclude older response files',()=>{
 const prior=[{href:'https://claude.ai/a.pdf'}],now=[...prior,{href:'https://claude.ai/b.zip'}];
 assert.deepEqual(newOutputLinks(prior,now).map(x=>x.href),['https://claude.ai/b.zip']);
});
test('store files privately and retrieve only matching scoped worker with correct MIME',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'orbit-output-test-'));
 const config={dataDir,workerProvider:'claude'};
 const pdf=Buffer.from('%PDF-1.6\n1 0 obj\nendobj\n%%EOF\n');
 const fake={suggestedFilename:()=> 'Quarterly Report.pdf',saveAs:async filename=>{const {writeFile}=await import('node:fs/promises');await writeFile(filename,pdf);}};
 try{
  const artifact=await storeGeneratedDownload(fake,'claude',config);
  assert.ok(validArtifactId(artifact.id));
  assert.equal(artifactProvider(artifact.id),'claude');
  assert.equal(artifact.filename,'Quarterly Report.pdf');
  assert.equal(artifact.download_url,'/v1/files/'+artifact.id+'/content');
  const result=await readStoredArtifact(artifact.id,config);
  assert.deepEqual(result.bytes,pdf);
  await assert.rejects(()=>readStoredArtifact(artifact.id,{dataDir,workerProvider:'gemini'}),{code:'worker_scope'});
  await assert.rejects(()=>readStoredArtifact('../danger',{dataDir}),{code:'invalid_file_id'});
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
test('invalid file signature does not create a valid file',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'orbit-output-invalid-'));
 const fake={suggestedFilename:()=> 'suspicious.pdf',saveAs:async filename=>{const {writeFile}=await import('node:fs/promises');await writeFile(filename,'not really pdf');}};
 try{await assert.rejects(()=>storeGeneratedDownload(fake,'gemini',{dataDir}),{code:'file_signature_invalid'});}
 finally{await rm(dataDir,{recursive:true,force:true});}
});
