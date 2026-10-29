import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {safeFilename,isGptFileLink,storeGptDownload,readGptFile,FILE_ID,newGptLinks} from '../legacy-gpt/src/gpt-files.mjs';
import {makeNativeSse} from '../legacy-gpt/src/gpt-native.mjs';
test('GPT generated file URLs restricted to authenticated provider origins',()=>{
 const good={href:'https://chatgpt.com/backend-api/report',filename:'report.pdf'};
 assert.equal(isGptFileLink(good),true);
 assert.equal(isGptFileLink({...good,href:'https://evil.invalid/report.pdf'}),false);
 assert.equal(isGptFileLink({...good,href:'javascript:alert(1)'}),false);
 assert.equal(isGptFileLink({href:'sandbox:/mnt/data/generated-report.csv',filename:'generated-report.csv'}),true);
 assert.equal(isGptFileLink({href:'sandbox:/etc/passwd',filename:'generated-report.csv'}),false);
 assert.equal(isGptFileLink({...good,filename:'virus.exe'}),false);
 assert.equal(isGptFileLink({...good,href:'blob:https://chatgpt.com/a1b2'}),true);
 assert.equal(safeFilename('../a/report.pdf'),'report.pdf');
});
test('GPT file baseline excludes older links',()=>{
 const before=[{href:'https://chatgpt.com/old.pdf'}];
 const now=[...before,{href:'https://chatgpt.com/new.zip'}];
 assert.deepEqual(newGptLinks(before,now).map(x=>x.href),['https://chatgpt.com/new.zip']);
});
test('GPT worker file persistence verifies PDF and protects provider IDs',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'orbit-gpt-files-'));
 try{
  const fake={suggestedFilename:()=> 'דוח.pdf',saveAs:async location=>writeFile(location,Buffer.from('%PDF-1.4\n%%EOF\n'))};
  const f=await storeGptDownload(fake,dir);
  assert.ok(FILE_ID.test(f.id));
  assert.equal(f.mime_type,'application/pdf');
  assert.equal(f.filename,'דוח.pdf');
  const result=await readGptFile(f.id,dir);
  assert.equal(result.bytes.toString('utf8'),'%PDF-1.4\n%%EOF\n');
  await assert.rejects(()=>readGptFile('../secret',dir),{code:'invalid_file_id'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Reject non-PDF payload claiming to be PDF',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'orbit-gpt-invalid-'));
 try{
  const fake={suggestedFilename:()=> 'report.pdf',saveAs:async location=>writeFile(location,'not a pdf')};
  await assert.rejects(()=>storeGptDownload(fake,dir),{code:'file_signature_invalid'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('GPT native SSE includes attachments and file warning in final metadata',()=>{
 const f={id:'file_gpt_0123456789abcdef0123456789abcdef',filename:'document.docx',size:100,mime_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
 const s=makeNativeSse();
 const body=s.start()+s.progress('Here is the file')+s.complete('Here is the file','thread1','gpt-dom',[f],'One file unavailable');
 assert.match(body,/"attachments":\[/);
 assert.match(body,/"file_warning":"One file unavailable"/);
 assert.match(body,/data: \[DONE\]/);
});
