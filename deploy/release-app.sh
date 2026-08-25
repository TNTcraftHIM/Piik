#!/bin/bash
set -Eeuo pipefail
umask 022

if [ "$#" -ne 1 ]; then
  printf 'usage: SCREENER_PUBLIC_ORIGIN=https://share.example.com %s /opt/screener/uploads/<release>.release.json\n' "$0" >&2
  exit 2
fi

node='/usr/local/bin/node'
npm='/usr/local/bin/npm'
upload_root='/opt/screener/uploads'
release_root='/opt/screener/releases'
current='/opt/screener/current'
lock='/opt/screener/deploy.lock'
public_origin="${SCREENER_PUBLIC_ORIGIN:-}"
descriptor="$(realpath -e -- "$1")"
stage=''
cutover_started=0
old_release=''

test "$(dirname -- "$descriptor")" = "$upload_root"
[[ "$public_origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]

IFS=$'\t' read -r revision release_id artifact_name artifact_sha manifest_name manifest_sha file_count main_asset < <(
  "$node" --input-type=module --eval '
    import { readFileSync } from "node:fs";
    const value = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const fields = [
      value.revision,
      value.releaseId,
      value.artifact,
      value.artifactSha256,
      value.manifest,
      value.manifestSha256,
      value.fileCount,
      value.mainAsset,
    ];
    if (value.schema !== 1 || fields.some((field) =>
      !["string", "number"].includes(typeof field) || String(field).includes("\t") || String(field).includes("\n")
    )) process.exit(2);
    process.stdout.write(fields.join("\t") + "\n");
  ' "$descriptor"
)

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
test -x "$node"
test -x "$npm"
old_release="$(readlink -f -- "$current")"
test "$(dirname -- "$old_release")" = "$release_root"
test -d "$old_release"
test ! -L "$old_release"
test ! -e "$release"
test -f "$artifact"
test -f "$manifest"
test "$(sha256sum "$artifact" | awk '{print $1}')" = "$artifact_sha"
test "$(sha256sum "$manifest" | awk '{print $1}')" = "$manifest_sha"
for service in screener livekit coturn nginx; do
  test "$(systemctl show "${service}.service" -p ActiveState --value)" = 'active'
  test "$(systemctl show "${service}.service" -p NRestarts --value)" = '0'
done

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
    REVISION|package.json|package-lock.json|dist|dist/client|dist/server|dist/client/*|dist/server/*) ;;
    *) printf 'unexpected archive entry: %s\n' "$raw_entry" >&2; exit 42 ;;
  esac
done < <(tar -tzf "$artifact")

stage="$(mktemp -d "${release_root}/.${release_id}.XXXXXX")"
test "$(dirname -- "$(realpath -m -- "$stage")")" = "$release_root"
chmod 0755 "$stage"
tar --no-same-owner --no-same-permissions -xzf "$artifact" -C "$stage"

STAGE="$stage" MANIFEST="$manifest" FILE_COUNT="$file_count" REVISION="$revision" "$node" --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const stage = process.env.STAGE;
const text = await readFile(process.env.MANIFEST, 'utf8');
if (!text.endsWith('\n')) process.exit(61);
const lines = text.slice(0, -1).split('\n');
const expected = new Map();
for (const line of lines) {
  const fields = line.split('\t');
  if (fields.length !== 3 || !/^[0-9a-f]{64}$/.test(fields[0]) || !/^\d+$/.test(fields[1])) process.exit(62);
  const path = fields[2];
  if (!/^(REVISION|package(-lock)?\.json|dist\/(client|server)\/[A-Za-z0-9._/-]+)$/.test(path)) process.exit(63);
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..') || expected.has(path)) process.exit(64);
  expected.set(path, { hash: fields[0], size: Number(fields[1]) });
}
if (expected.size !== Number(process.env.FILE_COUNT)) process.exit(65);

const actual = new Map();
const identities = new Set();
const pending = [stage];
while (pending.length) {
  const directory = pending.pop();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) process.exit(66);
    if (metadata.isDirectory()) {
      pending.push(absolute);
    } else if (metadata.isFile()) {
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (identities.has(identity)) process.exit(67);
      identities.add(identity);
      const path = relative(stage, absolute).split(sep).join('/');
      const body = await readFile(absolute);
      actual.set(path, { hash: createHash('sha256').update(body).digest('hex'), size: body.length });
    } else process.exit(68);
  }
}
if (actual.size !== expected.size) process.exit(69);
for (const [path, record] of expected) {
  const found = actual.get(path);
  if (!found || found.hash !== record.hash || found.size !== record.size) process.exit(70);
}
if ((await readFile(join(stage, 'REVISION'), 'ascii')) !== `${process.env.REVISION}\n`) process.exit(71);
console.log(`artifact_manifest=ok files=${actual.size} revision=${process.env.REVISION}`);
NODE

test -f "$stage/dist/client/$main_asset"
test -f "$stage/dist/server/server/index.js"
find "$stage/dist" -type d -exec chmod 0755 {} +
find "$stage/dist" -type f -exec chmod 0644 {} +
chmod 0644 "$stage/REVISION" "$stage/package.json" "$stage/package-lock.json"

systemd-run \
  --unit="screener-deps-${release_id}" \
  --wait \
  --collect \
  --quiet \
  --service-type=exec \
  --property="WorkingDirectory=$stage" \
  --property='CPUQuota=30%' \
  --property='MemoryHigh=160M' \
  --property='MemoryMax=256M' \
  --property='MemorySwapMax=0' \
  --property='RuntimeMaxSec=120s' \
  "$npm" ci --omit=dev --ignore-scripts --no-audit --no-fund

previous_directory="$PWD"
cd "$stage"
sudo -u screener "$node" --input-type=module --eval "await Promise.all([import('sirv'), import('ws'), import('zod'), import('livekit-server-sdk'), import('./dist/server/server/config.js')]);"
"$node" --env-file=/etc/screener/screener.env --input-type=module --eval "import { loadConfig } from './dist/server/server/config.js'; loadConfig(process.env);"
cd "$previous_directory"

OLD_RELEASE="$old_release" NEW_RELEASE="$stage" "$node" --input-type=module <<'NODE'
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
function collect(root) {
  const identities = new Set();
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) identities.add(`${metadata.dev}:${metadata.ino}`);
    }
  }
  return identities;
}
const oldFiles = collect(process.env.OLD_RELEASE);
const newFiles = collect(process.env.NEW_RELEASE);
let intersection = 0;
for (const identity of newFiles) if (oldFiles.has(identity)) intersection += 1;
if (intersection !== 0) process.exit(80);
console.log(`release_inode_intersection=0 new_regular_files=${newFiles.size}`);
NODE

old_asset="$(OLD_RELEASE="$old_release" "$node" --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const html = readFileSync(`${process.env.OLD_RELEASE}/dist/client/index.html`, "utf8");
  const match = html.match(/<script[^>]+src="\/(assets\/index-[A-Za-z0-9_-]+\.js)"/);
  if (!match) process.exit(2);
  process.stdout.write(match[1]);
')"

mv -- "$stage" "$release"
stage=''
test -d "$release"
test ! -L "$release"
test "$(stat -c '%U:%G %a' "$release")" = 'root:root 755'

firewall_before="$(nft list table inet bonfire_filter | sha256sum | awk '{print $1}')"
livekit_restarts="$(systemctl show livekit.service -p NRestarts --value)"
coturn_restarts="$(systemctl show coturn.service -p NRestarts --value)"
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
test "$(systemctl show livekit.service -p NRestarts --value)" = "$livekit_restarts"
test "$(systemctl show coturn.service -p NRestarts --value)" = "$coturn_restarts"
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

asset_sha="$(sha256sum "$release/dist/client/$main_asset" | awk '{print $1}')"
cutover_started=0
trap - ERR HUP INT TERM EXIT
printf 'deployment=ok revision=%s release=%s previous=%s artifact_sha=%s manifest_sha=%s asset=%s asset_sha=%s health_ms=%s firewall_sha=%s\n' \
  "$revision" "$release_id" "$old_release" "$artifact_sha" "$manifest_sha" "$main_asset" "$asset_sha" "$((health_ready - cutover_start))" "$firewall_before"
