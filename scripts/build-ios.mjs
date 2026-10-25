#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIOSLicenseNotices } from './package-licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('The iOS build requires macOS and the Xcode 27 SDK.');
function run(command, args, allowedExitCodes = [0]) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (!allowedExitCodes.includes(result.status)) throw new Error(`${command} failed with exit code ${result.status}`);
}

run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']);
run('npm', ['run', 'build:web']);
const framework = join(root, 'mobile', 'ios', 'Frameworks', 'PiikBridge.xcframework');
mkdirSync(dirname(framework), { recursive: true });
writeIOSLicenseNotices(root, join(root, 'mobile', 'ios', 'Piik', 'THIRD-PARTY-NOTICES.txt'), 'go');
run(process.env.PIIK_GOMOBILE || 'gomobile', ['bind', '-trimpath', '-target=ios,iossimulator',
  '-iosversion=27.0', '-prefix=Piik', '-ldflags=-s -w', '-o', framework, './mobile/bridge']);
const derived = join(root, 'build', 'ios-client', 'DerivedData');
for (const sdk of ['iphoneos', 'iphonesimulator']) {
  run('xcodebuild', ['-project', 'mobile/ios/Piik.xcodeproj', '-scheme', 'Piik', '-configuration', 'Debug',
    '-sdk', sdk, '-destination', `generic/platform=${sdk === 'iphoneos' ? 'iOS' : 'iOS Simulator'}`,
    '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', 'build']);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent',
    join(derived, 'Build', 'Products', `Debug-${sdk}`, 'Piik.app'),
    join(root, 'build', 'ios-client', `piik-${sdk}-unsigned.zip`)]);
}
const encoderCheck = join(root, 'build', 'ios-client', 'video-encoder-check');
run('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5',
  join(root, 'mobile', 'ios', 'Piik', 'VideoEncoder.swift'),
  join(root, 'mobile', 'ios', 'checks', 'main.swift'), '-o', encoderCheck]);
run(encoderCheck, [], [0, 77]);
console.log(`Unsigned iOS development applications: ${join(derived, 'Build', 'Products')}`);
