import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { writeChannelWebLicenseNotices } from './package-licenses.mjs';
import { buildVersion } from './release-version.mjs';

export function buildChannelWeb(root, { version, revision, cargoTarget }) {
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
  const output = join(root, 'build', 'channel-web');
  for (const entry of readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|css|wasm)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = readFileSync(path);
    writeFileSync(`${path}.br`, brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
    }));
    writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  buildChannelWeb(root, { version: buildVersion(root, revision), revision });
}
