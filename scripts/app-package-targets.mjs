export const APP_PACKAGE_TARGETS = [
  {
    id: "windows-amd64",
    nodePlatform: "win32",
    nodeArch: "x64",
    goos: "windows",
    goarch: "amd64",
    cgo: false,
    appName: "piik-app.exe",
    captureName: "piik-capture.exe",
  },
  {
    id: "linux-amd64",
    nodePlatform: "linux",
    nodeArch: "x64",
    goos: "linux",
    goarch: "amd64",
    cgo: false,
    appName: "piik-app",
    captureName: "piik-capture",
  },
  {
    id: "darwin-arm64",
    nodePlatform: "darwin",
    nodeArch: "arm64",
    goos: "darwin",
    goarch: "arm64",
    cgo: true,
    appName: "piik-app",
    captureName: "piik-capture",
  },
];

export function appPackageTarget(id) {
  return APP_PACKAGE_TARGETS.find((target) => target.id === id) ?? null;
}

export function goBuildEnvironment(target) {
  return {
    ...process.env,
    GOOS: target.goos,
    GOARCH: target.goarch,
    CGO_ENABLED: target.cgo ? "1" : "0",
  };
}
