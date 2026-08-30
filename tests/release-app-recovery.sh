#!/bin/bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
release_script="$repo_root/deploy/release-app.sh"

extract_function() {
  awk -v name="$1" '
    $0 == name "() {" { capture = 1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$release_script"
}

eval "$(extract_function cleanup_stage)"
if grep -q '^cleanup_release() {' "$release_script"; then
  eval "$(extract_function cleanup_release)"
fi
eval "$(extract_function wait_for_health)"
eval "$(extract_function recover)"

test_root="$(mktemp -d)"
trap 'rm -rf --one-file-system -- "$test_root"' EXIT
release_root="$test_root/releases"
current="$test_root/current"
release_id='abcdef0'
old_release="$release_root/old"
release="$release_root/$release_id"
stage=''
mkdir -p "$old_release"

systemctl_start_fails=0
rm_release_fails=0
systemctl() {
  if [ "${1:-}" = 'start' ] && [ "$systemctl_start_fails" -eq 1 ]; then
    return 1
  fi
  if [ "${1:-}" = 'show' ]; then
    printf 'active\n'
  fi
  return 0
}
wait_for_health() { return 0; }

rm() {
  local path="${!#}"
  if [ "$rm_release_fails" -eq 1 ] && [ "$path" = "$release" ]; then
    return 1
  fi
  command rm "$@"
}

readlink() {
  local path="${!#}"
  if [ "$path" = "$current" ] && [ -f "$current" ]; then
    cat "$current"
    return
  fi
  command readlink "$@"
}

ln() {
  if [ "${1:-}" = '-s' ]; then
    printf '%s\n' "$2" > "$3"
    return
  fi
  command ln "$@"
}

mv() {
  if [ "${1:-}" = '-Tf' ]; then
    command mv -f -- "$2" "$3"
    return
  fi
  command mv "$@"
}

set_current() {
  printf '%s\n' "$1" > "$current"
}

reset_release() {
  rm -rf --one-file-system -- "$release"
  rm -rf --one-file-system -- "$current"
  mkdir -p "$release"
  set_current "$old_release"
  stage=''
  cutover_started=0
  systemctl_start_fails=0
}

run_recover() {
  local expected="$1" code
  set +e
  (recover 37) >/dev/null 2>&1
  code=$?
  set -e
  test "$code" -eq "$expected"
}

reset_release
release_owned=1
run_recover 37
test ! -e "$release"

reset_release
release_owned=0
run_recover 37
test -d "$release"

reset_release
release_owned=1
rm_release_fails=1
run_recover 90
test -d "$release"
rm_release_fails=0

reset_release
release_owned=1
cutover_started=1
set_current "$release"
run_recover 37
test "$(readlink -f -- "$current")" = "$old_release"
test ! -e "$release"

reset_release
release_owned=1
cutover_started=1
systemctl_start_fails=1
set_current "$release"
run_recover 90
test -d "$release"
