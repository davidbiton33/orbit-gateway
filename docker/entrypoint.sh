#!/usr/bin/env bash
set -euo pipefail
if [[ "${ORBIT_ROLE:-gateway}" == "worker" ]]; then
  export DISPLAY=:99
  Xvfb :99 -screen 0 1360x900x24 -nolisten tcp -ac >/tmp/orbit-xvfb.log 2>&1 &
  sleep 1
  if ! kill -0 $! 2>/dev/null; then echo 'Xvfb failed:'; cat /tmp/orbit-xvfb.log; exit 1; fi
  x11vnc -display :99 -rfbport 5900 -listen 127.0.0.1 -forever -shared -nopw -quiet >/tmp/orbit-vnc.log 2>&1 &
  websockify --web=/usr/share/novnc/ 0.0.0.0:6080 127.0.0.1:5900 >/tmp/orbit-websockify.log 2>&1 &
  # Virtual display is local to this container; no host GUI or host browser process.
fi
exec node /app/src/server.mjs
