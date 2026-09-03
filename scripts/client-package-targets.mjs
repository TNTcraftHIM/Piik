export const CLIENT_PACKAGE_TARGETS = [
  {
    id: "windows-amd64",
    goos: "windows",
    goarch: "amd64",
    clientName: "screener-client.exe",
    nodeName: "node.exe",
    tunnelName: "cloudflared.exe",
    captureName: "screener-client-capture.exe",
  },
  {
    id: "linux-amd64",
    goos: "linux",
    goarch: "amd64",
    clientName: "screener-client",
    nodeName: "node",
    tunnelName: "cloudflared",
    captureName: null,
  },
  {
    id: "darwin-arm64",
    goos: "darwin",
    goarch: "arm64",
    clientName: "screener-client",
    nodeName: "node",
    tunnelName: "cloudflared",
    captureName: null,
  },
];

export function clientPackageTarget(id) {
  return CLIENT_PACKAGE_TARGETS.find((target) => target.id === id) ?? null;
}
