#!/bin/bash
set -Eeuo pipefail

if [ "$#" -gt 1 ]; then
  printf 'usage: %s [current-revision-file]\n' "$0" >&2
  exit 2
fi

current_file="${1:-/opt/piik/current/REVISION}"

exec /opt/piik/current/piik-server --check-release --current-file "$current_file"
