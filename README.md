# Orbit Gateway

Browser-backed OpenAI-compatible AI gateway for ChatGPT, Gemini, Google AI Mode and Claude.

[Windows download](https://orbit-gateway.surge.sh/) | [API](docs/openapi.yaml) | [Agent skill](skill/SKILL.md) | [Tailscale](scripts/TAILSCALE-REMOTE-HE.md)

Features: unified text chat, SSE streaming, image generation, browser login profiles, Studio, API, usage tracking, and shared Gemini/AI Mode browser and queue.

## Installation

Windows: use the [download page](https://orbit-gateway.surge.sh/). Node.js 22+ required. See [Hebrew setup](INSTALL_HE.md).

Oracle ARM64: see [Oracle installation](ORACLE_INSTALL_HE.md) and install-oracle.sh.

Private remote access: use [Tailscale setup](scripts/TAILSCALE-REMOTE-HE.md), with Serve rather than public Funnel.

## API

Use bearer token from your own local environment and POST /v1/chat/completions or /v1/images/generations. See docs/openapi.yaml and skill/SKILL.md.

## Limitations and security

Unofficial browser automation, not affiliated with AI providers. Provider UI/quotas may change. Never commit credentials, cookies or browser profiles. Studio has no separate password; do not expose it to public internet. Google AI Mode image generation validated on Oracle, not yet on all Windows devices.

## License

MIT (LICENSE).
