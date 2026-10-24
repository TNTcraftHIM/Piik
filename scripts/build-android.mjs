#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAndroidLicenseNotices } from './package-licenses.mjs';
import { writeAndroidAppIcon } from './app-icons.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'mobile', 'android');
const gradleHome = process.env.GRADLE_HOME;
if (!process.env.ANDROID_HOME || !process.env.ANDROID_NDK_HOME || !gradleHome) {
  throw new Error('Set ANDROID_HOME, ANDROID_NDK_HOME and GRADLE_HOME to the installed SDK, NDK and Gradle distribution.');
}
const launcher = readdirSync(join(gradleHome, 'lib')).find(name => /^gradle-launcher-.*\.jar$/.test(name));
if (!launcher) throw new Error('GRADLE_HOME does not contain a Gradle launcher.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}
if (process.platform === 'win32') run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build:web']);
else run('npm', ['run', 'build:web']);
writeAndroidLicenseNotices(root, join(android, 'app', 'src', 'main', 'assets', 'THIRD-PARTY-NOTICES.txt'), 'go');
writeAndroidAppIcon(join(root, 'cmd', 'piik-app', 'piik.ico'), join(android, 'app', 'src', 'main', 'res', 'drawable-nodpi', 'piik.png'));
mkdirSync(join(android, 'app', 'libs'), { recursive: true });
run(process.env.PIIK_GOMOBILE || 'gomobile', ['bind', '-trimpath', '-target=android/arm64,android/amd64', '-androidapi', '29',
  '-ldflags=-s -w -checklinkname=0', '-javapkg', 'tv.piik', '-o', join(android, 'app', 'libs', 'piik.aar'), './mobile/androidbridge']);
run('java', ['-classpath', join(gradleHome, 'lib', launcher), 'org.gradle.launcher.GradleMain', '-p', android, ':app:assembleDebug', '--console=plain']);
const apk = join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!existsSync(apk)) throw new Error('The Android build did not produce its APK.');
console.log(`Android development APK: ${apk}`);
