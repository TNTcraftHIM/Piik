# ADR-0008: Browser Screen-Audio Scope

- Status: accepted for Browser capture and the Windows Client audio paths
- Date: 2026-08-21
- Last updated: 2026-08-27

## Context

`getDisplayMedia({ audio: true })` may return tab, window, monitor, or system
audio depending on Browser, operating system, selected surface, and user choice.
The Web API exposes no portable proof that a returned track is isolated to one
application. Sharing a system mix can unintentionally include calls or
notifications.

Windows offers a narrower native primitive through WASAPI application loopback
for one selected process tree. The native Client owns that path for selected
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
   [media quality](../product/media-quality.md). There is no Web Audio mixer,
   resampler, second representation, or independent audio clock.
4. Browser source switching replaces the current screen-audio track in the same
   persistent media stream. Local Viewer play, mute, and volume stay inside the
   native media element.
5. Do not describe generic Browser system audio as application-isolated. UI and
   documentation must leave source scope to the Browser's actual result.
6. Windows process-tree audio for a selected window, and default render-device
   loopback for a selected display, are Client capabilities when the platform
   probe and physical gate pass. WGC/MF video and the Client media boundary are owned by
   [ADR-0010](./0010-cross-platform-client-runtime.md); measurements are in
   [Native Client media](../research/native-client-media.md).

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
