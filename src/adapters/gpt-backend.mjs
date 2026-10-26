import {GatewayError} from '../lib/errors.mjs';

export const GPT_BACKENDS=Object.freeze(['docker','legacy']);
const prefix=backend=>'gpt_'+backend+'_';

export function unpackGptConversation(id,backend){
 if(!id)return null;
 if(!GPT_BACKENDS.includes(backend))throw new Error('Unknown GPT backend');
 for(const other of GPT_BACKENDS){
  if(id.startsWith(prefix(other))){
   if(other!==backend)throw new GatewayError(409,'gpt_backend_changed','This GPT conversation belongs to the '+other+' backend. Start a new conversation after changing GPT_BACKEND; the message was not sent.');
   return id.slice(prefix(other).length);
  }
 }
 // Pre-switch Orbit conversation IDs belong to the Docker browser worker.
 if(backend==='docker')return id;
 throw new GatewayError(409,'gpt_backend_changed','The previous GPT conversation has no backend marker. Start a new conversation after switching to legacy; the message was not sent.');
}
export function packGptConversation(id,backend){
 if(!id)return null;
 if(!GPT_BACKENDS.includes(backend))throw new Error('Unknown GPT backend');
 if(id.startsWith(prefix(backend)))return id;
 return prefix(backend)+id;
}
export function applyGptBackendResult(result,backend){
 if(!result||typeof result!=='object')return result;
 return {...result,conversation_id:packGptConversation(result.conversation_id,backend)};
}
