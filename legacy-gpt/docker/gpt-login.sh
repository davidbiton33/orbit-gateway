#!/usr/bin/env bash
set -euo pipefail
profile=/home/pwuser/profile
if pgrep -fa 'chrome.*--user-data-dir=/home/pwuser/profile' | grep -v 'gpt-login.sh' >/dev/null; then
  echo 'Legacy GPT browser profile is in use. Close its Chrome windows and retry.' >&2
  exit 3
fi
export DISPLAY=:99
printf '\nOpen http://127.0.0.1:6080/vnc.html locally and unlock its VNC viewer.\n'
printf 'Sign in to ChatGPT in the window. Close all Chrome windows when finished.\n\n'
exec google-chrome-stable --user-data-dir="$profile" --no-first-run --no-default-browser-check --new-window 'https://chatgpt.com/'
