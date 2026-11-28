export const CLOUDFLARED_VERSION = "2026.11.2";
export const CLOUDFLARED_SOURCE_SHA256 = "e9122343a3708e9a691239b5901916819e4933f8751a0364b3800fc5bc6a7ca4";

// Android packages both supported ABIs in one installable APK, not a Go CLI.
export const ANDROID_APP_PACKAGE_TARGET = {
  id: "android-universal",
  artifact: "piik-app-android-universal.apk",
  mirrorArtifact: "piik-app-android-universal.zip",
};

export function androidVersionCode(version) {
  if (version === "development") return 1;
  const parts = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!parts) throw new Error("Android version must be vMAJOR.MINOR.PATCH or development");
  const [major, minor, patch] = parts.slice(1).map(Number);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error("Android versionCode requires minor/patch <= 999 and a code in 1..2100000000");
  }
  return code;
}

export const APP_PACKAGE_TARGETS = [
  {
    id: "windows-amd64",
    nodePlatform: "win32",
    nodeArch: "x64",
    goos: "windows",
    goarch: "amd64",
    cgo: false,
    appName: "piik-app.exe",
    tunnelName: "cloudflared.exe",
    captureName: "piik-capture.exe",
    tunnelAsset: "cloudflared-windows-amd64.exe",
    tunnelSha256: "555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113",
    tunnelArchive: false,
  },
  {
    id: "linux-amd64",
    nodePlatform: "linux",
    nodeArch: "x64",
    goos: "linux",
    goarch: "amd64",
    cgo: false,
    appName: "piik-app",
    tunnelName: "cloudflared",
    captureName: "piik-capture",
    tunnelAsset: "cloudflared-linux-amd64",
    tunnelSha256: "56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf",
    tunnelArchive: false,
  },
  {
    id: "linux-arm64",
    nodePlatform: "linux",
    nodeArch: "arm64",
    goos: "linux",
    goarch: "arm64",
    cgo: false,
    appName: "piik-app",
    tunnelName: "cloudflared",
    captureName: "piik-capture",
    tunnelAsset: "cloudflared-linux-arm64",
    tunnelSha256: "04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281",
    tunnelArchive: false,
  },
  {
    id: "darwin-arm64",
    nodePlatform: "darwin",
    nodeArch: "arm64",
    goos: "darwin",
    goarch: "arm64",
    cgo: true,
    appName: "piik-app",
    tunnelName: "cloudflared",
    captureName: "piik-capture",
    tunnelAsset: "cloudflared-darwin-arm64.tgz",
    tunnelSha256: "f6d58eeec91ad1ec5fd1f7e4a587303772929b2625be5d24068033851c36ff55",
    tunnelArchive: true,
  },
  {
    id: "darwin-amd64",
    nodePlatform: "darwin",
    nodeArch: "x64",
    goos: "darwin",
    goarch: "amd64",
    cgo: true,
    appName: "piik-app",
    tunnelName: "cloudflared",
    captureName: "piik-capture",
    tunnelAsset: "cloudflared-darwin-amd64.tgz",
    tunnelSha256: "6153d9ec629174882a3adbff2f7dc5a24b4f3bdd7ccc38eaa84fba26eb890311",
    tunnelArchive: true,
  },
];

export function appPackageTarget(id) {
  return APP_PACKAGE_TARGETS.find((target) => target.id === id) ?? null;
}

// Finder can relocate a downloaded .app independently of its ZIP neighbours.
// Keep the executable and its existing relative runtime paths inside the bundle.
export function appPackageDirectory(target) {
  return target.goos === "darwin" ? "Piik App.app/Contents/MacOS" : "";
}

export function goBuildEnvironment(target) {
  return {
    ...process.env,
    GOOS: target.goos,
    GOARCH: target.goarch,
    CGO_ENABLED: target.cgo ? "1" : "0",
  };
}
