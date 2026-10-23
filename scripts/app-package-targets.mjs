export const CLOUDFLARED_VERSION = "2026.10.3";

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
    tunnelSha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
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
    tunnelSha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
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
    tunnelSha256: "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
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
    tunnelSha256: "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
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
    tunnelSha256: "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
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
