// Provider Word -> local PDF conversion. Only runs after a verified Gemini DOCX download.
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {readStoredArtifact,storeConvertedPdf} from './output-files.mjs';
const execFileAsync=promisify(execFile);
export function isPdfRequest(prompt){
 const text=String(prompt||'');
 const pdf=/(?:\bPDF\b|\.pdf\b|פי[ -]?די[ -]?אף)/i.test(text);
 const action=/(?:\b(?:create|generate|make|save|export|download|convert|attach|provide)\b|צור|תיצור|תכין|הכן|להורדה|קובץ|המר|לייצא)/i.test(text);
 return pdf&&action;
}
export function outputPdfName(prompt){
 const name=String(prompt||'').match(/(?:^|[\s"'\\/])([A-Za-z0-9][A-Za-z0-9_.-]{0,90}\.pdf)\b/i)?.[1];
 return name&&!name.includes('..')?name:'gemini-document.pdf';
}
export function wordPromptForPdf(prompt){
 if(!isPdfRequest(prompt))return String(prompt||'');
 return 'Produce a real downloadable Microsoft Word DOCX document instead of a PDF. Orbit will convert the DOCX locally into PDF. Preserve all requested document content and formatting, and include a downloadable .docx attachment (not plain text). Original user request:\n'+String(prompt);
}
function isZip(buf){return buf.length>=4&&buf[0]===0x50&&buf[1]===0x4b&&[[3,4],[5,6],[7,8]].some(([x,y])=>buf[2]===x&&buf[3]===y)}
export async function convertWordArtifactToPdf({artifact,config,prompt,runner=execFileAsync}){
 if(!artifact||!/^file_gemini_[a-f0-9]{32}$/.test(String(artifact.id||''))||!String(artifact.filename||'').toLowerCase().endsWith('.docx'))
  throw Error('A verified Gemini DOCX file is required');
 const saved=await readStoredArtifact(artifact.id,config);
 if(saved.metadata.mime_type!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document'||!isZip(saved.bytes))
  throw Error('Invalid DOCX file signature');
 const folder=await mkdtemp(path.join(tmpdir(),'orbit-word-to-pdf-'));
 try{
  const input=path.join(folder,'input.docx'),output=path.join(folder,'input.pdf');
  await writeFile(input,saved.bytes,{mode:0o600});
  const profile='file://'+path.join(folder,'lo-profile').replaceAll('\\','/');
  await runner('libreoffice',['-env:UserInstallation='+profile,'--headless','--convert-to','pdf:writer_pdf_Export','--outdir',folder,input],{timeout:60000,maxBuffer:1024*1024,env:{...process.env,HOME:folder}});
  const bytes=await readFile(output);
  if(bytes.length<20||bytes.length>20*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')
   throw Error('LibreOffice did not produce a valid PDF');
  return storeConvertedPdf(bytes,'gemini',config,outputPdfName(prompt),artifact.id);
 }finally{await rm(folder,{recursive:true,force:true}).catch(()=>{});}
}
