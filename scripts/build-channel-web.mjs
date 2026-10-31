import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  return join(root, 'build', 'channel-web');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  buildChannelWeb(root, { version: buildVersion(root, revision), revision });
}
