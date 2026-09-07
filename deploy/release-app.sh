#!/bin/bash
set -Eeuo pipefail
umask 022

if [ "$#" -ne 1 ]; then
  printf 'usage: SCREENER_PUBLIC_ORIGIN=https://share.example.com %s /opt/screener/uploads/<release>.release.json\n' "$0" >&2
  exit 2
fi

upload_root='/opt/screener/uploads'
release_root='/opt/screener/releases'
current='/opt/screener/current'
lock='/opt/screener/deploy.lock'
public_origin="${SCREENER_PUBLIC_ORIGIN:-}"
descriptor="$(realpath -e -- "$1")"
stage=''
release_owned=0
cutover_started=0
old_release=''

test "$(dirname -- "$descriptor")" = "$upload_root"
[[ "$public_origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]

# The descriptor is JSON.stringify(descriptor, null, 2): one field per line.
descriptor_text() {
  sed -n "s|^  \"$1\": \"\([A-Za-z0-9._/-]*\)\",\{0,1\}\$|\1|p" "$descriptor"
}

grep -qx '  "schema": 1,' "$descriptor"
revision="$(descriptor_text revision)"
release_id="$(descriptor_text releaseId)"
artifact_name="$(descriptor_text artifact)"
artifact_sha="$(descriptor_text artifactSha256)"
manifest_name="$(descriptor_text manifest)"
manifest_sha="$(descriptor_text manifestSha256)"
file_count="$(sed -n 's|^  "fileCount": \([0-9]\{1,\}\),\{0,1\}$|\1|p' "$descriptor")"
main_asset="$(descriptor_text mainAsset)"

[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
[[ "$release_id" =~ ^[0-9a-f]{7}$ ]]
test "$release_id" = "${revision:0:7}"
test "$artifact_name" = "screener-${release_id}-runtime.tar.gz"
test "$manifest_name" = "screener-${release_id}.manifest.tsv"
[[ "$artifact_sha" =~ ^[0-9a-f]{64}$ ]]
[[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]]
[[ "$file_count" =~ ^[1-9][0-9]*$ ]]
[[ "$main_asset" =~ ^assets/index-[A-Za-z0-9_-]+\.js$ ]]

artifact="${upload_root}/${artifact_name}"
manifest="${upload_root}/${manifest_name}"
release="${release_root}/${release_id}"

cleanup_stage() {
  if [ -z "$stage" ] || [ ! -e "$stage" ]; then
    return
  fi
  local resolved parent base
  resolved="$(realpath -m -- "$stage")"
  parent="$(dirname -- "$resolved")"
  base="$(basename -- "$resolved")"
  if [ "$parent" != "$release_root" ] || [[ "$base" != ".${release_id}."* ]]; then
    printf 'refusing to remove unexpected stage: %s\n' "$resolved" >&2
    return
  fi
  rm -rf --one-file-system -- "$resolved"
}

cleanup_release() {
  if [ "$release_owned" -ne 1 ] || { [ ! -e "$release" ] && [ ! -L "$release" ]; }; then
    return
  fi
  if [ -n "$stage" ] && [ -e "$stage" ]; then
    return
  fi
  local resolved parent base active
  resolved="$(realpath -m -- "$release")"
  parent="$(dirname -- "$resolved")"
  base="$(basename -- "$resolved")"
  active="$(readlink -f -- "$current" 2>/dev/null || true)"
  if [ "$parent" != "$release_root" ] || [ "$base" != "$release_id" ] || \
      [ "$active" = "$resolved" ] || [ -L "$release" ] || [ ! -d "$release" ]; then
    printf 'refusing to remove unexpected release: %s\n' "$resolved" >&2
    return 1
  fi
  if ! rm -rf --one-file-system -- "$resolved"; then
    return 1
  fi
  release_owned=0
}

wait_for_health() {
  local body=''
  for _ in $(seq 1 120); do
    body="$(curl -fsS --max-time 2 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
    if [ "$body" = '{"status":"ok"}' ]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

recover() {
  local code="${1:-$?}" ok=1 link=''
  trap - ERR HUP INT TERM EXIT
  set +e
  if [ "$cutover_started" -eq 1 ]; then
    systemctl stop screener.service || ok=0
    if [ "$(readlink -f -- "$current" 2>/dev/null)" != "$old_release" ]; then
      link="${current}.recover-${release_id}-$$"
      if [ -e "$link" ] || [ -L "$link" ]; then
        ok=0
      elif ! ln -s "$old_release" "$link" || ! mv -Tf "$link" "$current"; then
        ok=0
      fi
    fi
    test "$(readlink -f -- "$current" 2>/dev/null)" = "$old_release" || ok=0
    systemctl start screener.service || ok=0
    wait_for_health || ok=0
  fi
  rm -f -- "${current}.${release_id}-$$" "${current}.recover-${release_id}-$$" || ok=0
  if [ "$ok" -eq 1 ]; then
    cleanup_release || ok=0
  fi
  cleanup_stage
  printf 'deployment_failed=%s recovery_ok=%s current=%s active=%s\n' \
    "$code" "$ok" \
    "$(readlink -f -- "$current" 2>/dev/null || true)" \
    "$(systemctl show screener.service -p ActiveState --value 2>/dev/null || true)" >&2
  if [ "$ok" -ne 1 ]; then
    exit 90
  fi
  exit "$code"
}

trap 'recover $?' ERR
trap 'recover 129' HUP
trap 'recover 130' INT
trap 'recover 143' TERM
trap 'code=$?; if [ "$code" -ne 0 ]; then recover "$code"; fi' EXIT

exec 9>"$lock"
flock -n 9
old_release="$(readlink -f -- "$current")"
test "$(dirname -- "$old_release")" = "$release_root"
test -d "$old_release"
test ! -L "$old_release"
test ! -e "$release"
test -f "$artifact"
test -f "$manifest"
test "$(sha256sum "$artifact" | awk '{print $1}')" = "$artifact_sha"
test "$(sha256sum "$manifest" | awk '{print $1}')" = "$manifest_sha"
for service in screener nginx; do
  test "$(systemctl show "${service}.service" -p ActiveState --value)" = 'active'
  test "$(systemctl show "${service}.service" -p NRestarts --value)" = '0'
done
# The first Go/embedded-media cutover owns its infrastructure recovery separately.
test -x "$old_release/screener-server"
old_pid="$(systemctl show screener.service -p MainPID --value)"
test "$old_pid" -gt 1
test "$(readlink -f "/proc/${old_pid}/exe")" = "$old_release/screener-server"

while IFS= read -r raw_entry; do
  entry="$raw_entry"
  while [[ "$entry" = ./* ]]; do entry="${entry#./}"; done
  entry="${entry%/}"
  if [ -z "$entry" ]; then continue; fi
  case "/$entry/" in
    *'/../'*|*'/./'*|*'//'*) printf 'invalid archive entry: %s\n' "$raw_entry" >&2; exit 41 ;;
  esac
  case "$entry" in
    /*|*\\*) printf 'invalid archive entry: %s\n' "$raw_entry" >&2; exit 41 ;;
    LICENSE|REVISION|THIRD-PARTY-NOTICES.txt|screener-server) ;;
    *) printf 'unexpected archive entry: %s\n' "$raw_entry" >&2; exit 42 ;;
  esac
done < <(tar -tzf "$artifact")

stage="$(mktemp -d "${release_root}/.${release_id}.XXXXXX")"
test "$(dirname -- "$(realpath -m -- "$stage")")" = "$release_root"
chmod 0755 "$stage"
tar --no-same-owner --no-same-permissions -xzf "$artifact" -C "$stage"

tab=$'\t'
if [ -n "$(tail -c 1 "$manifest")" ]; then exit 61; fi
if grep -qEv "^[0-9a-f]{64}${tab}[0-9]+${tab}[^${tab}]*$" "$manifest"; then exit 62; fi
if grep -qEv "^[0-9a-f]{64}${tab}[0-9]+${tab}(LICENSE|REVISION|THIRD-PARTY-NOTICES\.txt|screener-server)$" "$manifest"; then exit 63; fi
if [ -n "$(cut -f3 "$manifest" | sort | uniq -d)" ]; then exit 64; fi
if [ "$(wc -l < "$manifest")" -ne "$file_count" ]; then exit 65; fi
if [ -n "$(find "$stage" -type l)" ]; then exit 66; fi
if [ -n "$(find "$stage" -type f -printf '%D:%i\n' | sort | uniq -d)" ]; then exit 67; fi
if [ -n "$(find "$stage" ! -type f ! -type d ! -type l)" ]; then exit 68; fi
if [ "$(find "$stage" -type f | wc -l)" -ne "$file_count" ]; then exit 69; fi
if ! awk -F'\t' '{ printf "%s  %s\n", $1, $3 }' "$manifest" | (cd "$stage" && sha256sum -c --strict --quiet -); then exit 70; fi
while IFS="$tab" read -r _ size path; do
  test "$(stat -c '%s' "$stage/$path")" = "$size" || exit 70
done < "$manifest"
if [ "$(cat "$stage/REVISION")" != "$revision" ]; then exit 71; fi
printf 'artifact_manifest=ok files=%s revision=%s\n' "$file_count" "$revision"

# Set the mode before testing it: an archive packaged on a host without an
# executable bit (Windows) records 0644, and the release owns the bit here.
chmod 0755 "$stage/screener-server"
test -x "$stage/screener-server"
chmod 0644 "$stage/LICENSE" "$stage/REVISION" "$stage/THIRD-PARTY-NOTICES.txt"

# Runs as the service user under the manager (no sudo/polkit round trip) so a
# binary or environment file the service cannot use fails here, before cutover.
systemd-run \
  --uid=screener \
  --gid=screener \
  --wait \
  --collect \
  --quiet \
  --service-type=exec \
  --property='EnvironmentFile=/etc/screener/screener.env' \
  --property='Environment=SCREENER_ENV=production' \
  --property='RuntimeMaxSec=20s' \
  "$stage/screener-server" --check-config

if [ -n "$(comm -12 <(find "$old_release" -type f -printf '%D:%i\n' | sort -u) <(find "$stage" -type f -printf '%D:%i\n' | sort -u))" ]; then
  exit 80
fi
printf 'release_inode_intersection=0 new_regular_files=%s\n' \
  "$(find "$stage" -type f -printf '%D:%i\n' | sort -u | wc -l)"

old_asset="$(curl -fsS --max-time 5 http://127.0.0.1:8787/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | sed -n 1p)"

release_owned=1
mv -- "$stage" "$release"
stage=''
test -d "$release"
test ! -L "$release"
test "$(stat -c '%U:%G %a' "$release")" = 'root:root 755'

firewall_before="$(nft list table inet bonfire_filter | sha256sum | awk '{print $1}')"
nginx_restarts="$(systemctl show nginx.service -p NRestarts --value)"
cutover_since="$(date '+%Y-%m-%d %H:%M:%S')"
cutover_start="$(date +%s%3N)"
cutover_started=1
systemctl stop screener.service
test "$(systemctl show screener.service -p ActiveState --value)" = 'inactive'
ln -s "$release" "${current}.${release_id}-$$"
mv -Tf "${current}.${release_id}-$$" "$current"
test "$(readlink -f -- "$current")" = "$release"
systemctl start screener.service
wait_for_health
health_ready="$(date +%s%3N)"

test "$(systemctl show screener.service -p ActiveState --value)" = 'active'
test "$(systemctl show screener.service -p NRestarts --value)" = '0'
test "$(systemctl show nginx.service -p NRestarts --value)" = "$nginx_restarts"
test "$(nft list table inet bonfire_filter | sha256sum | awk '{print $1}')" = "$firewall_before"
test "$(readlink -f -- "$current")" = "$release"
pid="$(systemctl show screener.service -p MainPID --value)"
test "$pid" -gt 1
test "$(readlink -f "/proc/${pid}/cwd")" = "$release"
test "$(curl -fsS --max-time 5 http://127.0.0.1:8787/healthz)" = '{"status":"ok"}'
test "$(curl -fsS --max-time 8 "$public_origin/healthz")" = '{"status":"ok"}'
curl -fsS --max-time 5 http://127.0.0.1:8787/ | grep -Fq "$main_asset"
curl -fsS --max-time 8 "$public_origin/" | grep -Fq "$main_asset"
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$public_origin/$main_asset")" = '200'
if [ "$old_asset" != "$main_asset" ]; then
  test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$public_origin/$old_asset")" = '404'
fi
test -z "$(journalctl -u screener.service --since "$cutover_since" -p warning --no-pager --output=cat)"

asset_sha="$(curl -fsS --max-time 8 "$public_origin/$main_asset" | sha256sum | awk '{print $1}')"
release_owned=0
cutover_started=0
trap - ERR HUP INT TERM EXIT
printf 'deployment=ok revision=%s release=%s previous=%s artifact_sha=%s manifest_sha=%s asset=%s asset_sha=%s health_ms=%s firewall_sha=%s\n' \
  "$revision" "$release_id" "$old_release" "$artifact_sha" "$manifest_sha" "$main_asset" "$asset_sha" "$((health_ready - cutover_start))" "$firewall_before"
