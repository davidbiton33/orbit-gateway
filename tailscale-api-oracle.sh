#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
command -v tailscale >/dev/null || { echo 'Install/login to Tailscale first.' >&2; exit 1; }
case "${1:-}" in
  on)
    local_port="$(sed -n 's/^ORBIT_API_PORT=//p' .env.docker)"
    [[ "$local_port" =~ ^[0-9]+$ ]] || { echo 'Invalid API port' >&2; exit 1; }
    code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${local_port}/v1/models" || true)"
    [[ "$code" == 401 ]] || { echo "ABORT: unauthenticated request returned $code (expected 401)" >&2; exit 1; }
    tailscale serve --bg --https=8443 "http://127.0.0.1:${local_port}"
    tailscale serve status
    ;;
  off) tailscale serve --https=8443 off ;;
  status) tailscale serve status ;;
  *) echo "Usage: $0 on|off|status" >&2; exit 2;;
esac
