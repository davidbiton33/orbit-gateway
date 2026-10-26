#!/usr/bin/env bash
set -euo pipefail
node /app/docker/healthcheck.mjs
if [[ "${ORBIT_ROLE:-gateway}" == "worker" ]]; then
  pgrep -x Xvfb >/dev/null
  pgrep -x x11vnc >/dev/null
  curl -fS --max-time 3 'http://127.0.0.1:6080/vnc.html' >/dev/null
fi
