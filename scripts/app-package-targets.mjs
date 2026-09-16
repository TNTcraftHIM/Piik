export const CLOUDFLARED_VERSION = "2026.8.3";

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
    tunnelSha256: "83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae",
    tunnelArchive: false,
  },
  {
    id: "windows-386",
    nodePlatform: "win32",
    nodeArch: "ia32",
    goos: "windows",
    goarch: "386",
    cgo: false,
    appName: "piik-app.exe",
    tunnelName: "cloudflared.exe",
    captureName: "piik-capture.exe",
    tunnelAsset: "cloudflared-windows-386.exe",
    tunnelSha256: "bdfab00122a3c2a0772d3f176445f6baf0271fed71656d0902cbc23a0eea7048",
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
    tunnelSha256: "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e",
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
    tunnelSha256: "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f",
    tunnelArchive: true,
  },
];

export function appPackageTarget(id) {
  return APP_PACKAGE_TARGETS.find((target) => target.id === id) ?? null;
}

export function canRunAppTarget(target, platform = process.platform, arch = process.arch) {
  return platform === target.nodePlatform && (arch === target.nodeArch ||
    (platform === "win32" && arch === "x64" && target.nodeArch === "ia32"));
}

export function goBuildEnvironment(target) {
  return {
    ...process.env,
    GOOS: target.goos,
    GOARCH: target.goarch,
    CGO_ENABLED: target.cgo ? "1" : "0",
  };
}
