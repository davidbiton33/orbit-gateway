import {fail} from './errors.mjs';
export const CATALOG={
 gpt:{display:'ChatGPT',native_project:'Projects',defaults:['gpt','gpt-web-chat'],models:['gpt-6','gpt-5.6','gpt-5.5'],efforts:['instant','medium','high','extra_high','pro'],images:true},
 aimode:{display:'Google AI Mode',native_project:'History',defaults:['google-ai-mode','google-ai-mode-fast'],models:[],efforts:[],images:true,imageMethod:'ai_mode_web'},
 gemini:{display:'Gemini',native_project:'Notebooks',defaults:['gemini','gemini-web-chat'],models:['gemini-pro','gemini-flash'],efforts:['low','medium','high'],images:true},
 claude:{display:'Claude',native_project:'Projects',defaults:['claude','claude-web-chat'],models:['claude-sonnet','claude-opus','claude-haiku'],efforts:['low','medium','high'],images:true,imageMethod:'svg_render'}
};
export function identifyModel(model){if(typeof model!=='string'||model.length>70)fail(400,'invalid_model','model parameter must be a short string');
 for(const [provider,p] of Object.entries(CATALOG))if([...p.defaults,...p.models].includes(model))return {provider,requested:model,default:p.defaults.includes(model)};
 fail(422,'model_unknown','Unknown model ID; read /v1/models before sending');}
export function validateRequest(input,feature='chat'){
 if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'invalid_request','Expected JSON object');
 const routing=identifyModel(input.model);
 const p=CATALOG[routing.provider];
 if(feature==='image'&&!p.images)fail(422,'image_not_supported','Selected provider does not support image generation through this gateway');
 const effort=input.reasoning_effort??input.thinking??'auto';
 if(typeof effort!=='string'||!['auto',...p.efforts].includes(effort))fail(422,'invalid_effort','Reasoning effort is not supported for this provider');
 if(input.project_mode==='native'&&!input.native_project_id)fail(422,'native_project_unverified','Select a verified native provider project first');
 const nativeId=input.native_project_id??null;
 if(nativeId!=null){
  if(feature!=='chat'||typeof nativeId!=='string'||!((routing.provider==='gpt'&&/^g-p-[A-Za-z0-9_-]{6,90}$/.test(nativeId))||(routing.provider==='claude'&&/^\/project\/[a-f0-9-]{36}$/.test(nativeId))))
   fail(422,'native_project_unverified','Native project routing is supported only for verified ChatGPT g-p project IDs');
 }
 if(input.project_id!=null&&(!/^[a-zA-Z0-9_-]{1,80}$/.test(String(input.project_id))))fail(422,'invalid_project','project_id contains invalid characters');
 return {...routing,effort,project_id:input.project_id||null,native_project_id:nativeId};
}
export function catalogResponse(){return {object:'list',data:Object.entries(CATALOG).flatMap(([key,p])=>[
 {id:p.defaults[0],object:'model',owned_by:key,selection:'browser_default',verified_model_id:false,capabilities:{chat:true,image_generation:p.images,...(p.imageMethod?{image_method:p.imageMethod}:{}),projects_local:true,projects_native:false}},
 ...p.models.map(model=>({id:model,object:'model',owned_by:key,selection:'requires_live_verification',verified_model_id:false}))
 ])};}
