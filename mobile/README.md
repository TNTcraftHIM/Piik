# Android development build

This is an Android sharing prototype for local testing.
It targets Android 10 or later on arm64 and x86-64 devices.
The Activity uses Piik's existing Web UI. A `mediaProjection` foreground service
owns Android consent, the display surface, platform encoding and eligible
playback audio; Go owns the existing Local room, native session and media routes.
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

Install with `adb install -r <apk>`. Use the Android menu's **Open site** to enter
an HTTPS Piik site or full invitation; the invitation path and grant are retained.
Opening a site does not approve it. On that site, use the existing App connection
button and approve its exact origin in the popup. The popup keeps the real opener,
so approval rechecks the App connection, closes the popup and returns to the
original page without unloading its Host. **Piik sites** opens management.

The existing App management page offers a
Local room or an approved HTTPS site. Local starts only when selected; Hosted
sites use their own room service and the existing native App connection. Site
approval and the starred startup site use the same persisted App configuration.
Android does not offer the desktop temporary public-link process.

Create a room and select Android screen capture in the ordinary source picker.
Approve the Android projection prompt. Pure video does not request microphone
or camera access. Selecting camera or opening the room-voice microphone requests
only the corresponding Android permission, for the current approved top-level
site. Native playback audio separately requires Android's recording permission.
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

The current API 35 controlled-emulator check has verified Local room creation,
permission-free pure-video startup and native frames in the Host preview. The
source picker keeps its native selection while discovery is pending, avoiding
an unsolicited camera prompt. Background new-Viewer admission, room voice,
camera, rotation and immediate exit/reopen remain acceptance work; a running
capture process alone does not establish that background signaling or audio is
working. Physical phone/tablet/TV, hardware AVC and source-audio policies also
remain device checks.

Platform references: [Projection lifecycle](https://developer.android.com/media/grow/media-projection),
[playback audio](https://developer.android.com/media/platform/av-capture),
[foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#media-projection),
[Go bindings](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile).
