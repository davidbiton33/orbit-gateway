# Orbit Gateway

Local-first, experimental, browser-backed AI gateway for ChatGPT, Gemini, Google AI Mode Lite and, with a Hebrew Studio UI and OpenAI-compatible API.

**Download Windows:** https://orbit-gateway.surge.sh/

**Guides:** [Windows setup](README-START-HE.md) · [Tailscale remote access](TAILSCALE-REMOTE-HE.md) · [Agent instructions](skill/SKILL.md) · [API schema](docs/openapi.yaml)

> Unofficial integration. Orbit automates provider websites, not official provider APIs. Provider UI changes, account challenges and quotas can break flows.

## Capabilities

| Provider | Chat | Image generation | Note |
|---|---|---|---|
| ChatGPT | Yes | Backend dependent | Legacy worker required for supported image flows |
| Gemini | Yes | Yes | Authenticated browser |
| Google AI Mode Lite | Experimental | Yes | Shares Gemini browser and FIFO queue |
| | Yes | SVG illustration | SVG rendered to PNG, not native photorealism |

Aliases represent browser defaults, not guaranteed model IDs. See [capabilities](docs/CAPABILITIES_HE.md).

## Windows v2.4.1 Friends preview

Install Node.js 22 or newer. Clone the repository or download the ZIP from the site; in PowerShell run:

    powershell -ExecutionPolicy Bypass -File .\START-WINDOWS.ps1

The first launch creates local .env with a random Bearer token and installs dependencies and Chromium. Studio listens on http://127.0.0.1:5283 and the API on http://127.0.0.1:5284/v1. Sign into providers manually. Never commit .env, data or browser sessions.

For private remote access through your own Tailscale network:

    powershell -ExecutionPolicy Bypass -File .\ENABLE-TAILSCALE.ps1

Restart Orbit afterward. To expose the authenticated API too, add -ExposeApi. Read [Tailscale security and install instructions](TAILSCALE-REMOTE-HE.md). Never use Funnel: Studio has no independent password, and authorized Tailnet peers could interact with connected AI accounts.

## Oracle ARM / Docker

Oracle is a separate deployment with separate secrets, browser state, network and service configuration. Use [Oracle setup](ORACLE_INSTALL_HE.md) and [Oracle compose](docker-compose.oracle.yml). Do not migrate .env.docker or browser profiles into Windows.

## API

The backend must provide AI_GATEWAY_URL and AI_GATEWAY_TOKEN as server-side secrets. Available routes include /v1/chat/completions, /v1/images/generations, /v1/models, /v1/capabilities, /v1/usage and /v1/queue. Images support binary and b64_json output and aspect ratio hints. Read [agent skill](skill/SKILL.md).

## Document and file export

ChatGPT Legacy can return downloaded generated files. Gemini can return native DOCX files, convert requested tables to CSV (identified as \u0060orbit_table_conversion\u0060), and fulfill PDF requests by downloading native DOCX and converting it locally with LibreOffice (identified as \u0060orbit_docx_to_pdf\u0060). Browser-backed provider behavior varies by session and UI. Oracle uses the ARM64 LibreOffice image; Windows standalone mode needs LibreOffice on PATH for Gemini PDF conversion. Generated file downloads are token-protected and expire after 48 hours.

## Development

    npm ci
    npm test

GitHub Actions CI runs Node.js 22 tests and JavaScript syntax checks. These are not equivalent to verified provider sign-in or a fresh Windows install.

## Security

Credentials remain local. Do not upload .env, profiles, browser cookies, account content or tokens. Respect provider terms and sign-in flows. See [security policy](SECURITY.md). No affiliation with OpenAI, Google.

## Status

Community preview; AI Mode image generation verified live on Oracle. New Windows installations require their own provider sign-in and end-to-end verification.
