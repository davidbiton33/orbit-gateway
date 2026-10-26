#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[[ "$(uname -m)" == aarch64 ]] || { echo 'ERROR: Oracle package expects ARM64/aarch64.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Docker not installed. See ORACLE_INSTALL_HE.md' >&2; exit 1; }
docker info >/dev/null || { echo 'Docker daemon unavailable. See ORACLE_INSTALL_HE.md' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'openssl is required.' >&2; exit 1; }
if [[ ! -f .env.docker ]]; then
  umask 077
  cat >.env.docker <<EOF
COMPOSE_PROJECT_NAME=orbit-oracle
GATEWAY_TOKEN=$(openssl rand -hex 32)
GPT_VNC_PASSWORD=$(openssl rand -hex 18)
GPT_BACKEND=legacy
ORBIT_UI_PORT=4983
ORBIT_API_PORT=4984
ORBIT_GPT_LEGACY_VNC_PORT=6080
ORBIT_GPT_VNC_PORT=6081
ORBIT_GEMINI_VNC_PORT=6082
ORBIT_CLAUDE_VNC_PORT=6083
EOF
  chmod 600 .env.docker
  echo 'Created new private .env.docker; keep it secure.'
else
  echo 'Retaining existing .env.docker, tokens and Docker volumes.'
fi
bash ./orbit-oracle.sh config --quiet
bash ./orbit-oracle.sh up -d --build gateway gemini claude gpt-legacy
echo 'Orbit Oracle services started. Check: ./orbit-oracle.sh ps'
echo 'Only loopback ports are exposed. Use SSH tunnel for login, Tailscale Serve for private API.'
