// Keep the published x64 archive name; additional architectures are explicit.
// A Windows target ships the same four runtime files with an `.exe` binary and a
// ZIP container, so `--os windows` selects it without touching the Linux names.
export const SERVER_PACKAGE_TARGETS = [
  { id: "server", goos: "linux", goarch: "amd64", suffix: "" },
  { id: "server-linux-arm64", goos: "linux", goarch: "arm64", suffix: "-linux-arm64" },
  { id: "server-windows-amd64", goos: "windows", goarch: "amd64", suffix: "-windows-amd64" },
];
