# Android App

This directory contains the Android App shell and capture bridge.
It targets Android 10 or later on ARM64 and x64 devices, using the Android ABI
identifiers `arm64-v8a` and `x86_64` in one APK.
Silip opens its existing Web UI in the system browser. An Android service owns
the shared Go runtime until the user stops App; the Activity handles visible
system consent. A `mediaProjection` foreground service
owns the approved projection token, display surface, platform encoding and eligible
playback audio and optional commentary input; Go owns the existing room, native
session, mixer and media routes.
Screen sharing captures the whole display. Source audio is subject
to Android's capture policy and excludes this app's playback.

Phones and tablets use the existing responsive UI. Automatic capture prefers
hardware AVC, then a Surface-capable MediaCodec VP8 encoder using the existing
software-VP8 native path. An explicit AVC request never silently switches codec.
Quality settings use the shared capture limits; the selected MediaCodec admits
each requested profile during startup.
When supported by that encoder, constant-bitrate mode keeps Android's quality
floor from overriding the network allocation.
The existing WebRTC FrameDropper also gates each encoder's input from its actual
output size, so a codec that reaches its compression limit can reduce frame rate
instead of ignoring the allocation. The shared capture clock and other outputs
continue independently.
Devices without either encoder can still join rooms. Silip needs an installed
system browser.
TV capture depends on the system's Projection and encoder support. Physical TV
checks are pending.

Native Android capture reuses the shared screen-share output plan and P2P/SFU
transports. One Projection and captured texture feed the original and requested
lower renditions. Optional encoders start on demand, retire when unused and leave
the original available if the device cannot admit another encoder. Received
media can use the same forwarding path.
Live bitrate follows the shared [media-quality contract](../docs/standards/media-quality.md):
remote allocations reach the encoder without the local preview holding it at its ceiling.
Android can control a desktop through the shared browser controls; it does not
accept remote keyboard, mouse or virtual-gamepad input itself. Detached tool
windows depend on the browser's Document Picture-in-Picture support.

## Build

Use JDK 17, Gradle 8.11.1, Android platform/build-tools 35, platform-tools and
NDK 30.0.16248370. Set `ANDROID_HOME` and `ANDROID_NDK_HOME` to those local tools.
Set `GRADLE_HOME` to the installed Gradle distribution. Install the pinned
`gomobile` and `gobind` tools, then run the repository build entry from its root:

```sh
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20261011034528-197770444867
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20261011034528-197770444867
node scripts/build-android.mjs
```

The entry builds the same Web assets, generates the existing icon and license
notices, binds the Go runtime for both supported ABIs and packages the APK.
The single mobile Go entry lives in `mobile/bridge`; this command generates its
Android binding.
`SILIP_GOMOBILE` may name an installed `gomobile` executable outside `PATH`.

The build injects the same product version and source revision used by desktop
App packages. The shared startup page displays that identity; development APKs
also include their short revision in Android's application version.

