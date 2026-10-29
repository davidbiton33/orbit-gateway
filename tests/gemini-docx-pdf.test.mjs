import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {storeGeneratedDownload,readStoredArtifact} from '../src/adapters/output-files.mjs';
import {isPdfRequest,outputPdfName,wordPromptForPdf,convertWordArtifactToPdf} from '../src/adapters/document-export.mjs';

test('PDF requests route to DOCX only for explicit document requests',()=>{
 assert.equal(isPdfRequest('Generate a PDF file named test.pdf'),true);
 assert.equal(isPdfRequest('צור לי קובץ PDF עם דוח'),true);
 assert.equal(isPdfRequest('What is a PDF?'),false);
 assert.equal(isPdfRequest('Generate a CSV file'),false);
 assert.equal(outputPdfName('Create a PDF called quarterly.pdf'),'quarterly.pdf');
 assert.equal(outputPdfName('Generate file named report.pdf'),'report.pdf');
 const forward=wordPromptForPdf('Create a PDF file with the title Hello');
 assert.match(forward,/DOCX document/);
 assert.match(forward,/Create a PDF file with the title Hello/);
});
test('PDF conversion uses only verified DOCX bytes and preserves PDF signature + metadata',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'orbit-word-convert-test-'));
 const cfg={dataDir:dir,workerProvider:'gemini'};
 try{
  const fakeZip=Buffer.from([0x50,0x4b,0x03,0x04,1,2,3,4]);
  const word=await storeGeneratedDownload({suggestedFilename:()=> 'source.docx',saveAs:dest=>writeFile(dest,fakeZip)},'gemini',cfg);
  let ran=false;
  const runner=async(binary,args)=>{
   assert.equal(binary,'libreoffice');
   assert.ok(args.includes('--headless'));
   const input=args.at(-1),out=path.join(path.dirname(input),'input.pdf');
   ran=true;
   await writeFile(out,Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n'));
  };
  const pdf=await convertWordArtifactToPdf({artifact:word,config:cfg,prompt:'Generate a PDF named report.pdf',runner});
  assert.equal(ran,true);
  assert.equal(pdf.filename,'report.pdf');
  assert.equal(pdf.mime_type,'application/pdf');
  assert.equal(pdf.source,'orbit_docx_to_pdf');
  const saved=await readStoredArtifact(pdf.id,cfg);
  assert.equal(saved.bytes.subarray(0,5).toString(),'%PDF-');
  assert.equal(saved.metadata.original_word_id,word.id);
  await assert.rejects(()=>convertWordArtifactToPdf({artifact:{...word,filename:'report.csv'},config:cfg,prompt:'Create PDF'}),/DOCX/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
