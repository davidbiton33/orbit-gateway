#!/usr/bin/env bash
set -euo pipefail
# Docker restart preserves /tmp in the same container; stale X11 locks can
# trick the readiness check into thinking Xvfb is alive.
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
fi
Xvfb :99 -screen 0 1440x960x24 -nolisten tcp -ac > /tmp/gpt-xvfb.log 2>&1 &
XVFB_PID=$!
XREADY=0
for i in $(seq 1 60); do
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo 'Xvfb exited before display became ready' >&2
    cat /tmp/gpt-xvfb.log >&2 || true
    exit 1
  fi
  if [ -S /tmp/.X11-unix/X99 ]; then
    sleep 0.6
    XREADY=1
    break
  fi
  sleep 0.25
done
if [ "$XREADY" != "1" ]; then
  echo 'Xvfb display socket did not appear' >&2
  exit 1
fi
# Chrome's Singleton* entries are process locks, not saved login credentials.
# Docker Compose runs one worker per profile. If a previous container was killed,
# these entries can survive in the persistent volume and crash Chrome at boot.
# Never remove them while a Chrome process is running in this container.
if ! pgrep -x chrome >/dev/null 2>&1 && ! pgrep -x chromium >/dev/null 2>&1; then
  rm -f /home/pwuser/profile/SingletonLock \
        /home/pwuser/profile/SingletonCookie \
        /home/pwuser/profile/SingletonSocket
fi
if [ "${GPT_VIEWER:-0}" = "1" ]; then
  if [ "${#GPT_VNC_PASSWORD}" -lt 12 ]; then echo 'GPT_VNC_PASSWORD missing or too short' >&2; exit 1; fi
  x11vnc -storepasswd "$GPT_VNC_PASSWORD" /tmp/gpt-vnc-pass >/dev/null 2>&1
  chmod 600 /tmp/gpt-vnc-pass
  x11vnc -display :99 -localhost -rfbport 5900 -rfbauth /tmp/gpt-vnc-pass -forever -shared -noxdamage -repeat >/tmp/gpt-vnc.log 2>&1 &
  websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/gpt-novnc.log 2>&1 &
  echo 'noVNC login viewer enabled (bind port 6080 to host loopback only)'
fi
exec node /app/src/gpt-worker.mjs
