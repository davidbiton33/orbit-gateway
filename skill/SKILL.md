---
name: orbit-personal-ai-gateway
summary: Server-side agent connection to private browser-backed Orbit Gateway.
---
# Agent instructions - Orbit Gateway v2.3.1
1. Read AI_GATEWAY_URL and AI_GATEWAY_TOKEN from SERVER secrets, never browser code, screenshots, prompts, logs or repositories.
2. Oracle URL: https://your-orbit-host.your-tailnet.ts.net:8443/v1 (Tailscale). Windows 2.3.1 URL: http://127.0.0.1:5284/v1 (local). Different tokens/profiles.
3. Model aliases: gpt, gemini, google-ai-mode, claude. Aliases select browser provider defaults; exact foundation model is NOT guaranteed. Fast aliases/models and thinking efforts require live verification.
4. Chat POST /v1/chat/completions JSON example: {"model":"google-ai-mode","messages":[{"role":"user","content":"Hello"}],"stream":false}. Pass Authorization: Bearer $AI_GATEWAY_TOKEN.
5. Image POST /v1/images/generations JSON example: {"model":"google-ai-mode","prompt":"Blue planet","size":"1536x1024","response_format":"binary"}. Binary returns raw image bytes, not JSON. For JSON use response_format=b64_json.
6. Image size is a ratio hint, NOT guaranteed pixel dimensions: 1024x1024 (1:1), 1536x1024 (3:2), 1024x1536 (2:3), 1792x1024 (16:9), 1024x1792 (9:16). Aspect ratios auto, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3. Avoid conflicting size+ratio.
7. GPT image features depend on configured backend; Gemini and Google AI Mode generate raster images; Claude creates SVG illustrations which Orbit renders to PNG, NOT photorealistic native Claude imagery. AI Mode images work using an additional tab in Gemini's logged-in browser and SHARE Gemini's FIFO queue.
8. AI Mode image generation passed live test on Oracle; Windows requires a separate login and live test. AI Mode image edits are not supported and conversation continuation is experimental. Do not advertise unsupported capabilities.
9. Keep conversation_id per provider. Never blindly retry if a browser prompt might have been submitted. For stream=true parse OpenAI-compatible SSE, including gateway.error events.
10. GET /v1/usage contains only Orbit-observed 24-hour successes and optional local guardrails. Google account quotas and remaining balance are unknown. GET /v1/queue shows pending and active provider work.
11. Respect 422, 429, 503, 504 failures. Give image generation at least 180-240 seconds of client timeout. Local project_id does not guarantee provider-native project context.
12. This is a browser automation integration, not an official API service. Respect provider terms, sign-in checks and quota restrictions. Do not leak credentials or silently switch providers.
