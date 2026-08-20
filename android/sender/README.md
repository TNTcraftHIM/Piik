# Android Screen Sender

This source-only P1 slice lets an Android 14/API 34+ device publish a 720p30
screen track and optional selected-app playback-audio track to at most two Web
Viewers assigned as direct children by the existing `screener-v2` controller.

## Build

Install JDK 17 and Android SDK 35, then run:

```text
./gradlew :protocol:test :app:assembleDebug
```

The debug APK is written under `app/build/outputs/apk/debug/`. CI runs the same
protocol tests and debug compile. No release signing or package publication is
configured.

## Use

Open the app, enter the HTTPS Screener base URL and site-access password, then
leave playback audio off or explicitly select one app, then choose a screen or
app from Android's system picker. Audio is selected separately because Android
does not expose the system picker's selected package/UID; it may therefore differ
from the shared picture. The app keeps credentials and room material in memory
only. The displayed private invite can be opened by an unchanged Web Viewer.

Enabling playback audio requests `RECORD_AUDIO`, but the sender disables the
WebRTC audio device module's microphone input. It filters playback to the
selected app UID and eligible game/media usages. Apps may block capture or have
no eligible playback, in which case the track can remain silent; there is no
microphone or whole-system fallback. “Playback requested” does not claim that
audible media was observed.

The foreground notification and system capture indicator remain visible for the
whole session. Stopping from the app or system picker closes capture, signaling,
and every PeerConnection.

## First-Slice Boundary

- Playback audio is default-off and limited to one explicitly selected,
  single-package UID. Background continuity, silence detection and A/V
  synchronization remain device gates.
- Hardware VP8/H.264 encoders only; there is no software encoder fallback.
- At most two STUN-only direct-child edges. The server remains the route owner.
- SFU publication and selected-edge TURN are not implemented. The client reports
  their attempts as bounded route failures instead of claiming support.
- Rotation resize, background rebuild, Wi-Fi/cellular reselection, iOS, release
  signing, and device/performance matrices remain later work.
