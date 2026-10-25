#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIOSLicenseNotices } from './package-licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('The iOS build requires macOS and the Xcode 27 SDK.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']);
run('npm', ['run', 'build:web']);
const framework = join(root, 'mobile', 'ios', 'Frameworks', 'PiikBridge.xcframework');
mkdirSync(dirname(framework), { recursive: true });
writeIOSLicenseNotices(root, join(root, 'mobile', 'ios', 'Piik', 'THIRD-PARTY-NOTICES.txt'), 'go');
run(process.env.PIIK_GOMOBILE || 'gomobile', ['bind', '-trimpath', '-target=ios,iossimulator',
  '-iosversion=27.0', '-prefix=Piik', '-ldflags=-s -w', '-o', framework, './mobile/bridge']);
const derived = join(root, 'build', 'ios-client', 'DerivedData');
for (const sdk of ['iphonesimulator', 'iphoneos']) {
  run('xcodebuild', ['-project', 'mobile/ios/Piik.xcodeproj', '-scheme', 'Piik', '-configuration', 'Debug',
    '-sdk', sdk, '-destination', `generic/platform=${sdk === 'iphoneos' ? 'iOS' : 'iOS Simulator'}`,
    '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', 'build']);
}
console.log(`Unsigned iOS development applications: ${join(derived, 'Build', 'Products')}`);
