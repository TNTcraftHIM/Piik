// Keep the published x64 archive name; additional architectures are explicit.
export const SERVER_PACKAGE_TARGETS = [
  { id: "server", goos: "linux", goarch: "amd64", suffix: "" },
  { id: "server-linux-arm64", goos: "linux", goarch: "arm64", suffix: "-linux-arm64" },
];
