# Screener Native Sender for Windows x64

This evaluation package contains the current Native sender and its Windows 11
window-capture helper. It has no installer, updater, code signature, or bundled
server.

## Run

1. Keep `screener-sender.exe` and `screener-window-capture.exe` in the same
   directory.
2. Run `screener-sender.exe`. It opens a loopback-only UI in the default
   browser; current Chrome or Edge is required.
3. Enter the Screener server and site access password. Browser VP8 remains the
   default; browser H.264 and Native window H.264 are explicit opt-ins.
4. For a browser video source, choose the browser screen/window and optionally
   select the same window target for process-tree audio. Native window H.264
   requires one target and captures its video and process-tree audio together.
5. Close the console window to stop the sender.

Native capture requires Windows 11 build 22000 or newer. It binds the selected
window to its process identity, never falls back to the system mix, and never
falls back from the hardware-only Media Foundation H.264 encoder to software.
Browser H.264 still requests browser hardware preference without proving which
physical encoder Chrome or Edge selected. Viewers use the normal Web client.

Verify the downloaded ZIP against its adjacent `.sha256` file, then verify the
files inside it with `SHA256SUMS.txt`. The package is unsigned, so Windows may
show an unknown-publisher warning.

The project distribution license is not yet selected. This short-lived Actions
artifact is for evaluation and does not grant redistribution rights. Exact
third-party license texts for the linked Go runtime and modules are under
`licenses/`.

## Build

From a clean Git checkout on Windows with Go 1.26.6 and Visual Studio C++ Build
Tools installed:

```powershell
$output = Join-Path ([IO.Path]::GetTempPath()) "screener-native-package-$([Guid]::NewGuid())"
./scripts/package-native-sender.ps1 -OutputDirectory $output
```
