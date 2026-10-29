import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {isCsvRequest,rowsFromText,rowsToCsv,outputCsvName,convertGeminiTableToCsv,rowsFromGeminiDom} from '../src/adapters/table-export.mjs';
import {readStoredArtifact} from '../src/adapters/output-files.mjs';

test('Gemini CSV export triggers only when the user explicitly requests a CSV file',()=>{
 assert.equal(isCsvRequest('Create a downloadable CSV file named orbit-table.csv'),true);
 assert.equal(isCsvRequest('צור קובץ CSV להורדה'),true);
 assert.equal(isCsvRequest('What is a CSV file?'),false);
 assert.equal(isCsvRequest('Make a Word document named report.docx'),false);
 assert.equal(isCsvRequest('Summarize the table'),false);
 assert.equal(outputCsvName('Create orbit-data.csv as downloadable CSV'),'orbit-data.csv');
 assert.equal(outputCsvName('צור קובץ CSV להורדה'),'gemini-table.csv');
});
test('parse Markdown table with divider without mistaking narrative for rows',()=>{
 const rows=rowsFromText('Here is the table:\n\n| status | value |\n| :--- | ---: |\n| ok | 1 |\n\nDone.');
 assert.deepEqual(rows,[['status','value'],['ok','1']]);
 assert.equal(rowsToCsv(rows),'status,value\nok,1\n');
 assert.equal(rowsFromText('I cannot create a CSV file right now.'),null);
 assert.equal(rowsFromText('| status | value |\n| ok | 1 |'),null);
});
test('parse tab-delimited table and quote CSV / neutralize dangerous spreadsheet formulas',()=>{
 const rows=rowsFromText('status\tvalue\nok\t1\n');
 assert.deepEqual(rows,[['status','value'],['ok','1']]);
 assert.equal(rowsToCsv([['name','content'],['alice','has comma, and "quote"'],['bob','=IMPORTXML("x")']]),
  'name,content\nalice,"has comma, and ""quote"""\nbob,"\'=IMPORTXML(""x"")"\n');
});
test('Gemini local CSV artifact can be fetched and is explicitly marked as Orbit-converted',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'orbit-gemini-csv-'));
 const config={dataDir:dir,workerProvider:'gemini'};
 try{
  const page={evaluate:async()=>null};
  const file=await convertGeminiTableToCsv({page,reply:'| status | value |\n| --- | --- |\n| ok | 1 |',prompt:'Create a downloadable CSV file named orbit-check.csv',config});
  assert.equal(file.filename,'orbit-check.csv');
  assert.equal(file.source,'orbit_table_conversion');
  assert.match(file.id,/^file_gemini_[a-f0-9]{32}$/);
  const result=await readStoredArtifact(file.id,config);
  assert.equal(result.bytes.toString('utf8'),'status,value\nok,1\n');
  assert.equal(result.metadata.source,'orbit_table_conversion');
  await assert.rejects(()=>readStoredArtifact(file.id,{dataDir:dir,workerProvider:'claude'}),{code:'worker_scope'});
  assert.equal(await convertGeminiTableToCsv({page,reply:'No table in this answer.',prompt:'Create a CSV file',config}),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Gemini DOM table is preferred over unrelated text',async()=>{
 const page={evaluate:async()=>[['item','price'],['pen','2']]};
 assert.deepEqual(await rowsFromGeminiDom(page),[['item','price'],['pen','2']]);
 assert.deepEqual((await convertGeminiTableToCsv({page,reply:'No markdown',prompt:'Create downloadable CSV',config:{dataDir:await mkdtemp(path.join(os.tmpdir(),'orbit-conversion-test-')),workerProvider:'gemini'}}))?.source,'orbit_table_conversion');
});
