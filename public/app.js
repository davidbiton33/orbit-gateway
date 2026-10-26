(()=>{'use strict';const $=id=>document.getElementById(id),state={view:'chat',model:'gpt',threads:{gpt:null,gemini:null,claude:null,'google-ai-mode':null},messages:{gpt:[],gemini:[],claude:[],'google-ai-mode':[]},images:{gpt:{conversation:null,count:0},gemini:{conversation:null,count:0},'google-ai-mode':{conversation:null,count:0},claude:{conversation:null,count:0}},lastImage:null,projects:[]};
const api=async(url,body)=>{const r=await fetch('/play'+url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error?.message||v.error||`HTTP ${r.status}`);return v;};
function el(tag,txt,cls){const node=document.createElement(tag);if(cls)node.className=cls;if(txt!==undefined)node.textContent=String(txt);return node;}
function toast(message){const t=$('toast');t.textContent=String(message).slice(0,350);t.classList.add('show');clearTimeout(t.t);t.t=setTimeout(()=>t.classList.remove('show'),4500);}
function setBusy(button,value,text){button.disabled=value;if(text)button.textContent=value?'עובד…':text;}
function setView(view){state.view=view;for(const node of document.querySelectorAll('.view'))node.classList.toggle('active',node.id===view);for(const btn of document.querySelectorAll('[data-view]'))btn.classList.toggle('active',btn.dataset.view===view);if(view==='health')doctor();if(view==='projects'){loadProjects();loadNativeProjects(activeNativeProvider);}}
for(const btn of document.querySelectorAll('[data-view]'))btn.addEventListener('click',()=>setView(btn.dataset.view));
function inlineInto(parent,text){const chunks=String(text).split(/(`[^`\n]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g);for(const c of chunks){if(c.startsWith('`')&&c.endsWith('`'))parent.append(el('code',c.slice(1,-1),'inline-code'));else if(c.startsWith('**')&&c.endsWith('**'))parent.append(el('strong',c.slice(2,-2)));else if(c.startsWith('*')&&c.endsWith('*'))parent.append(el('em',c.slice(1,-1)));else parent.append(document.createTextNode(c));}}
function rich(parent,txt){parent.replaceChildren();let text=String(txt||'').replace(/<CodeBlock\s+language="?([\w+#.-]+)"?[^>]*>([\s\S]*?)<\/CodeBlock>/g,(_,l,c)=>'```'+l+'\n'+c+'\n```');const parts=text.split(/(^```[^\n]*\n[\s\S]*?^```\s*$)/gm);for(const chunk of parts){const match=/^```([^\n]*)\n([\s\S]*?)^```\s*$/m.exec(chunk);if(match){const wrap=el('div');const header=el('div',undefined,'code-title');header.append(el('span',match[1]||'text'));const copy=el('button','Copy');copy.addEventListener('click',()=>navigator.clipboard.writeText(match[2]).then(()=>toast('הקוד הועתק')));header.append(copy);const pre=el('pre');pre.dir='ltr';pre.append(el('code',match[2]));wrap.append(header,pre);parent.append(wrap);}else{for(const l of chunk.split('\n')){if(!l)continue;const p=el('p');if(/^#{1,5} /.test(l)){p.style.fontWeight='bold';inlineInto(p,l.replace(/^#+ /,''));}else inlineInto(p,l);parent.append(p);}}}}
function appendMessage(role,text){const wrap=el('div',undefined,'bubble '+role);wrap.append(el('div',role==='user'?'אתה':'AI Gateway','sender'));const content=el('div');rich(content,text);wrap.append(content);$('messages').append(wrap);$('messages').scrollTop=$('messages').scrollHeight;return content;}
async function refreshUsage(){
 try{
  const data=await api('/v1/usage');
  const g=data.providers?.gemini,a=data.providers?.aimode;
  const format=(p,label)=>label+': '+(p?.chat?.orbit_successes_last_24h??0)+' שיחות, '+(p?.image?.orbit_successes_last_24h??0)+' תמונות ב־24 שעות';
  $('usageMeter').textContent=format(g,'Gemini')+' | '+format(a,'AI Mode')+' · מכסות Google האמיתיות אינן זמינות';
 }catch{$('usageMeter').textContent='מונה השימוש אינו זמין כרגע';}
}
let candidates=[];async function loadModelCandidates(){try{const data=await api('/v1/models');candidates=data.data.filter(x=>x.selection==='requires_live_verification');syncModels();}catch{}}
function syncModels(){const provider=$('chatModel').value;const select=$('chatNamedModel');select.replaceChildren();const def=el('option','ברירת המחדל בדפדפן');def.value='';select.append(def);for(const item of candidates.filter(x=>x.owned_by===provider)){const o=el('option',item.id+' · דורש אימות חי');o.value=item.id;select.append(o);}}
function loadThread(){const model=$('chatModel').value;syncModels();state.model=model;$('messages').replaceChildren();const all=state.messages[model];if(all.length){for(const msg of all)appendMessage(msg.role,msg.text);}else {$('messages').append(el('div',state.threads[model]?'שיחה קיימת חוברה · ההיסטוריה עדיין לא זמינה להצגה כאן. אפשר להמשיך את השיחה.':'שיחה חדשה — שלח הודעה כדי להתחיל.','blank-state'));}$('threadProvider').textContent=model.toUpperCase()+' · צ׳אט';$('threadMeta').textContent=state.threads[model]?'שיחה קיימת · '+state.threads[model].slice(0,12):'שיחה חדשה';const efforts={gpt:['auto','instant','medium','high','extra_high','pro'],gemini:['auto','low','medium','high'],claude:['auto','low','medium','high'],'google-ai-mode':['auto']};$('chatEffort').replaceChildren();for(const x of efforts[model]){const o=el('option',x==='auto'?'ברירת המחדל / ללא שינוי':x);o.value=x;$('chatEffort').append(o);}}
$('chatModel').addEventListener('change',()=>{loadThread();syncNativeProjectSelector();if(['gpt','claude'].includes($('chatModel').value))void loadNativeProjects($('chatModel').value);});$('reset').addEventListener('click',()=>{state.threads[state.model]=null;state.messages[state.model]=[];loadThread();toast('שיחה חדשה נפתחה');});for(const btn of document.querySelectorAll('[data-quick]'))btn.addEventListener('click',()=>{$('prompt').value=btn.dataset.quick;setView('chat');});
$('chatForm').addEventListener('submit',async ev=>{ev.preventDefault();const prompt=$('prompt').value.trim();if(!prompt)return;const model=$('chatModel').value,apiModel=$('chatNamedModel').value||model,effort=$('chatEffort').value,project_id=$('chatProject').value||undefined,native_project_id=['gpt','claude'].includes(model)?($('chatNativeProject').value||undefined):undefined;const button=$('chatSubmit');setBusy(button,true,'שליחה ↗');$('chatInfo').textContent='מתחבר…';if($('messages').querySelector('.blank-state'))$('messages').replaceChildren();appendMessage('user',prompt);const content=appendMessage('assistant','');state.messages[model].push({role:'user',text:prompt});$('prompt').value='';let result='';
 try{const res=await fetch('/play/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:apiModel,reasoning_effort:effort,project_id,native_project_id,conversation_id:state.threads[model]||undefined,messages:[{role:'user',content:prompt}],stream:true})});if(!res.ok){const x=await res.json();throw Error(x.error?.message||'השליחה נדחתה');}const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true}).replace(/\r\n/g,'\n');let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=frame.match(/^event:\s*(.+)$/m)?.[1];const datum=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');if(datum==='[DONE]')continue;try{const chunk=JSON.parse(datum);if(event==='gateway.error')throw Error(chunk.error?.message||'שגיאת זרם');if(chunk.snapshot)result='';const delta=chunk.choices?.[0]?.delta?.content;if(delta)result+=delta;if(chunk.conversation_id){state.threads[model]=chunk.conversation_id;$('threadMeta').textContent='שיחה קיימת · '+chunk.conversation_id.slice(0,12);}rich(content,result);$('messages').scrollTop=$('messages').scrollHeight;}catch(e){if(event==='gateway.error')throw e;}}}
 state.messages[model].push({role:'assistant',text:result});$('chatInfo').textContent='התגובה הושלמה';}catch(err){rich(content,'שגיאה: '+err.message);$('chatInfo').textContent='שגיאה בשליחה';toast(err.message);}finally{setBusy(button,false,'שליחה ↗');void refreshUsage();}});
function imageToUrl(item){if(item.url&&/^https:\/\//.test(item.url))return item.url;const raw=item.b64_json||item.base64;if(raw)return 'data:'+(item.mime_type||'image/png')+';base64,'+raw;return null;}
$('imageForm').addEventListener('submit',async ev=>{ev.preventDefault();const model=$('imageModel').value,prompt=$('imagePrompt').value.trim(),mode=$('imageMode').value,thread=state.images[model],file=$('imageFile').files[0];if(!prompt)return;const button=$('imageSubmit');setBusy(button,true,'✦ יצירה / עריכה');$('imageInfo').textContent='בקשה נשלחה. יצירת תמונה עשויה להימשך…';try{let image; if(file){if(file.size>10e6)throw Error('קובץ גדול מ־10MB');image=await new Promise((ok,bad)=>{const fr=new FileReader();fr.onload=()=>ok(fr.result);fr.onerror=bad;fr.readAsDataURL(file);});}
 const data=await api('/v1/images/generations',{model,prompt,mode,aspect_ratio:$('imageRatio').value,conversation_id:thread.conversation||undefined,image});const result=(data.data||data.images||[])[0];if(!result)throw Error('לא התקבלה תמונה מהשרת');const url=imageToUrl(result);if(!url)throw Error('התקבלה תשובה ללא קובץ תמונה');const img=el('img');img.src=url;img.alt=prompt;$('imageOutput').replaceChildren(img);thread.conversation=data.conversation_id||thread.conversation;thread.count++;state.lastImage={url,model};$('imageCounter').textContent=thread.count+' תמונות';$('imageConversation').textContent=thread.conversation?'שיחה: '+thread.conversation:'ללא מזהה שיחה';$('imageInfo').textContent='התמונה התקבלה. אפשר לערוך שוב.';$('imageEditLast').disabled=false;$('downloadImage').href=url;$('downloadImage').classList.remove('disabled-link');}catch(e){$('imageInfo').textContent='שגיאה: '+e.message;toast(e.message);}finally{setBusy(button,false,'✦ יצירה / עריכה');void refreshUsage();}});
$('newImage').addEventListener('click',()=>{const p=$('imageModel').value;state.images[p].conversation=null;$('imageConversation').textContent='שיחה ויזואלית חדשה';toast('השיחה הוויזואלית אופסה');});$('imageEditLast').addEventListener('click',()=>{$('imageMode').value=($('imageModel').value==='gpt'?'edit':'generate');$('imagePrompt').focus();toast('עריכה בתמונה האחרונה או העלה תמונת מקור');});$('imageModel').addEventListener('change',()=>{$('imageConversation').textContent=state.images[$('imageModel').value].conversation||'שיחה ויזואלית חדשה';});
$('compareForm').addEventListener('submit',async ev=>{ev.preventDefault();const prompt=$('comparePrompt').value.trim();const models=[...document.querySelectorAll('.compareModel:checked')].map(x=>x.value);if(models.length<2){toast('בחר לפחות שני מנועים');return;}$('compareResults').replaceChildren();const btn=$('compareSubmit');setBusy(btn,true,'⇆ השווה עכשיו');for(const m of models){const d=el('div',undefined,'panel');d.append(el('h3',m.toUpperCase()));d.append(el('div','ממתין לתוצאות…'));$('compareResults').append(d);}try{const result=await api('/v1/compare',{models,prompt});$('compareResults').replaceChildren();for(const r of result.results){const d=el('div',undefined,'panel');d.append(el('h3',String(r.provider||r.model).toUpperCase()));if(r.ok){const c=el('div');rich(c,r.text);d.append(c,el('div','מזהה שיחה: '+(r.conversation_id||'ללא'),'compare-meta'));}else d.append(el('div',r.error?.message||'שגיאה','notice'));$('compareResults').append(d);}}catch(e){toast(e.message);$('compareResults').replaceChildren(el('div',e.message,'notice'));}finally{setBusy(btn,false,'⇆ השווה עכשיו');}});
let activeNativeProvider='gpt';
let gptBackend='legacy';
let nativeChatProjects={gpt:[],claude:[]};
function syncNativeProjectSelector(){
 const select=$('chatNativeProject'),selected=select.value;
 select.replaceChildren();
 const none=el('option','ללא פרויקט — שיחה רגילה');none.value='';select.append(none);
 const provider=$('chatModel').value,available=(provider==='gpt'&&gptBackend==='legacy')||provider==='claude';
 select.disabled=!available;
 if(available)for(const p of nativeChatProjects[provider]||[]){
   if(!p.url||!(provider==='gpt'?/^g-p-[a-zA-Z0-9_-]{6,90}$/.test(p.id):/^\/project\/[a-f0-9-]{36}$/.test(p.id)))continue;
   const opt=el('option',p.name);opt.value=p.id;select.append(opt);
 }
 if([...select.options].some(o=>o.value===selected))select.value=selected;
}
function resetChatContext(){const model=$('chatModel').value;state.threads[model]=null;state.messages[model]=[];loadThread();}
$('chatNativeProject').addEventListener('change',()=>{if($('chatNativeProject').value)$('chatProject').value='';resetChatContext();});
$('chatProject').addEventListener('change',()=>{if($('chatProject').value)$('chatNativeProject').value='';resetChatContext();});
$('refreshChatProjects').addEventListener('click',async()=>{await loadNativeProjects($('chatModel').value);toast('רשימת הפרויקטים עודכנה');});

function nativeBase(provider){return {gpt:'https://chatgpt.com/',claude:'https://claude.ai/projects',gemini:'https://gemini.google.com/app'}[provider];}
let instancePorts=null;
async function loadInstancePorts(){try{const r=await fetch('/play/v1/instance',{cache:'no-store'});if(!r.ok)throw Error('instance metadata unavailable');const d=await r.json();if(Number.isInteger(d.api_port)&&Number.isInteger(d.ui_port)&&d.vnc)instancePorts=d;}catch(e){console.warn('Orbit instance port lookup failed:',e.message);}const footer=$('instancePorts');if(footer)footer.textContent=instancePorts?'API '+instancePorts.api_port+' · UI '+instancePorts.ui_port:'פורט API לא זמין · UI '+(location.port||'default');}
function nativeViewer(provider){const key=provider==='gpt'?(gptBackend==='docker'?'gpt':'legacy'):provider;const port=instancePorts?.vnc?.[key];return port?'http://127.0.0.1:'+port+'/vnc.html':null;}
function renderNativeStatus(message){$('nativeProjectStatus').textContent=message;}
async function loadNativeProjectChats(project,container){
 container.replaceChildren(el('div','טוען שיחות של '+project.name+'…','notice'));
 try{
   const data=await api('/v1/projects/native/chats?provider='+encodeURIComponent(project.provider)+'&project_id='+encodeURIComponent(project.id));
   container.replaceChildren();
   const chats=Array.isArray(data.chats)?data.chats:[];
   if(!chats.length){container.append(el('small','לא נמצאו שיחות בדף הסרגל המחובר. ייתכן שיש שיחות נוספות שלא נטענו.'));return;}
   const info=el('small',chats.length+' שיחות מזוהות · ייתכן שהרשימה חלקית');container.append(info);
   for(const chat of chats){
     const row=el('div',undefined,'project-chat-row');
     row.append(el('span',chat.title));
     const open=el('button','פתח ב־Orbit','outline-button');open.type='button';
     open.addEventListener('click',async()=>{
       setBusy(open,true,'פתח ב־Orbit');
       try{
         const result=await api('/v1/projects/native/open-chat',{provider:project.provider,project_id:project.id,chat_url:chat.url});
         $('chatModel').value=project.provider;loadThread();syncNativeProjectSelector();
         $('chatNativeProject').value=project.id;$('chatProject').value='';
         state.threads[project.provider]=result.conversation_id;
         state.messages[project.provider]=Array.isArray(result.messages)?result.messages.filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,text:m.text})):[];
         loadThread();setView('chat');$('prompt').focus();
         if(!state.messages[project.provider].length)toast('השיחה מחוברת. היסטוריה ישנה אינה זמינה כרגע להצגה, אך ניתן להמשיך אותה.');
         else toast('נפתחה שיחה קיימת מתוך '+project.name);
       }catch(e){toast('פתיחת שיחה נכשלה: '+e.message);}
       finally{setBusy(open,false,'פתח ב־Orbit');}
     });
     const link=el('a','ב־'+(project.provider==='gpt'?'ChatGPT':'Claude'),'outline-button');link.href=chat.url;link.target='_blank';link.rel='noopener noreferrer';
     row.append(open,link);container.append(row);
   }
 }catch(e){container.replaceChildren(el('div','לא ניתן לטעון שיחות: '+e.message,'notice'));}
}
$('nativeProjectCreate').addEventListener('submit',async event=>{
 event.preventDefault();
 if(!['gpt','claude'].includes(activeNativeProvider)){toast('יצירה ישירה זמינה ל־ChatGPT ול־Claude');return;}
 const name=$('nativeProjectName').value.trim(),description=$('nativeProjectDescription').value.trim(),button=$('nativeProjectCreate').querySelector('button[type="submit"]');
 if(!name)return;
 setBusy(button,true,'＋ יצירת פרויקט אמיתי');
 try{
   const provider=activeNativeProvider;
   const result=await api('/v1/projects/native',{provider,name,description});
   $('nativeProjectName').value='';
   await loadNativeProjects(provider);
   if(result.project?.id&&(nativeChatProjects[provider]||[]).some(p=>p.id===result.project.id)){
     $('chatModel').value=provider;loadThread();syncNativeProjectSelector();
     $('chatNativeProject').value=result.project.id;
     resetChatContext();
   }
   toast('הפרויקט '+name+' נוצר בחשבון '+(provider==='gpt'?'ChatGPT':'Claude')+' שלך!');
 }catch(e){toast('יצירת הפרויקט: '+e.message+' · בדוק את הרשימה לפני ניסיון נוסף.');}
 finally{setBusy(button,false,'＋ יצירת פרויקט אמיתי');}
});
$('quickNativeCreate').addEventListener('click',()=>{const provider=$('chatModel').value;setView('projects');loadNativeProjects(provider);$('nativeProjectName').focus();});

async function loadNativeProjects(provider='gpt'){
 activeNativeProvider=provider;
 $('nativeProjectCreate').hidden=!((provider==='gpt'&&gptBackend==='legacy')||provider==='claude');
 $('nativeProjectDescription').hidden=provider!=='claude';
 $('nativeProjectNameLabel').textContent='פרויקט חדש ב־'+(provider==='claude'?'Claude':'ChatGPT');
 for(const b of document.querySelectorAll('[data-native-provider]'))b.classList.toggle('active',b.dataset.nativeProvider===provider);
 $('nativeProjectList').replaceChildren();
 if(provider==='gemini')renderNativeStatus('בודק מחברות Gemini בחשבון המחובר (קריאה בלבד)…');
 else renderNativeStatus('טוען פרויקטים קיימים מתוך הדפדפן המחובר ל־'+(provider==='gpt'?'ChatGPT':'Claude')+'…');
 try{
   const response=await api('/v1/projects/native?provider='+encodeURIComponent(provider));
   if(provider!==activeNativeProvider)return;
   const entries=Array.isArray(response.projects)?response.projects:[];
   if(provider==='gpt'||provider==='claude'){
     nativeChatProjects[provider]=entries.filter(p=>p.url&&(provider==='gpt'?/^g-p-[a-zA-Z0-9_-]{6,90}$/.test(p.id||''):/^\/project\/[a-f0-9-]{36}$/.test(p.id||'')));
     syncNativeProjectSelector();
   }
   if(!entries.length){
     const message=provider==='gemini'?'לא הצלחנו לאמת מחברות Gemini בדפדפן המחובר. ייתכן שהתפריט מוסתר, לא נטען או שאינו זמין בחשבון. עד לאימות, אין אפשרות לפתוח שיחה בתוך מחברת דרך Orbit.':response.status==='unverified_empty'?'לא זוהו קישורי פרויקטים בדף. זה לא אומר שאין פרויקטים בחשבון: ייתכן שהסרגל מוסתר, יש צורך באימות, או שמבנה האתר השתנה.':'לא התקבלו פרויקטים מהדפדפן המחובר.';
     renderNativeStatus(message);return;
   }
   renderNativeStatus(response.status==='partial'
     ?'זוהו '+entries.length+' שמות פרויקטים בסרגל ChatGPT. קישורי הניווט הפנימיים עדיין לא זמינים, אבל אפשר לפתוח את הדפדפן המחובר.'
     :'זוהו '+entries.length+(provider==='gemini'?' מחברות Gemini · פתיחה באתר המקורי בלבד, עד שיתאפשר שימוש בתוך המחברת.':' קישורי פרויקטים. הרשימה עשויה להיות חלקית.'));
   for(const p of entries){
     const tile=el('div',undefined,'project-tile');
     const heading=el('strong',p.name),meta=el('small',provider==='gemini'?'מחברת Gemini · קריאה בלבד':'פרויקט מקורי · '+(provider==='gpt'?'ChatGPT':'Claude'));
     tile.append(heading,meta);
     if(((provider==='gpt'&&/^g-p-[a-zA-Z0-9_-]{6,90}$/.test(p.id||''))||(provider==='claude'&&/^\/project\/[a-f0-9-]{36}$/.test(p.id||'')))&&p.url){
       const use=el('button','＋ שיחה חדשה בפרויקט','primary-button');
       use.type='button';use.addEventListener('click',()=>{
         $('chatModel').value=provider;loadThread();syncNativeProjectSelector();
         $('chatNativeProject').value=p.id;$('chatProject').value='';
         resetChatContext();setView('chat');$('prompt').focus();
         toast('נבחר פרויקט '+p.name+' — ההודעה הבאה תישלח בתוכו');
       });tile.append(use);
       const show=el('button','▾ הצגת שיחות בפרויקט','outline-button');show.type='button';
       const chats=el('div',undefined,'project-chat-list');chats.hidden=true;
       show.addEventListener('click',()=>{
         chats.hidden=!chats.hidden;
         show.textContent=chats.hidden?'▾ הצגת שיחות בפרויקט':'▴ הסתר שיחות';
         if(!chats.hidden)loadNativeProjectChats(p,chats);
       });
       tile.append(show,chats);
     }
     if(p.url){
       try{
         const url=new URL(p.url),expected=new URL(nativeBase(provider));
         if(url.origin!==expected.origin)continue;
         const link=el('a','פתיחת הפרויקט באתר הספק','outline-button');
         link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';
         tile.append(link);
       }catch{continue;}
     }else{
       const info=el('small','הפרויקט זוהה בדפדפן, אך לא נמצא קישור ישיר');
       const button=el('button','פתח את הדפדפן המחובר','outline-button');
       button.type='button';button.addEventListener('click',()=>nativeViewer(provider)?window.open(nativeViewer(provider),'_blank','noopener,noreferrer'):toast('לא ניתן לזהות את פורט הדפדפן'));
       tile.append(info,button);
     }
     $('nativeProjectList').append(tile);
   }
 }catch(error){if(provider===activeNativeProvider)renderNativeStatus('ניסיון טעינת הפרויקטים נכשל: '+error.message+'. ניתן לפתוח את הדפדפן הווירטואלי ולבדוק התחברות.');}
}
for(const btn of document.querySelectorAll('[data-native-provider]'))btn.addEventListener('click',()=>loadNativeProjects(btn.dataset.nativeProvider));
$('refreshNative').addEventListener('click',()=>loadNativeProjects(activeNativeProvider));
$('openNativeBrowser').addEventListener('click',()=>nativeViewer(activeNativeProvider)?window.open(nativeViewer(activeNativeProvider),'_blank','noopener,noreferrer'):toast('לא ניתן לזהות את פורט הדפדפן'));
$('openNativeWebsite').addEventListener('click',()=>window.open(nativeBase(activeNativeProvider),'_blank','noopener,noreferrer'));
$('quickCreateProject').addEventListener('click',()=>{setView('projects');$('projectName').focus();});
async function loadProjects(){
 try{
  const result=await api('/v1/projects');state.projects=Array.isArray(result.projects)?result.projects:[];
  $('projectList').replaceChildren();
  $('localProjectCount').textContent=state.projects.length+' פרויקטים';
  const selector=$('chatProject'),selected=selector.value;
  selector.replaceChildren();const none=el('option','ללא פרויקט מקומי');none.value='';selector.append(none);
  for(const p of state.projects){
   const tile=el('div',undefined,'project-tile');tile.append(el('strong',p.name),el('small','Orbit מקומי · '+p.id.slice(0,8)));
   $('projectList').append(tile);
   const option=el('option',p.name);option.value=p.id;selector.append(option);
  }
  if(state.projects.some(p=>p.id===selected))selector.value=selected;
  if(!state.projects.length){
   const empty=el('div',undefined,'project-empty');empty.append(el('strong','עדיין אין פרויקטים מקומיים'),el('p','הזן שם ולחץ על ״יצירת פרויקט מקומי״. פרויקטים מחשבונות ChatGPT ו־Claude מופיעים בנפרד, למעלה.'));
   $('projectList').append(empty);
  }
 }catch(err){$('projectList').replaceChildren(el('div','לא ניתן לטעון פרויקטים מקומיים: '+err.message,'notice'));toast(err.message);}
}
$('projectForm').addEventListener('submit',async e=>{
 e.preventDefault();const button=$('projectForm').querySelector('button[type="submit"]');
 setBusy(button,true,'＋ יצירת פרויקט מקומי');
 try{
  const created=await api('/v1/projects',{name:$('projectName').value,type:'local'});
  $('projectName').value='';await loadProjects();
  if(created.project?.id)$('chatProject').value=created.project.id;
  toast('הפרויקט המקומי נוצר ונבחר בצ׳אט');
 }catch(err){toast('יצירת הפרויקט נכשלה: '+err.message);}
 finally{setBusy(button,false,'＋ יצירת פרויקט מקומי');}
});
const sample=`import OpenAI from 'openai';\n\nconst ai = new OpenAI({\n  baseURL: process.env.AI_GATEWAY_URL,\n  apiKey: process.env.AI_GATEWAY_TOKEN\n});\n\nconst reply = await ai.chat.completions.create({\n  model: 'gpt', // 'gemini' | 'google-ai-mode' | 'claude'\n  messages: [{ role: 'user', content: 'Hello!' }]\n});\n\nconsole.log(reply.choices[0].message.content);`;
$('apiExample').textContent=sample;$('copyCode').addEventListener('click',()=>navigator.clipboard.writeText(sample).then(()=>toast('קוד הועתק')));$('copyCurl').addEventListener('click',()=>navigator.clipboard.writeText('curl -H "Authorization: Bearer $AI_GATEWAY_TOKEN" -H "Content-Type: application/json" -d \'{"model":"gpt","messages":[{"role":"user","content":"Hello"}]}\' "$AI_GATEWAY_URL/chat/completions"').then(()=>toast('דוגמת curl הועתקה')));$('copySkill').addEventListener('click',()=>navigator.clipboard.writeText([
'Connect Orbit from a server-side agent:',
'Oracle: AI_GATEWAY_URL=https://orbit-instance.tail33fc06.ts.net:8443/v1 (Tailscale)',
'Windows v2.3.1: AI_GATEWAY_URL=http://127.0.0.1:5284/v1 (local only)',
'AI_GATEWAY_TOKEN=<store correct installation token in server secrets>',
'Models: gpt | gemini | google-ai-mode | claude (browser defaults; exact versions not verified)',
'Chat: POST /chat/completions JSON {"model":"google-ai-mode","messages":[{"role":"user","content":"Hello"}],"stream":false}',
'Image: POST /images/generations JSON {"model":"google-ai-mode","prompt":"A blue planet","size":"1536x1024","response_format":"binary"}',
'Binary returns image bytes. b64_json returns JSON. size is ratio hint, not pixel guarantee.',
'AI Mode uses Gemini authenticated browser and shared queue; image tested on Oracle, not yet live on Windows.',
'GET /usage reports only local Orbit activity, not actual provider quota.',
'Honor Bearer authentication, 429 limits, 422 validation and safe no-blind-retry after send.',
'See skill/SKILL.md + docs/openapi.yaml for more details.'
].join('\n')).then(()=>toast('הוראות חיבור הועתקו')));
async function doctor(){try{const d=await api('/v1/doctor');gptBackend=d.providers?.find(p=>p.provider==='gpt')?.backend||'legacy';syncNativeProjectSelector();$('nativeProjectCreate').hidden=!((activeNativeProvider==='gpt'&&gptBackend==='legacy')||activeNativeProvider==='claude');$('doctorResults').replaceChildren();$('providerStatuses').replaceChildren();for(const p of d.providers){const good=p.legacy_reachable||p.remote_reachable||p.browser.editor_ready;const tile=el('div',undefined,'doctor-card');tile.append(el('strong',p.provider.toUpperCase()),el('span','מצב: '+p.mode),el('div',good?'מחובר / זמין לבדיקה':'לא אומת חיבור'));$('doctorResults').append(tile);const line=el('div',undefined,'status-line');const dot=el('i',undefined,'dot '+(good?'good':'bad'));line.append(dot,document.createTextNode(p.provider.toUpperCase()+' · '+(good?'זמין':'נדרש חיבור / בדיקה')));$('providerStatuses').append(line);}}catch(e){toast(e.message);}}
$('runDoctor').addEventListener('click',doctor);$('refresh').addEventListener('click',doctor);loadInstancePorts().then(()=>{loadThread();loadProjects();loadModelCandidates();refreshUsage();doctor();loadNativeProjects('gpt');});})();
