#!/bin/bash
set -Eeuo pipefail

if [ "$#" -gt 1 ]; then
  printf 'usage: %s [current-revision-file]\n' "$0" >&2
  exit 2
fi

current_file="${1:-/opt/screener/current/REVISION}"

exec /opt/screener/current/screener-server --check-release --current-file "$current_file"
