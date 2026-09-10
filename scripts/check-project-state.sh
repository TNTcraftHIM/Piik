#!/bin/sh
set -eu

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

while IFS= read -r path || [ -n "$path" ]; do
  [ -z "$path" ] && continue
  if ! git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    echo "Required project artifact is not Git-tracked: $path" >&2
    exit 1
  fi
done < scripts/required-project-paths.txt

git diff --check
git diff --cached --check

if [ -n "${PIIK_BASE_SHA:-}" ] && [ "$PIIK_BASE_SHA" != "0000000000000000000000000000000000000000" ]; then
  git diff --check "$PIIK_BASE_SHA"...HEAD
fi

node scripts/check-docs.mjs

echo "Repository hygiene checks passed."
