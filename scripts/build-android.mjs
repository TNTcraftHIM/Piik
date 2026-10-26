#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAndroidLicenseNotices } from './package-licenses.mjs';
import { writeAndroidAppIcon } from './app-icons.mjs';
import { CLOUDFLARED_VERSION, CLOUDFLARED_SOURCE_SHA256, ANDROID_APP_PACKAGE_TARGET, androidVersionCode } from './app-package-targets.mjs';
import { buildVersion } from './release-version.mjs';
import { assertCleanRevision } from './build-workspace.mjs';
import { packageAndroidRelease } from './package-android-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'mobile', 'android');
const gradleHome = process.env.GRADLE_HOME;
const tunnelOnly = process.argv.includes('--tunnel-only');
const release = process.argv.includes('--release');
let output;
for (let index = 2; index < process.argv.length; index++) {
  const option = process.argv[index];
  if (option === '--output' && !output && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    output = resolve(process.argv[++index]);
  } else if (option !== '--tunnel-only' && option !== '--release') {
    throw new Error(`Unknown Android build option: ${option}`);
  }
}
if ((release && tunnelOnly) || (release !== Boolean(output)))
  throw new Error('Use --release --output <new-directory> for a signed release APK.');
if (output && existsSync(output)) throw new Error('Android release output must not already exist.');
const releaseRevision = release ? assertCleanRevision(root) : undefined;
if (release) {
  for (const name of ['PIIK_ANDROID_KEYSTORE', 'PIIK_ANDROID_STORE_PASSWORD', 'PIIK_ANDROID_KEY_ALIAS', 'PIIK_ANDROID_KEY_PASSWORD'])
    if (!process.env[name]) throw new Error(`Android release signing requires ${name}.`);
  if (!existsSync(process.env.PIIK_ANDROID_KEYSTORE)) throw new Error('Android release keystore does not exist.');
}
if (!process.env.ANDROID_NDK_HOME || (!tunnelOnly && (!process.env.ANDROID_HOME || !gradleHome))) {
  throw new Error('Set ANDROID_HOME, ANDROID_NDK_HOME and GRADLE_HOME to the installed SDK, NDK and Gradle distribution.');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}
