import { randomUUID } from 'node:crypto';
import { GatewayError, validateImageBuffer } from './security.mjs';

const ROLES = new Set(['system','developer','user','assistant']);
const MAX_MESSAGES = 40;
const MAX_TEXT = 32000;
const MAX_DATA_URL = 14 * 1024 * 1024;

function imageFromDataUrl(url, maxInputBytes) {
  if (typeof url !== 'string' || !url.startsWith('data:image/')) {
    throw new GatewayError(400,'remote_image_not_supported','Only inline base64 data:image URLs are accepted; external image URLs are deliberately blocked.');
  }
  if (url.length > MAX_DATA_URL) throw new GatewayError(413,'image_limit','Image data URL is too large');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/]+={0,2})$/i.exec(url);
  if (!match || match[2].length % 4 === 1) throw new GatewayError(400,'invalid_image','Invalid image data URL');
  const bytes = Buffer.from(match[2],'base64');
  const mime = validateImageBuffer(bytes,maxInputBytes);
  if (match[1].toLowerCase() !== mime) throw new GatewayError(400,'mime_mismatch','Inline image MIME does not match image bytes');
  return {bytes,mime};
}

function parseContent(content, maxInputBytes) {
  if (typeof content === 'string') return {text:content, image:null};
  if (!Array.isArray(content)) throw new GatewayError(400,'invalid_messages','Message content must be a string or an array of text/image_url parts');
  let text = '', image = null;
  for (const part of content) {
    if (!part || typeof part !== 'object') throw new GatewayError(400,'invalid_messages','Invalid message content part');
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new GatewayError(400,'invalid_messages','Text part must contain text');
      text += (text ? '\n' : '')+part.text;
    } else if (part.type === 'image_url') {
      if (image) throw new GatewayError(400,'too_many_images','Only one image per request is supported');
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      image = imageFromDataUrl(url,maxInputBytes);
    } else throw new GatewayError(400,'unsupported_content_part','Supported content types: text, image_url');
  }
  return {text,image};
}

export function parseChatRequest(payload,{maxInputBytes=10485760, allowedModels=['gemini-web-chat']}={}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GatewayError(400,'invalid_request','Expected a JSON object');
  if (payload.model && !allowedModels.includes(payload.model)) throw new GatewayError(400,'unsupported_model','Use gemini-web-chat');
  if (payload.stream !== undefined && typeof payload.stream !== 'boolean') throw new GatewayError(400,'invalid_stream','stream must be boolean');
  if (payload.stream_mode !== undefined && !['deltas','snapshots'].includes(payload.stream_mode)) throw new GatewayError(400,'invalid_stream_mode','stream_mode must be deltas or snapshots');
  if (payload.stream_mode && payload.stream !== true) throw new GatewayError(400,'invalid_stream_mode','stream_mode requires stream=true');
  if (payload.tools?.length || payload.tool_choice && payload.tool_choice !== 'none') throw new GatewayError(400,'tools_unsupported','Function calling/tools are not supported by the web gateway');
  if (payload.conversation_id !== undefined && (typeof payload.conversation_id !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.conversation_id))) {
    throw new GatewayError(400,'invalid_conversation_id','conversation_id must be a UUID returned by this gateway');
  }
  if (!Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > MAX_MESSAGES) {
    throw new GatewayError(400,'invalid_messages',`messages must contain 1-${MAX_MESSAGES} messages`);
  }
  const parsed = payload.messages.map((message,i)=>{
    if (!message || !ROLES.has(message.role)) throw new GatewayError(400,'invalid_messages',`Invalid role in message ${i}`);
    const content = parseContent(message.content,maxInputBytes);
    return {role:message.role, ...content};
  });
  const newest = parsed.at(-1);
  if (newest.role !== 'user') throw new GatewayError(400,'invalid_messages','Last message must have role=user');
  if (!newest.text.trim() && !newest.image) throw new GatewayError(400,'invalid_messages','Last user message is empty');
  if (parsed.some((m,i)=>Boolean(m.image) && i !== parsed.length-1)) {
    throw new GatewayError(400,'historical_images_unsupported','Image input must be attached to the final user message');
  }
  const isContinuation = Boolean(payload.conversation_id);
  // With conversation_id, Gemini already knows the dialogue. Never replay all prior messages.
  // Without one, replay supplied text history into a new Gemini conversation.
  const prompt = isContinuation ? newest.text.trim() || 'Describe the attached image.' :
    parsed.map((m,i)=>`[${m.role.toUpperCase()}${i===parsed.length-1?' · CURRENT REQUEST':''}]\n${m.text.trim() || '[attached image]'}`).join('\n\n');
  if (prompt.length > MAX_TEXT) throw new GatewayError(413,'prompt_limit',`Total prompt context is limited to ${MAX_TEXT} characters`);
  return {
    prompt,
    imageBytes:newest.image?.bytes ?? null,
    inputMime:newest.image?.mime ?? null,
    conversationId: payload.conversation_id ?? null,
    includeImages:payload.include_images === true,
  };
}

export function chatResponse({text,conversationId,images=[]}) {
  return {
    id:`chatcmpl-${randomUUID()}`,
    object:'chat.completion',
    created:Math.floor(Date.now()/1000),
    model:'gemini-web-chat',
    choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],
    conversation_id:conversationId,
    ...(images.length ? {images:images.map(({bytes,mime})=>({mime_type:mime,b64_json:bytes.toString('base64')}))}:{}),
    usage:null,
  };
}
