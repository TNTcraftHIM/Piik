#!/bin/sh
set -eu

repo_root=$(git rev-parse --show-toplevel)
git -C "$repo_root" config core.hooksPath .githooks
sh "$repo_root/scripts/check-project-state.sh"
echo "Git hooks installed from .githooks."
