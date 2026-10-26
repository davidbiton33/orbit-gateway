#!/usr/bin/env bash
set -euo pipefail
if [[ "${ORBIT_ROLE:-}" != "worker" || -z "${WORKER_PROVIDER:-}" ]]; then
  echo 'Run this command inside an Orbit provider worker.' >&2; exit 2
fi
provider="$WORKER_PROVIDER"
case "$provider" in
  gpt) url='https://chatgpt.com/' ;;
  gemini) url='https://gemini.google.com/app' ;;
  claude) url='https://claude.ai/new' ;;
  *) echo 'Unknown worker provider' >&2; exit 2 ;;
esac
profile="${GATEWAY_DATA_DIR:-/app/data}/profiles/${provider}"
mkdir -p "$profile"
logfile="/tmp/orbit-${provider}-login-chrome.log"
# The worker may already have launched a managed Chrome for this profile.
# Never launch another Chrome against the same user-data-dir.
if pgrep -fa "chrome.*--user-data-dir=${profile}" | grep -v 'login-native.sh' >/dev/null; then
  printf '\n%s browser is already using its profile.\n' "$provider"
  printf 'Close its Chrome windows in noVNC, then run this command again.\n'
  printf 'Do not delete the Docker volume or Chrome lock files.\n'
  exit 3
fi
printf '\nOrbit | %s sign-in\n' "$provider"
printf 'Open the %s noVNC page and sign in in the Chrome window.\n' "$provider"
printf 'When finished, CLOSE ALL CHROME WINDOWS (not just the tab).\n'
printf 'This command will finish automatically after Chrome exits.\n'
printf 'Technical Chrome logs: %s (inside the container).\n\n' "$logfile"
# Keep Chrome's noisy D-Bus/GPU diagnostics out of the user-facing terminal.
# Preserve the actual exit status and do not report that sign-in itself was verified.
set +e
"${ORBIT_LOGIN_BROWSER:-google-chrome-stable}" "--user-data-dir=$profile" \
  --no-sandbox --disable-dev-shm-usage --password-store=basic \
  --no-first-run --no-default-browser-check --new-window "$url" \
  >"$logfile" 2>&1
status=$?
set -e
if ((status != 0)); then
  printf 'Chrome exited with status %s. Inspect %s inside the container.\n' "$status" "$logfile" >&2
  exit "$status"
fi
printf '\nChrome closed. Profile files remain in the Docker volume.\n'
printf 'Return to Orbit Studio and verify %s by sending a message.\n' "$provider"
