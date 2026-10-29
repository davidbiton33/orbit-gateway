# Orbit Gateway for Oracle Cloud Ampere A1 (ARM64)

Oracle ARM64 distribution of the same Orbit Gateway v2.4.1 source code as Windows, with a platform-specific Docker image and separate persistent browser volumes. Validate provider sessions after any upgrade. Read `ORACLE_INSTALL_HE.md` before use.

Start: `./install-oracle.sh`; manage: `./orbit-oracle.sh`; private remote API: `./tailscale-api-oracle.sh on`.

Keep your stable Windows release unchanged. Never migrate cookies or tokens from the original installation.


## Orbit 2.3.1 — Agent/API update (2026-10-26)

For up-to-date copy/paste instructions open the Studio API tab, or see skill/SKILL.md.
The OpenAPI reference is docs/openapi.yaml; capabilities are docs/CAPABILITIES_HE.md.
Oracle API: https://your-orbit-host.your-tailnet.ts.net:8443/v1 (Tailscale, Bearer token).
Windows v2.3.1 local API: http://127.0.0.1:5284/v1 (independent token/session).
Supported provider aliases: gpt, gemini, google-ai-mode.
Image POST /v1/images/generations accepts response_format=binary for direct image bytes or
b64_json for JSON, and size=1536x1024 as a 3:2 composition hint (not guaranteed pixels).
Google AI Mode image generation has been live-tested on Oracle with the authenticated Gemini
browser session; images have not yet been live-tested on Windows. Google account quota remains
unknown; GET /v1/usage provides Orbit-local counters only.
