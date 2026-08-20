# Windows Process-Audio Helper

This Windows 11 helper is the local input for Native sender process-tree audio.
It enumerates visible top-level windows locally and captures only the explicitly
selected process plus its children through WASAPI application loopback. It has
no whole-system fallback and no network code.

Build it outside the repository, then place both executables in the same output
directory (or set `SCREENER_PROCESS_AUDIO_HELPER` for a development run):

```powershell
$out = Join-Path ([IO.Path]::GetTempPath()) 'screener-native-audio'
./native/process-audio-helper/build.ps1 -OutputDirectory $out
```

The implementation follows Microsoft's MIT-licensed Application Loopback
sample contract without copying its WIL/Media Foundation fixture machinery:

- <https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback>
- <https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params>
