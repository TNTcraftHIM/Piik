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

untracked=$(git ls-files --others --exclude-standard)
if [ -n "$untracked" ] && [ "${SCREENER_ALLOW_UNTRACKED:-0}" != "1" ]; then
  echo "Untracked project files found. Track or ignore them intentionally:" >&2
  printf '%s\n' "$untracked" >&2
  echo "Set SCREENER_ALLOW_UNTRACKED=1 only for an intentional partial commit." >&2
  exit 1
fi

agent_lines=$(wc -l < AGENTS.md | tr -d '[:space:]')
memory_lines=$(wc -l < docs/project-memory.md | tr -d '[:space:]')
memory_bytes=$(wc -c < docs/project-memory.md | tr -d '[:space:]')
status_lines=$(wc -l < docs/status.md | tr -d '[:space:]')
status_bytes=$(wc -c < docs/status.md | tr -d '[:space:]')

if [ "$agent_lines" -gt 200 ]; then
  echo "AGENTS.md exceeds the 200-line context budget: $agent_lines lines" >&2
  exit 1
fi

if [ "$memory_lines" -gt 200 ] || [ "$memory_bytes" -gt 12000 ]; then
  echo "docs/project-memory.md exceeds its budget: $memory_lines lines, $memory_bytes bytes" >&2
  exit 1
fi

if [ "$status_lines" -gt 120 ] || [ "$status_bytes" -gt 8000 ]; then
  echo "docs/status.md exceeds its budget: $status_lines lines, $status_bytes bytes" >&2
  exit 1
fi

git diff --check
git diff --cached --check

if [ -n "${SCREENER_BASE_SHA:-}" ]; then
  git diff --check "$SCREENER_BASE_SHA"...HEAD
fi

echo "Repository hygiene checks passed."
