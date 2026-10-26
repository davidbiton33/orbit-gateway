#!/usr/bin/env bash
set -euo pipefail
binary="$(node -e "console.log(require('playwright').chromium.executablePath())")"
exec "$binary" "$@"
