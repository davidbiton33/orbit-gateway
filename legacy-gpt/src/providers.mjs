import { GatewayError } from './security.mjs';

export const MODEL_BY_PROVIDER = Object.freeze({
  gemini: Object.freeze({chat: 'gemini-web-chat', image: 'gemini-web-image'}),
  gpt: Object.freeze({chat: 'gpt-web-chat', image: 'gpt-web-image'}),
});

export function resolveProvider(body = {}, kind = 'chat') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GatewayError(400, 'invalid_request', 'Expected a JSON request body');
  }
  if (!['chat', 'image'].includes(kind)) throw new Error('Invalid provider operation');
  const explicit = body.provider;
  if (explicit !== undefined && !Object.hasOwn(MODEL_BY_PROVIDER, explicit)) {
    throw new GatewayError(400, 'unsupported_provider', 'provider must be gemini or gpt');
  }
  const selected = explicit || (typeof body.model === 'string' && body.model.startsWith('gpt-web-') ? 'gpt' : 'gemini');
  const expected = MODEL_BY_PROVIDER[selected][kind];
  if (body.model !== undefined && body.model !== expected) {
    throw new GatewayError(400, 'unsupported_model', `For provider=${selected}, use model=${expected}`);
  }
  return {provider: selected, model: expected};
}

export function modelsList() {
  return Object.entries(MODEL_BY_PROVIDER).flatMap(([provider, categories]) =>
    Object.values(categories).map(id => ({id, object: 'model', owned_by:provider, provider})));
}
