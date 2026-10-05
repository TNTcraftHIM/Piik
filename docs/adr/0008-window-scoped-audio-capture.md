# ADR-0008: Browser Screen-Audio Scope

- Status: accepted for Browser capture and the Windows App audio paths
- Date: 2026-08-21
- Last updated: 2026-10-06

## Context

`getDisplayMedia({ audio: true })` may return tab, window, monitor, or system
audio depending on Browser, operating system, selected surface, and user choice.
The Web API exposes no portable proof that a returned track is isolated to one
application. Sharing a system mix can unintentionally include calls or
notifications.

Windows offers a narrower native primitive through WASAPI application loopback
for one selected process tree. The native App owns that path for selected
windows; a selected display uses the default render-device loopback when the
platform probe and physical gate report it.

## Decision

1. Browser capture asks for window audio on window surfaces and system audio on
   monitor surfaces where those hints exist. The Browser picker and consent
   remain authoritative; older Browsers may ignore the hints.
2. Missing audio never blocks video-only sharing and is reported explicitly.
   Track presence does not prove its source or isolation.
3. Returned screen-audio tracks use `contentHint = "music"`. Current bounded
   sender ceilings and narrow Opus stereo answer normalization are owned by
   [media quality](../standards/media-quality.md). Audio scope adds no second
   representation or independent clock; Host commentary uses the existing mixer.
4. Browser source switching replaces the current screen-audio track in the same
   persistent media stream. Local Viewer play, mute, and volume stay inside the
   native media element.
5. Do not describe generic Browser system audio as application-isolated. UI and
   documentation must leave source scope to the Browser's actual result.
6. Windows process-tree audio for a selected window, and default render-device
   loopback for a selected display, are App capabilities when the platform
   probe and physical gate pass. WGC/MF video and the App media boundary are owned by
   [ADR-0010](./0010-cross-platform-client-runtime.md); measurements are in
   [Native App media](../research/native-client-media.md).
7. Windows App screen sharing can optionally exclude one selected process tree
   through WASAPI's exclusion mode after successful activation of that mode.
   Probe Windows 10 build 19041+ to include backported implementations, following
   the same capability boundary as application capture. Microsoft's documented
   minimum remains 20348; a Windows version alone does not establish support.
   This mode spans all render endpoints; it is not restricted to the
   default playback device. Reuse source enumeration and the existing PCM/mixed
   output. Generic Browser capture and arbitrary unrelated process sets are not
   covered. [Media quality](../standards/media-quality.md#screen-audio) owns
   selection lifetime and failure behavior.

## Consequences

Positive:

- Web capture stays on standard permission and track APIs;
- audio absence and privacy scope are represented honestly; and
- current audio quality controls do not require another media graph.

Negative:

- Browser/system combinations remain inconsistent;
- Web cannot promise per-process isolation; and
- other platform application-audio capture requires separate native platform
  gates.

## Primary Sources

- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [Windows application loopback](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [WASAPI process-loopback activation](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
- [OBS application-audio platform support](https://obsproject.com/kb/application-audio-capture-guide)