The build produces `android/app/build/outputs/apk/debug/app-debug.apk`
relative to `mobile/`. The application ID remains `io.github.p4aaaul.silip.android`, so an update
signed with the same key replaces the previous installation while retaining App settings.
Generated libraries, APKs, Gradle state and signing material stay
ignored. The `checklinkname` flag is required by the existing Android networking
dependency [anet on Go 1.23+](https://github.com/wlynxg/anet); it is confined to
this platform build. Android uses the repository's single Go dependency graph;
pins and temporary upstream replacements remain owned by the root `go.mod`.

### Signed release APK

Use the same entry with `--release --output <new-directory>`. Set
`SILIP_BUILD_VERSION` to the planned product version, and inject signing material
through `SILIP_ANDROID_KEYSTORE` (absolute path), `SILIP_ANDROID_STORE_PASSWORD`,
`SILIP_ANDROID_KEY_ALIAS` and `SILIP_ANDROID_KEY_PASSWORD`. Keep the keystore and
passwords outside tracked files; back up the long-lived signing key securely.
Missing signing inputs fail the release build. Release packages reject Android
debug certificates and debuggable APKs. Release builds require a clean checkout
and verify that the same clean source revision still owns the final output.

The universal `silip-app-android-universal.apk` contains arm64 and x86-64.
The build verifies its signature, package identity, version and ABIs, then writes
the existing schema-2 release descriptor and SHA-256 sidecar beside the APK.
The existing CI App matrix publishes it with the matching desktop/Server
artifacts. Publication requires four repository secrets:
`SILIP_ANDROID_KEYSTORE_BASE64` (the keystore bytes in Base64),
`SILIP_ANDROID_STORE_PASSWORD`, `SILIP_ANDROID_KEY_ALIAS` and
`SILIP_ANDROID_KEY_PASSWORD`. Manual candidate runs use the same release variant
with a disposable signing key, and never publish.

A formal APK cannot update an earlier debug-signed candidate. Uninstall that
candidate before installing the first formal release; this removes its saved App
settings. Later formal updates retain settings when signed with the same key.

Install with `adb install -r <apk>`. The shared startup page offers Local and
Public link. Use **+** beside the site section to enter a Silip site address;
confirm its displayed origin before allowing and opening it. Approval, revocation
and the starred startup site use the same management UI as desktop.
On a connected site, use **App → Open App page** to manage saved origins.

The ongoing notification opens Silip or stops the local backend. Starting screen
sharing opens App for system recording consent when the browser permits the
handoff; **Confirm in App** remains available when another click is needed.
Replacing an active native source reuses recording consent without opening App.
App returns to the original browser tab after the complete capture startup settles.
Opening App while a request is pending also handles
that request, so sites without the new shortcut can still confirm in App.
The website's App approval still requires its displayed exact origin; waking
App does not authorize a site. If the connection card cannot find App, choose
**Open Silip App**, then return to the same browser page to continue discovery.
Choose **Open App page** and confirm the displayed origin before granting access.
Camera and room voice use the browser's own permissions.

Local starts only when selected; Hosted sites use their own room service and
the existing native App connection. Site
approval and the starred startup site use the same persisted App configuration.
Public link uses the same shared room service and supervised official cloudflared
helper as desktop. Android executes the helper from the installed APK native
library directory and writes its temporary configuration into the app cache.
Failed room startup can retry from the same page after the failed attempt has
retired. An unexpected room-service or helper exit ends that room; the launcher,
App connection and other approved sites remain available. Select the room mode
again to start a fresh room.

Create a room and select Android screen capture in the ordinary source picker.
Approve the Android projection prompt. Pure video does not request microphone
or camera access. Camera sharing and room voice request their permissions in the
browser. Native playback audio and native commentary request recording permission only
when enabled. Commentary uses the OS-default microphone or an input from the
existing device selector; it joins the same Go mixer and stable shared audio
track as source sound. The capture service adds microphone foreground eligibility
only for that input lifetime. Room voice keeps its independent Browser input.
The browser owns navigation, fullscreen and camera/microphone capture lifetimes;
Silip owns the native screen and source-audio resources.

Screen capture and device sound do not turn on the microphone. Native commentary
is enabled separately and uses Android's voice-communication capture mode for
available system echo processing. Android limits simultaneous microphone capture
by separate apps: if browser room voice and App commentary compete, use one
microphone path. Headphones also prevent speaker sound from feeding back into
the microphone.

If a local room stops responding after switching to the browser or locking the
screen, check Silip's battery and background-activity settings. Some devices
restrict background network access even while the process remains running.
Allow unrestricted background activity for Silip and keep its ongoing notification
enabled. [Xiaomi's network troubleshooting](https://www.mi.com/ph/support/faq/details/KA-538010/)
describes this battery-policy setting.

Open the invitation in another device's Browser. Local HTTPS requires the usual
certificate confirmation. Stop from Silip or Android's projection indicator;
Android can also end projection on screen lock. Capture and optional audio use
the existing stream replacement transaction; the foreground service owns the
projection token and its single VirtualDisplay.

Platform checks are summarized in [verification status](../docs/verification-status.md#device-evidence-boundary);
remaining work stays in the [TODO ledger](../docs/todo.md).

Platform references: [Projection lifecycle](https://developer.android.com/media/grow/media-projection),
[playback audio](https://developer.android.com/media/platform/av-capture),
[foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#media-projection),
[encoder rate control](https://developer.android.com/reference/android/media/MediaCodec#minimum-quality-floor-for-video-encoding),
[Go bindings](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile).
