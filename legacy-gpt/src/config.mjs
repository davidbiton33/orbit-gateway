import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

export const CONFIG = Object.freeze({
  hostname: '127.0.0.1', // intentionally NOT configurable
  port: 4981,
  token: process.env.GATEWAY_TOKEN ?? '',
  profileDir: path.join(ROOT, '.private-session'),
  channel: process.env.BROWSER_CHANNEL || undefined,
  geminiUrl: 'https://gemini.google.com/app',
  // Diagnostic comparison only. Never changes visible Gemini responses.
  geminiNetworkShadow:process.env.GEMINI_NETWORK_SHADOW==='1',
  generationTimeoutMs: Math.min(Math.max(Number(process.env.GEMINI_GENERATION_TIMEOUT_MS) || 120000, 20000), 300000),
  maxInputBytes: 10 * 1024 * 1024,
  maxJsonBodyBytes: 15 * 1024 * 1024,
  allowedOrigins: (process.env.GATEWAY_ALLOWED_ORIGINS || '').split(',').map(x=>x.trim()).filter(Boolean),
  maxOutputBytes: 20 * 1024 * 1024,
  maxQueue: 4,
  jobsDir:path.join(ROOT,'.jobs'),
  jobsMaxActive:Math.min(Math.max(Number(process.env.JOBS_MAX_ACTIVE)||6,1),15),
  jobsMaxConcurrent:Math.min(Math.max(Number(process.env.JOBS_MAX_CONCURRENT)||2,1),4),
  jobsGeminiConcurrent:1,
  jobsGptConcurrent:Math.min(Math.max(Number(process.env.JOBS_GPT_CONCURRENT)||2,1),4),
  jobsRetryLimit:Math.min(Math.max(Number(process.env.JOBS_SAFE_RETRIES)||2,0),5),
  jobsPriorityAgingMs:Math.min(Math.max(Number(process.env.JOBS_PRIORITY_AGING_MS)||60000,5000),3600000),
  jobsTtlHours:Math.min(Math.max(Number(process.env.JOBS_TTL_HOURS)||24,1),168),
  jobsWebhookUrl:process.env.JOBS_WEBHOOK_URL||'',
  jobsWebhookHost:process.env.JOBS_WEBHOOK_HOST||'',
  jobsWebhookSecret:process.env.JOBS_WEBHOOK_SECRET||'',
  gptProfileDir:path.join(ROOT,'.private-gpt-session'),
  gptBackend:process.env.GPT_BACKEND==='docker'?'docker':'native',
  gptWorkerUrl:'http://127.0.0.1:4982',
  gptChannel:process.env.GPT_BROWSER_CHANNEL || 'chrome',
  gptTimeoutMs:Math.min(Math.max(Number(process.env.GPT_GENERATION_TIMEOUT_MS)||360000,20000),600000),
});

export function assertConfigured(config = CONFIG) {
  if (typeof config.token !== 'string' || config.token.length < 43) {
    throw new Error('Gateway token is missing/too short. Run: npm run setup');
  }
}
