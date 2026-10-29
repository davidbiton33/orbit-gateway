// Convert a Gemini response table into a local CSV attachment, only when explicitly requested.
// Do not pretend Gemini provided a native file. No provider scripts or credentials are accessed.
import {storeConvertedCsv} from './output-files.mjs';

const EXT_RE=/\.(?:csv|pdf|docx|xlsx|pptx|zip)$/i;
export function isCsvRequest(prompt){
 const value=String(prompt||'');
 return /(?:\bCSV\b|\.csv\b|סי[\s-]?אס[\s-]?וי|קובץ\s+CSV)/i.test(value)&&
  /(?:\b(?:download|save|export|create|generate|make|attach|convert|turn|provide)\b|להורדה|צור|תיצור|תכין|הכן|המר|לייצא|ליצור|תמיר)/i.test(value);
}
export function outputCsvName(prompt){
 const name=String(prompt||'').match(/(?:^|[\s"'\\/])([A-Za-z0-9][A-Za-z0-9_.-]{0,90}\.csv)\b/i)?.[1];
 return name&&!name.includes('..')?name:'gemini-table.csv';
}
function validRows(rows){
 if(!Array.isArray(rows)||rows.length<2||rows.length>2000)return null;
 const first=rows[0];
 if(!Array.isArray(first)||first.length<2||first.length>50)return null;
 const width=first.length;
 for(const row of rows){
  if(!Array.isArray(row)||row.length!==width)return null;
  for(const item of row){
   if(typeof item!=='string'||item.length>4096)return null;
  }
 }
 return rows;
}
function removeOuterPipes(s){
 const parts=s.trim().split('|');
 if(parts[0]?.trim()==='')parts.shift();
 if(parts.at(-1)?.trim()==='')parts.pop();
 return parts.map(x=>x.trim().replace(/\\\|/g,'|'));
}
function isMarkdownDivider(cells){
 return cells.every(s=>/^:?-{3,}:?$/.test(s.replace(/\s/g,'')));
}
export function rowsFromText(text){
 const lines=String(text||'').split(/\r?\n/);
 // Markdown pipe tables with a required divider immediately after the header.
 for(let i=0;i<lines.length-2;i++){
  if(!lines[i].includes('|')||!lines[i+1].includes('|'))continue;
  const header=removeOuterPipes(lines[i]),separator=removeOuterPipes(lines[i+1]);
  if(header.length<2||header.length!==separator.length||!isMarkdownDivider(separator))continue;
  const rows=[header];
  for(let j=i+2;j<lines.length&&lines[j].includes('|');j++){
   const cells=removeOuterPipes(lines[j]);
   if(cells.length!==header.length)break;
   rows.push(cells);
  }
  if(validRows(rows))return rows;
 }
 // TSV from a copied/rendered table. Require consistent two-plus columns.
 for(let i=0;i<lines.length-1;i++){
  if(!lines[i].includes('\t'))continue;
  const row=lines[i].split('\t').map(x=>x.trim());
  if(row.length<2)continue;
  const rows=[row];
  for(let j=i+1;j<lines.length;j++){
   const cells=lines[j].split('\t').map(x=>x.trim());
   if(cells.length!==row.length||!lines[j].includes('\t'))break;
   rows.push(cells);
  }
  if(validRows(rows))return rows;
 }
 return null;
}
export async function rowsFromGeminiDom(page){
 const rows=await page.evaluate(()=>{
  const root=[...document.querySelectorAll('model-response,[data-test-id="model-response"]')].at(-1);
  if(!root)return null;
  const tables=[...root.querySelectorAll('table')];
  const table=tables.at(-1);
  if(!table)return null;
  const tr=[...table.querySelectorAll('tr')].slice(0,2000);
  return tr.map(element=>[...element.children].filter(cell=>['TH','TD'].includes(cell.tagName)).map(cell=>(cell.innerText||cell.textContent||'').trim()));
 }).catch(()=>null);
 return validRows(rows);
}
function safeCsvCell(value){
 let text=String(value);
 // Avoid spreadsheet formula injection (also for values with leading spaces).
 if(/^[\s]*[=+@-]/u.test(text))text="'"+text;
 return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
}
export function rowsToCsv(rows){
 if(!validRows(rows))throw Error('invalid_csv_table');
 return rows.map(cells=>cells.map(safeCsvCell).join(',')).join('\n')+'\n';
}
export async function convertGeminiTableToCsv({page,reply,prompt,config}){
 if(!isCsvRequest(prompt))return null;
 const rows=await rowsFromGeminiDom(page)||rowsFromText(reply);
 if(!rows)return null;
 const content=rowsToCsv(rows);
 return storeConvertedCsv(content,'gemini',config,outputCsvName(prompt));
}
