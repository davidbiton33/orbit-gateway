#!/usr/bin/env node
/** Maintainer-only signed update release publisher. Run on maintainer's secured machine. */
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';import path from 'node:path';
import {ROOT} from '../src/lib/config.mjs';
const [base,privateKeyPath,version,...files]=process.argv.slice(2);
if(!base||!privateKeyPath||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version||'')||files.length<1){console.error('Usage: node scripts/create-update-release.mjs https://your-r2.example/updates/stable /private/key.pem 2.0.1 config/selectors.json');process.exit(2);}
const baseURL=new URL(base);if(baseURL.protocol!=='https:')throw Error('Requires HTTPS base URL');
const key=createPrivateKey(await readFile(privateKeyPath));const publicKey=createPublicKey(key).export({format:'der',type:'spki'}).toString('base64');
const dir=path.join(ROOT,'release-output',version);await mkdir(dir,{recursive:true});const manifest={version,files:[]};
for(const name of files){if(name.startsWith('/')||name.includes('..')||name.includes('\\')||!(/^(config\/selectors\.json|src\/(?:server\.mjs|(?:adapters|lib)\/[a-z0-9-]+\.mjs)|public\/(?:app\.js|style\.css|index\.html))$/.test(name)))throw Error('Illegal release path: '+name);
 const data=await readFile(path.join(ROOT,name));const basename=name.replace(/\//g,'--');await writeFile(path.join(dir,basename),data);manifest.files.push({path:name,sha256:createHash('sha256').update(data).digest('hex'),url:new URL(basename,base.replace(/\/$/,'')+'/').toString()});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(path.join(dir,'latest.json'),bytes);await writeFile(path.join(dir,'latest.json.sig'),sign(null,bytes,key));
console.log('Release package:',dir);console.log('UPLOAD files from this folder to:',base);console.log('UPDATE_MANIFEST_URL='+new URL('latest.json',base.replace(/\/$/,'')+'/').toString());console.log('UPDATE_PUBLIC_KEY='+publicKey);console.log('Do not publish private key or release secrets.');
