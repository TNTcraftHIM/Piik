# Android development build

This is an Android sharing prototype for local testing.
It targets Android 10 or later on arm64 and x86-64 devices.
The default variant opens Piik's existing Web UI in the system browser; an
embedded WebView variant remains available for comparison. An Android service owns
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
Devices without either encoder can still join rooms. The browser variant needs
an installed system browser; the embedded variant needs Android System WebView.
TV capture depends on the system's Projection and encoder support. Physical TV
checks are pending.

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
`PIIK_GOMOBILE` may name an installed `gomobile` executable outside `PATH`.

The default build produces `android/app/build/outputs/apk/browser/debug/app-browser-debug.apk`
relative to `mobile/`. Add `--embedded` for the comparison build at
`android/app/build/outputs/apk/embedded/debug/app-embedded-debug.apk`. Both use the
same application ID: installing one replaces the other while retaining App settings.
Generated libraries, APKs, Gradle state and signing material stay
ignored. The `checklinkname` flag is required by the existing Android networking
dependency [anet on Go 1.23+](https://github.com/wlynxg/anet); it is confined to
this platform build. Android uses the repository's single Go dependency graph;
pins and temporary upstream replacements remain owned by the root `go.mod`.

Install with `adb install -r <apk>`. The shared startup page offers Local and
Public link. Use **+** beside the site section to enter a Piik site address;
confirm its displayed origin before allowing and opening it. Approval, revocation
and the starred startup site use the same management UI as desktop.
On a connected site, use **App → Open App page** to manage saved origins.
The embedded variant also provides **Manage sites** in its Android menu to open
management without unloading a live Host. **Startup page** returns its main view
after confirmation.

The browser variant opens that same startup page in the default browser.
Its ongoing notification opens Piik or stops the local backend. Screen sharing
uses **Confirm in App** for recording and any requested sound permission. App
returns to the original browser tab after the complete capture startup settles.
Opening App while a request is pending also handles
that request, so sites without the new shortcut can still confirm in App.
The website's App approval still requires its displayed exact origin; waking
App does not authorize a site. If the connection card cannot find App, choose
**Open Piik App**, then return to the same browser page to continue discovery.
Choose **Open App page** and confirm the displayed origin before granting access.
Camera and room voice use the browser's own permissions. The embedded variant
retains its in-App page and management menu.

Local starts only when selected; Hosted sites use their own room service and
the existing native App connection. Site
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
In the embedded variant, background camera and room voice require a site that
supplies Browser track lifetime notifications; older sites retain ordinary foreground capture.
A document-bound MessagePort supplies demand to a short-lived camera/microphone
foreground service. It records no media and releases its types when the last
track or page ends. Revoking the currently approved site returns to management,
ending that page's media; other sites are unaffected.
The Activity exposes no JavaScript interface. WebView fullscreen uses Android's
custom-view window; Back exits fullscreen before ordinary page navigation.

Screen capture and device sound do not turn on the microphone. Native commentary
is enabled separately and uses Android's voice-communication capture mode for
available system echo processing. Android limits simultaneous microphone capture
by separate apps: if browser room voice and App commentary compete, use one
microphone path. Headphones also prevent speaker sound from feeding back into
the microphone.

Open the invitation in another device's Browser. Local HTTPS requires the usual
certificate confirmation. Stop from Piik or Android's projection indicator;
Android can also end projection on screen lock. Capture and optional audio use
the existing stream replacement transaction; the foreground service owns the
projection token and its single VirtualDisplay.

The embedded variant on the API 35 emulator has verified Local creation,
pure-video consent, native Host preview frames, capture rotation, stop/cancel and
normal exit/reopen. The installed APK's public-link helper completed real
DNS/TLS/public HTTP access and shutdown.
Management popups retain their opener; title-bar and keyboard insets leave the
Web UI unobscured. Background new-Viewer admission/reconnect, live room voice
and camera remain in the integrated acceptance scope. Physical microphone routing,
background audio samples, hardware AVC and phone/tablet/TV source-audio policies
remain device checks.
The system-browser variant's native media path remains in acceptance.

Platform references: [Projection lifecycle](https://developer.android.com/media/grow/media-projection),
[playback audio](https://developer.android.com/media/platform/av-capture),
[foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#media-projection),
[Go bindings](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile).
