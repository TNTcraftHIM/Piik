#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAndroidLicenseNotices } from './package-licenses.mjs';
import { writeAndroidAppIcon } from './app-icons.mjs';
import { CLOUDFLARED_VERSION, CLOUDFLARED_SOURCE_SHA256 } from './app-package-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'mobile', 'android');
const gradleHome = process.env.GRADLE_HOME;
const tunnelOnly = process.argv.includes('--tunnel-only');
for (const option of process.argv.slice(2)) {
  if (option !== '--tunnel-only') throw new Error(`Unknown Android build option: ${option}`);
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
  const launcher = readdirSync(join(gradleHome, 'lib')).find(name => /^gradle-launcher-.*\.jar$/.test(name));
  if (!launcher) throw new Error('GRADLE_HOME does not contain a Gradle launcher.');
  if (process.platform === 'win32') run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build:web']);
  else run('npm', ['run', 'build:web']);
  writeAndroidLicenseNotices(root, join(android, 'app', 'src', 'main', 'assets', 'THIRD-PARTY-NOTICES.txt'), 'go');
  writeAndroidAppIcon(join(root, 'cmd', 'piik-app', 'piik.ico'), join(android, 'app', 'src', 'main', 'res', 'drawable-nodpi', 'piik.png'));
  mkdirSync(join(android, 'app', 'libs'), { recursive: true });
  run(process.env.PIIK_GOMOBILE || 'gomobile', ['bind', '-trimpath', '-target=android/arm64,android/amd64', '-androidapi', '29',
    '-ldflags=-s -w -checklinkname=0', '-javapkg', 'tv.piik', '-o', join(android, 'app', 'libs', 'piik.aar'), './mobile/bridge']);
  // Recreate the final ZIP so replaced native libraries leave no free blocks.
  run('java', ['-classpath', join(gradleHome, 'lib', launcher), 'org.gradle.launcher.GradleMain',
    '-Dorg.gradle.jvmargs=-Xmx2g', '-p', android, '--no-daemon',
    ':app:packageDebug', '--rerun', ':app:assembleDebug', '--console=plain']);
  const apk = join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!existsSync(apk)) throw new Error('The Android build did not produce its APK.');
  console.log(`Piik Android development APK: ${apk}`);
}
