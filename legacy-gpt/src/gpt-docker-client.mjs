/**
 * Authenticated loopback-only bridge to our OWN Docker GPT worker.
 * The worker is where the logged-in browser lives. Never expose CDP or cookies.
 */
import { GatewayError, validateImageBuffer } from './security.mjs';

export const WORKER_ENDPOINT = 'http://127.0.0.1:4982';
const MAX_ERROR_BYTES = 4096;
const TIMEOUT_MS = 610000;
export function validateWorkerAddress(address) {
  if (address !== WORKER_ENDPOINT) throw new GatewayError(400,'unsafe_worker_url','GPT worker endpoint is fixed to loopback');
  return address;
}

export class DockerGptClient {
  #connected=false;
  constructor(config={}) {
    this.config=config;
    this.token=config.token;
    this.fetcher=config.fetchImpl||fetch;
    this.maxInputBytes=config.maxInputBytes||10*1024*1024;
    this.endpoint=validateWorkerAddress(config.gptWorkerUrl||WORKER_ENDPOINT);
    if(typeof this.token !== 'string' || this.token.length<43)throw new Error('Missing Gateway Token');
  }
  get started(){return this.#connected;}
  async close(){}
  async #request(route,body,{stream=false,timeout=TIMEOUT_MS}={}) {
    let response;
    try {
      response=await this.fetcher(`${this.endpoint}${route}`,{
        method:route==='/health'?'GET':'POST',
        headers:{Authorization:`Bearer ${this.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
        signal:AbortSignal.timeout(timeout),redirect:'error',
      });
    } catch(err) {
      throw new GatewayError(503,'gpt_docker_unreachable',
        'GPT Docker worker is unavailable on 127.0.0.1:4982. Start it using docker compose.');
    }
    if(!response.ok) {
      const info=await response.text().then(t=>t.slice(0,MAX_ERROR_BYTES)).catch(()=> '');
      let parsed;try{parsed=JSON.parse(info);}catch{}
      throw new GatewayError(response.status,parsed?.error?.code||'gpt_worker_error',
        String(parsed?.error?.message||`GPT worker returned HTTP ${response.status}`).slice(0,350));
    }
    this.#connected=true;
    if(stream) {
      if(!String(response.headers.get('content-type')||'').startsWith('text/event-stream'))
        throw new GatewayError(502,'gpt_worker_invalid_stream','Expected SSE from GPT worker');
      return response;
    }
    try {return await response.json();}
    catch{throw new GatewayError(502,'gpt_worker_invalid_json','GPT worker returned invalid JSON');}
  }
  async probe(){try {const data=await this.#request('/session',{} ,{timeout:45000});return data.editor_ready===true;}catch{return false;}}
  async health(){return this.#request('/health',undefined,{timeout:7000});}
  async chat(body){return this.#request('/chat',body);}
  async openChatStream(body){return this.#request('/chat/stream',body,{stream:true});}
  async generate(body){return this.#request('/images/generations',body);}
  async edit({prompt,imageBytes,inputMime,n,aspect_ratio}){
    const mime=validateImageBuffer(imageBytes,this.maxInputBytes);
    if(inputMime&&mime!==inputMime)throw new GatewayError(400,'mime_mismatch','Mismatched image MIME');
    return this.#request('/images/edits',{
      prompt,inputMime:mime,imageBase64:imageBytes.toString('base64'),n,aspect_ratio
    });
  }
}