// Build upstream in its own pinned module: the App never imports its CLI graph.
const notice = JSON.parse(readFileSync(join(root, 'licenses', 'upstream.json'), 'utf8'))[`cloudflared@${CLOUDFLARED_VERSION}`];
const commit = new URL(notice.source).pathname.split('/').at(-1);
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Cloudflared source must pin a commit.');
const cache = join(root, 'build', 'android-cloudflared');
mkdirSync(cache, { recursive: true });
const archive = join(cache, `${commit}.tar.gz`);
if (!existsSync(archive)) {
  const response = await fetch(`https://codeload.github.com/cloudflare/cloudflared/tar.gz/${commit}`);
  if (!response.ok) throw new Error(`Cloudflared source download failed: ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== CLOUDFLARED_SOURCE_SHA256) {
  throw new Error('Cloudflared source archive differs from its pin.');
}
run('tar', ['-xzf', archive, '-C', cache]);
const source = join(cache, `cloudflared-${commit}`);
const adapter = join(root, 'mobile', 'cloudflared');
const patched = join(cache, 'overlay');
mkdirSync(join(patched, 'supervisor'), { recursive: true });
copyFileSync(join(source, 'supervisor', 'tunnel.go'), join(patched, 'supervisor', 'tunnel.go'));
run('git', ['apply', '--unidiff-zero', `--directory=${join('build', 'android-cloudflared', 'overlay').replaceAll('\\', '/')}`,
  join(adapter, 'edge-fallback.patch')]);
const overlay = join(cache, 'overlay.json');
writeFileSync(overlay, JSON.stringify({ Replace: {
  [join(source, 'cmd', 'cloudflared', 'piik_android_dns.go')]: join(adapter, 'android_dns.go'),
  [join(source, 'supervisor', 'tunnel.go')]: join(patched, 'supervisor', 'tunnel.go'),
  [join(source, 'supervisor', 'piik_fallback_test.go')]: join(adapter, 'fallback_test.go'),
} }, null, 2));
const [hostOS, hostArch] = execFileSync('go', ['env', 'GOHOSTOS', 'GOHOSTARCH'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
}).trim().split(/\r?\n/);
const fallbackTest = join(cache, `fallback.test${hostOS === 'windows' ? '.exe' : ''}`);
run('go', ['test', '-c', '-mod=readonly', `-overlay=${overlay}`, '-tags=piik_cloudflared',
  '-o', fallbackTest, './supervisor'], { cwd: source,
  env: { ...process.env, GOOS: hostOS, GOARCH: hostArch, CGO_ENABLED: '0', GOWORK: 'off' } });
run(fallbackTest, ['-test.run=^TestPiikExhaustedQuicHandshakeFallsBack$', '-test.count=1']);
const host = { win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' }[process.platform];
if (!host) throw new Error('Unsupported NDK build host.');
const tools = join(process.env.ANDROID_NDK_HOME, 'toolchains', 'llvm', 'prebuilt', host, 'bin');
const exe = process.platform === 'win32' ? '.exe' : '';
const clang = join(tools, `clang${exe}`);
for (const [abi, arch, target, machine] of [
  ['arm64-v8a', 'arm64', 'aarch64-linux-android29', 'AArch64'],
  ['x86_64', 'amd64', 'x86_64-linux-android29', 'Advanced Micro Devices X86-64'],
]) {
  const output = join(android, 'app', 'src', 'main', 'jniLibs', abi, 'libcloudflared.so');
  mkdirSync(dirname(output), { recursive: true });
  const env = { ...process.env, GOOS: 'android', GOARCH: arch, CGO_ENABLED: '1',
    CC: `"${clang}" --target=${target}`, GOWORK: 'off' };
  run('go', ['build', '-mod=readonly', `-overlay=${overlay}`, '-tags=piik_cloudflared', '-trimpath', '-buildvcs=false', '-buildmode=pie',
    `-ldflags=-s -w -X main.Version=${CLOUDFLARED_VERSION} -X main.BuildTime=source-pinned -linkmode=external -extldflags=-Wl,-z,max-page-size=16384`,
    '-o', output, './cmd/cloudflared'], { cwd: source, env });
  chmodSync(output, 0o755);
  const elf = execFileSync(join(tools, `llvm-readelf${exe}`), ['-h', '-l', '-d', output], { encoding: 'utf8', windowsHide: true });
  const loads = [...elf.matchAll(/^\s*LOAD\s+.*$/gm)];
  if (!elf.includes(machine) || !/Type:\s+DYN/.test(elf) || !/INTERP/.test(elf) || !loads.length ||
      !/\/system\/bin\/linker64/.test(elf) ||
      loads.some(([line]) => !/0x4000\s*$/.test(line))) {
    throw new Error(`Cloudflared ${abi} must be Android PIE with 16KB LOAD alignment.`);
  }
  for (const [, library] of elf.matchAll(/Shared library: \[([^\]]+)\]/g)) {
    if (!['libc.so', 'libdl.so', 'libm.so', 'liblog.so', 'libandroid.so'].includes(library)) {
      throw new Error(`Unexpected cloudflared Android dependency: ${library}`);
    }
  }
  writeFileSync(join(cache, `${abi}-elf.txt`), elf);
  console.log(`Android cloudflared ${CLOUDFLARED_VERSION}: ${abi} PIE (16KB)`);
}
if (!tunnelOnly) {
  const revision = releaseRevision ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const version = buildVersion(root, revision);
  const versionCode = androidVersionCode(version);
  const versionName = version === 'development' ? `${version}-${revision.slice(0, 7)}` : version;
  const launcher = readdirSync(join(gradleHome, 'lib')).find(name => /^gradle-launcher-.*\.jar$/.test(name));
  if (!launcher) throw new Error('GRADLE_HOME does not contain a Gradle launcher.');
  const frameDropper = join(root, 'native', 'third_party', 'webrtc-frame-dropper');
  for (const [abi, target] of [['arm64-v8a', 'aarch64-linux-android29'], ['x86_64', 'x86_64-linux-android29']]) {
    const output = join(android, 'app', 'src', 'main', 'jniLibs', abi, 'libpiik_frame_dropper.so');
    mkdirSync(dirname(output), { recursive: true });
    run(join(tools, `clang++${exe}`), [`--target=${target}`, '-std=c++17', '-O2', '-fPIC', '-shared',
      '-static-libstdc++', '-fno-exceptions', '-fno-rtti', '-fvisibility=hidden',
      '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-Wl,--exclude-libs,ALL',
      '-Wl,-z,defs', '-Wl,-z,max-page-size=16384', '-Wl,-soname,libpiik_frame_dropper.so',
      '-I', frameDropper, join(android, 'frame_dropper.cc'),
      join(frameDropper, 'modules', 'video_coding', 'utility', 'frame_dropper.cc'),
      join(frameDropper, 'rtc_base', 'numerics', 'exp_filter.cc'), '-o', output]);
    const elf = execFileSync(join(tools, `llvm-readelf${exe}`), ['-h', '-l', '-d', output], { encoding: 'utf8', windowsHide: true });
    const loads = [...elf.matchAll(/^\s*LOAD\s+.*$/gm)];
    if (!/Type:\s+DYN/.test(elf) || !loads.length || loads.some(([line]) => !/0x4000\s*$/.test(line)))
      throw new Error(`FrameDropper ${abi} must have 16KB LOAD alignment.`);
    for (const [, library] of elf.matchAll(/Shared library: \[([^\]]+)\]/g))
      if (!['libc.so', 'libdl.so', 'libm.so'].includes(library))
        throw new Error(`Unexpected FrameDropper Android dependency: ${library}`);
    console.log(`Android WebRTC FrameDropper: ${abi} (static C++ runtime, 16KB)`);
  }
  const webEnv = { ...process.env, VITE_PIIK_VERSION: version, VITE_PIIK_REVISION: revision };
  if (process.platform === 'win32') run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build:web'], { env: webEnv });
  else run('npm', ['run', 'build:web'], { env: webEnv });
  writeAndroidLicenseNotices(root, join(android, 'app', 'src', 'main', 'assets', 'THIRD-PARTY-NOTICES.txt'), 'go');
  writeAndroidAppIcon(join(root, 'cmd', 'piik-app', 'piik.ico'), join(android, 'app', 'src', 'main', 'res', 'drawable-nodpi', 'piik.png'));
  mkdirSync(join(android, 'app', 'libs'), { recursive: true });
  run(process.env.PIIK_GOMOBILE || 'gomobile', ['bind', '-trimpath', '-target=android/arm64,android/amd64', '-androidapi', '29',
    `-ldflags=-s -w -checklinkname=0 -X github.com/TNTcraftHIM/Piik/internal/app/buildinfo.Release=${version} -X github.com/TNTcraftHIM/Piik/internal/app/buildinfo.Revision=${revision}`,
    '-javapkg', 'tv.piik', '-o', join(android, 'app', 'libs', 'piik.aar'), './mobile/bridge']);
  // Recreate the final ZIP so replaced native libraries leave no free blocks.
  run('java', ['-classpath', join(gradleHome, 'lib', launcher), 'org.gradle.launcher.GradleMain',
    '-Dorg.gradle.jvmargs=-Xmx2g', '-p', android, '--no-daemon',
    `-PpiikVersion=${versionName}`, `-PpiikVersionCode=${versionCode}`,
    release ? ':app:packageRelease' : ':app:packageDebug', '--rerun',
    release ? ':app:assembleRelease' : ':app:assembleDebug', '--console=plain']);
  const variant = release ? 'release' : 'debug';
  const apk = join(android, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
  if (!existsSync(apk)) throw new Error('The Android build did not produce its APK.');
  if (release) {
    const sdkTools = join(process.env.ANDROID_HOME, 'build-tools', '35.0.0');
    const signing = execFileSync('java', ['-jar', join(sdkTools, 'lib', 'apksigner.jar'),
      'verify', '--verbose', '--print-certs', apk], { encoding: 'utf8', windowsHide: true });
    if (/CN=Android Debug\b/i.test(signing)) throw new Error('A release APK cannot use an Android debug signing key.');
    const badging = execFileSync(join(sdkTools, `aapt${exe}`), ['dump', 'badging', apk], { encoding: 'utf8', windowsHide: true });
    if (!badging.includes(`package: name='tv.piik.android' versionCode='${versionCode}' versionName='${versionName}'`) ||
        /application-debuggable/.test(badging) || !badging.includes("native-code: 'arm64-v8a' 'x86_64'"))
      throw new Error('Android release identity, ABIs or debuggable flag differs from the package contract.');
    const { artifact } = ANDROID_APP_PACKAGE_TARGET;
    assertCleanRevision(root, revision);
    packageAndroidRelease(apk, output, version, revision);
    assertCleanRevision(root, revision);
    console.log(`Piik Android signed release APK: ${join(output, artifact)}`);
  } else console.log(`Piik Android development APK: ${apk}`);
}
