#!/bin/bash
set -Eeuo pipefail

if [ "$#" -ne 0 ]; then
  printf 'usage: %s\n' "$0" >&2
  exit 2
fi

exec /opt/piik/current/piik-server --check-release
