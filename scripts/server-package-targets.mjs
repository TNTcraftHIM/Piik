// Keep the published x64 archive name; additional architectures are explicit.
// A Windows target ships the same runtime tree with an `.exe` binary and a
// ZIP container, so `--os windows` selects it without touching the Linux names.
export const SERVER_PACKAGE_TARGETS = [
  { id: "server", goos: "linux", goarch: "amd64", rustTarget: "x86_64-unknown-linux-musl", suffix: "" },
  { id: "server-linux-arm64", goos: "linux", goarch: "arm64", rustTarget: "aarch64-unknown-linux-musl", suffix: "-linux-arm64" },
  { id: "server-windows-amd64", goos: "windows", goarch: "amd64", rustTarget: "x86_64-pc-windows-msvc", suffix: "-windows-amd64" },
];
