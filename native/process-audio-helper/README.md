# Windows Process-Audio Helper

This Windows 11 helper is the local input for Native sender process-tree audio.
It enumerates visible top-level windows locally and captures only the explicitly
selected process plus its children through WASAPI application loopback. It has
no whole-system fallback and no network code.

The standard evaluation ZIP builds this helper beside the sender through
`scripts/package-native-sender.ps1`. For a helper-only development build, use
an output directory outside the repository (or set
`SCREENER_PROCESS_AUDIO_HELPER` for a development run):

```powershell
$out = Join-Path ([IO.Path]::GetTempPath()) 'screener-native-audio'
./native/process-audio-helper/build.ps1 -OutputDirectory $out
```

The implementation follows Microsoft's MIT-licensed Application Loopback
sample contract without copying its WIL/Media Foundation fixture machinery:

- <https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback>
- <https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params>
