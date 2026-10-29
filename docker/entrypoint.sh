#!/usr/bin/env bash
set -euo pipefail
if [[ "${ORBIT_ROLE:-gateway}" == "worker" ]]; then
  export DISPLAY=:99
  # A container restart can leave an X11 socket/lock in its ephemeral /tmp.
  # Never delete a live Xvfb lock; browser profile/Chrome locks are untouched.
  if ! pgrep -x Xvfb >/dev/null 2>&1; then
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  fi
  Xvfb :99 -screen 0 1360x900x24 -nolisten tcp -ac >/tmp/orbit-xvfb.log 2>&1 &
  XVFB_PID=$!
  READY=0
  for n in $(seq 1 60); do
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
      echo 'Xvfb failed:' >&2; cat /tmp/orbit-xvfb.log >&2; exit 1
    fi
    if [ -S /tmp/.X11-unix/X99 ]; then READY=1; break; fi
    sleep 0.25
  done
  if [ "$READY" != "1" ]; then echo 'Xvfb display did not become ready' >&2; exit 1; fi
  x11vnc -display :99 -rfbport 5900 -listen 127.0.0.1 -forever -shared -nopw -quiet >/tmp/orbit-vnc.log 2>&1 &
  websockify --web=/usr/share/novnc/ 0.0.0.0:6080 127.0.0.1:5900 >/tmp/orbit-websockify.log 2>&1 &
  # Virtual display is local to this container; no host GUI or host browser process.
fi
exec node /app/src/server.mjs
