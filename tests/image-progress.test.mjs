import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageProgressTracker,isImageProgressText,isImageFailureText,isImageCompletionText,classifyImageText,normalizeImageUiText} from '../src/adapters/image-progress.mjs';

test('English in-progress variations: words, order, tense, case and punctuation',()=>{
 for(const phrase of [
  'Creating your image…','Generating image','Your image is being generated','RENDERING THE ILLUSTRATION',
  "I'm working on your picture!",'Putting the finishing touches on your image',
  'Your photo is on its way.','Image generation in progress','Preparing a new graphic for you',
  'Processing your picture now',
 ])assert.equal(isImageProgressText(phrase),true,phrase);
});
test('Hebrew in-progress variations: gender, prefixes, punctuation, niqqud',()=>{
 for(const phrase of [
  'יוצר את התמונה שלך...', 'יוצרת עכשיו תמונה', 'מייצרים עבורך את האיור',
  'אני מכינה לך את התמונה', 'מכין תמונה', 'יצירת התמונה מתבצעת',
  'התמונה שלך בדרך', 'התמונה בהכנה', 'מעבדת את התמונה כעת',
  'כרגע בתהליך יצירת התמונה', 'מְיַיצֵּר תמונה',
  'אני עובדת על האיור שלך',
 ])assert.equal(isImageProgressText(phrase),true,phrase);
});
test('English/Hebrew refusal variants classified as failures, not progress',()=>{
 for(const phrase of [
  'This image cannot be generated.','I cannot create that image',
  "I don't seem to have access to that content",'Something went wrong. Please try again.',
  'Image generation failed','Unable to generate the image',
  'לא ניתן ליצור את התמונה הזו','אני לא יכולה לייצר תמונה כרגע',
  'לא הצלחתי ליצור את האיור','אירעה שגיאה ביצירת התמונה',
  'מצטערת, אין לי גישה לתוכן הזה','יצירת התמונה נכשלה',
 ]){
  assert.equal(isImageFailureText(phrase),true,phrase);
  assert.equal(isImageProgressText(phrase),false,phrase);
 }
});
test('Finished image messages are NOT progress signals (English and Hebrew)',()=>{
 for(const phrase of [
  'Here’s your generated image.','Here is your image','Your image is ready!',
  'Your image has been generated successfully.',
  'הנה התמונה שלך!', 'התמונה מוכנה', 'יצרתי עבורך תמונה',
  'התמונה נוצרה בהצלחה', 'סיימתי ליצור את האיור',
 ]){
  assert.equal(isImageCompletionText(phrase),true,phrase);
  assert.equal(isImageProgressText(phrase),false,phrase);
 }
});
test('User commands, ordinary discussion and stray status must not be accepted as a generated image',()=>{
 for(const phrase of ['Create an image','Can you make a photo?',
   'Explain how to create an image', 'I can create images',
   'צור תמונה של כלב','איך יוצרים תמונה','אתה יכול ליצור תמונה?',
   'Let me explain image generation', 'Here is a description, not an image',
 ])assert.equal(isImageProgressText(phrase),false,phrase);
 assert.equal(normalizeImageUiText('  הַתְּמוּנָה  שלך ... '),'התמונה שלך');
});
test('Visible image is the only immediate success state',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 assert.equal(t.observe({now:1200,text:'יצירת התמונה נכשלה',imageReady:true}).phase,'image_ready');
});
test('Refusals in both languages stop promptly even with old progress status',()=>{
 for(const text of ['This image cannot be generated.','לא ניתן ליצור את התמונה']){
  const t=new ImageProgressTracker({startedAt:0});
  t.observe({now:1000,statusText:'Generating your image'});
  t.observe({now:2000,text,statusText:'Generating your image'});
  assert.equal(t.observe({now:4100,text,statusText:'Generating your image'}).phase,'text_error');
 }
});
test('A persistent generation indicator does not pretend to be unlimited progress',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 assert.equal(t.observe({now:1000,statusText:'יוצר את התמונה'}).phase,'generating');
 assert.equal(t.observe({now:45000,statusText:'יוצר את התמונה'}).phase,'generating');
 assert.equal(t.observe({now:68000,statusText:'יוצר את התמונה'}).phase,'stalled');
});
test('Busy generation is not prematurely labelled stalled',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 t.observe({now:1000,statusText:'Generating your image',busy:true});
 assert.equal(t.observe({now:120000,statusText:'Generating your image',busy:true}).phase,'generating');
});
test('Ordinary final text ends with text-only error after grace window',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 t.observe({now:1000,text:'Normally I can help but not with this.'});
 assert.equal(t.observe({now:13000,text:'Normally I can help but not with this.'}).phase,'text_only');
});
test('Completion text after generation holds a short grace for the pixels',()=>{
 for(const result of ['Here is your image','הנה התמונה שלך']){
  const t=new ImageProgressTracker({startedAt:0});
  t.observe({now:1000,statusText:'Generating your image'});
  assert.equal(t.observe({now:20000,text:result,statusText:'Generating your image'}).phase,'finalizing');
  assert.equal(t.observe({now:45000,text:result,statusText:'Generating your image'}).phase,'finalizing');
  assert.equal(t.observe({now:52000,text:result,statusText:'Generating your image'}).phase,'text_only');
 }
});
test('A final text answer overrides a stale progress toast after grace period',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 t.observe({now:1000,statusText:'מייצרת את התמונה'});
 t.observe({now:2000,text:'I can help you with a description instead.',statusText:'מייצרת את התמונה'});
 assert.equal(t.observe({now:20000,text:'I can help you with a description instead.',statusText:'מייצרת את התמונה'}).phase,'generating');
 assert.equal(t.observe({now:33000,text:'I can help you with a description instead.',statusText:'מייצרת את התמונה'}).phase,'text_only');
});
test('Progress wording changes reset idle timer',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 t.observe({now:1000,statusText:'Preparing the image'});
 t.observe({now:55000,statusText:'Generating the image'});
 assert.equal(t.observe({now:100000,statusText:'Generating the image'}).phase,'generating');
});
test('Brief refusal followed by actual pixels resolves to image, not text error',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 t.observe({now:1000,text:'I cannot generate that image'});
 assert.equal(t.observe({now:3500,imageReady:true}).phase,'image_ready');
});
test('A status-only refusal is detected without an assistant message',()=>{
 const t=new ImageProgressTracker({startedAt:0});
 t.observe({now:1000,statusText:'אירעה שגיאה'});
 assert.equal(t.observe({now:3400,statusText:'אירעה שגיאה'}).phase,'text_error');
});
test('Phrase classification precedence: refusal over generating and completed states',()=>{
 assert.equal(classifyImageText('Creating image failed'),'failure');
 assert.equal(classifyImageText('Here is your generated image'),'completion');
 assert.equal(classifyImageText('יוצרת תמונה בשבילך'),'progress');
});
