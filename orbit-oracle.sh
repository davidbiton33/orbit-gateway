#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[[ -f .env.docker ]] || { echo 'Run ./install-oracle.sh first.' >&2; exit 1; }
exec docker compose --env-file .env.docker -f docker-compose.oracle.yml "$@"
