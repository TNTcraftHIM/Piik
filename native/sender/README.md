# Screener Native Sender for Windows x64

This evaluation package contains the current Native sender and the Windows 11
process-audio helper. It has no installer, updater, code signature, or bundled
server.

## Run

1. Keep `screener-sender.exe` and `screener-process-audio.exe` in the same
   directory.
2. Run `screener-sender.exe`. It opens a loopback-only UI in the default
   browser; current Chrome or Edge is required.
3. Enter the Screener server and Host admission password, choose VP8 (default)
   or experimental H.264, then choose the screen or window to share.
4. Process audio is off by default. To enable it, select the exact target in
   the audio list and select the same target in the browser picker.
5. Close the console window to stop the sender.

Process audio requires Windows 11 build 22000 or newer. It captures only the
selected process tree and never falls back to the system mix. H.264 requests
browser hardware preference but does not prove which physical encoder Chrome
or Edge selected. Viewers continue using the normal Web client.

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
