#!/bin/bash
set -Eeuo pipefail

if [ "$#" -gt 1 ]; then
  printf 'usage: %s [current-revision-file]\n' "$0" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node="${SCREENER_NODE:-/usr/local/bin/node}"
current_file="${1:-/opt/screener/current/REVISION}"

if [ ! -x "$node" ]; then
  printf 'Node runtime is unavailable: %s\n' "$node" >&2
  exit 2
fi
arguments=("$repo_root/scripts/release-update.mjs" "--current-file" "$current_file")
exec "$node" "${arguments[@]}"
