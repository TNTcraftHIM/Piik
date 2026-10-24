# Android development build

This is an Android sharing prototype for local testing.
It targets Android 10 or later on arm64 and x86-64 devices.
The Activity uses Piik's existing Web UI. A `mediaProjection` foreground service
owns Android consent, the display surface, platform encoding and eligible
playback audio and optional commentary input; Go owns the existing room, native
session, mixer and media routes.
Screen sharing captures the whole display. Source audio is subject
to Android's capture policy and excludes this app's playback.

Phones and tablets use the existing responsive UI. Automatic capture prefers
hardware AVC, then a Surface-capable MediaCodec VP8 encoder using the existing
software-VP8 native path. An explicit AVC request never silently switches codec.
Devices without either encoder can still join rooms. Devices without
Android System WebView display an unsupported-device message. TV capture depends
on the system's Projection and encoder support. Physical TV checks are pending.

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
`PIIK_GOMOBILE` may name an installed `gomobile` executable outside `PATH`.

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk` relative to
`mobile/`. Generated libraries, APKs, Gradle state and signing material stay
ignored. The `checklinkname` flag is required by the existing Android networking
dependency [anet on Go 1.23+](https://github.com/wlynxg/anet); it is confined to
this platform build. Android uses the repository's single Go dependency graph;
pins and temporary upstream replacements remain owned by the root `go.mod`.

Install with `adb install -r <apk>`. The shared startup page offers Local and
Public link. Use **+** beside the site section to enter a Piik site address;
confirm its displayed origin before allowing and opening it. Approval, revocation
and the starred startup site use the same management UI as desktop.
Use the Android menu's **Manage sites** to open management without unloading a
live Host. **Startup page** returns the main view after confirmation.

Local starts only when selected; Hosted
sites use their own room service and the existing native App connection. Site
approval and the starred startup site use the same persisted App configuration.
Public link uses the same shared room service and supervised official cloudflared
helper as desktop. Android executes the helper from the installed APK native
library directory and writes its temporary configuration into the app cache.
Failed room startup can retry from the same page after the failed attempt has
retired. An unexpected helper exit after startup ends this runtime; Restart Piik
creates a fresh attempt.

Create a room and select Android screen capture in the ordinary source picker.
Approve the Android projection prompt. Pure video does not request microphone
or camera access. Selecting camera or opening the room-voice microphone requests
only the corresponding Android permission, for the current approved top-level
site. Native playback audio and native commentary request recording permission only
when enabled. Commentary uses the OS-default microphone or an input from the
existing device selector; it joins the same Go mixer and stable shared audio
track as source sound. The capture service adds microphone foreground eligibility
only for that input lifetime. Room voice keeps its independent Browser input.
Background camera and room voice require a site that supplies Browser track
lifetime notifications; older sites retain ordinary foreground capture.
A document-bound MessagePort supplies demand to a short-lived camera/microphone
foreground service. It records no media and releases its types when the last
track or page ends. Revoking the currently approved site returns to management,
ending that page's media; other sites are unaffected.
The Activity exposes no JavaScript interface. WebView fullscreen uses Android's
custom-view window; Back exits fullscreen before ordinary page navigation.

Open the invitation in another device's Browser. Local HTTPS requires the usual
certificate confirmation. Stop from Piik or Android's projection indicator;
Android can also end projection on screen lock. Capture and optional audio use
the existing stream replacement transaction; the foreground service owns the
projection token and its single VirtualDisplay.

The API 35 emulator has verified Local creation, pure-video consent, native Host
preview frames, capture rotation, stop/cancel and normal exit/reopen. The installed
APK's public-link helper completed real DNS/TLS/public HTTP access and shutdown.
Management popups retain their opener; title-bar and keyboard insets leave the
Web UI unobscured. Background new-Viewer admission/reconnect, live room voice
and camera remain in the integrated acceptance scope. Physical microphone routing,
background audio samples, hardware AVC and phone/tablet/TV source-audio policies
remain device checks.

Platform references: [Projection lifecycle](https://developer.android.com/media/grow/media-projection),
[playback audio](https://developer.android.com/media/platform/av-capture),
[foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#media-projection),
[Go bindings](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile).
