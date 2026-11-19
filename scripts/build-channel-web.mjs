import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { writeChannelWebLicenseNotices } from './package-licenses.mjs';
import { buildVersion } from './release-version.mjs';
import { recordChannelWeb, verifyChannelWeb } from './channel-web-artifact.mjs';
import { assertCleanRevision } from './build-workspace.mjs';

export function verifyCheckoutWeb(root, directory) {
  const revision = assertCleanRevision(root);
  return verifyChannelWeb(directory, { version: buildVersion(root, revision), revision });
}

/** @param {string} root @param {{ version: string; revision: string; cargoTarget?: string; web?: string }} options */
export function buildChannelWeb(root, { version, revision, cargoTarget, web }) {
  if (web !== undefined) return verifyChannelWeb(web, { version, revision });
  const output = join(root, 'build', 'channel-web');
  rmSync(`${output}.build.json`, { force: true });
  let reusable = false;
  if (/^[a-f0-9]{40}$/.test(revision)) {
    try { assertCleanRevision(root, revision); reusable = true; } catch {}
  }
  const env = { ...process.env, RUSTUP_TOOLCHAIN: '1.91.0',
    VITE_PIIK_VERSION: version, VITE_PIIK_REVISION: revision,
    ...(cargoTarget ? { CARGO_TARGET_DIR: cargoTarget } : {}) };
  writeChannelWebLicenseNotices(root, join(root, 'public', 'third-party-licenses.txt'));
  for (const args of [
    [join(root, 'prototype', 'channel-browser', 'build.mjs')],
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'prototype/channel-browser/web.vite.config.ts'],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Shared frontend build failed with exit code ${result.status}`);
  }
  for (const entry of readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|css|wasm)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = readFileSync(path);
    writeFileSync(`${path}.br`, brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
    }));
    writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
  }
  if (reusable) {
    try { assertCleanRevision(root, revision); } catch { reusable = false; }
  }
  if (reusable) recordChannelWeb(output, { version, revision });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  buildChannelWeb(root, { version: buildVersion(root, revision), revision });
}
