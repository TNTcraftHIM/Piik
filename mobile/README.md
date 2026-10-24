# Android development build

This is an Android sharing prototype for local testing.
It targets Android 10 or later on arm64 and x86-64 devices.
The Activity uses Piik's existing Web UI. A `mediaProjection` foreground service
owns Android consent, the display surface, platform encoding and eligible
playback audio; Go owns the existing Local room, native session and media routes.
The first version shares the whole display on the LAN. Source audio is subject
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
Build the current Web assets from the repository root first:

```sh
npm run build:web
node --input-type=module -e "import {writeAndroidLicenseNotices} from './scripts/package-licenses.mjs'; writeAndroidLicenseNotices(process.cwd(), 'mobile/android/app/src/main/assets/THIRD-PARTY-NOTICES.txt', 'go')"
node --input-type=module -e "import {writeAndroidAppIcon} from './scripts/app-icons.mjs'; writeAndroidAppIcon('cmd/piik-app/piik.ico', 'mobile/android/app/src/main/res/drawable-nodpi/piik.png')"
```

Then, from `mobile/`, install the pinned Go binding tools and build the library:

```sh
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20261011034528-197770444867
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20261011034528-197770444867
gomobile bind -trimpath -target=android/arm64,android/amd64 -androidapi 29 \
  -ldflags="-s -w -checklinkname=0" -javapkg tv.piik \
  -o android/app/libs/piik.aar ./androidbridge
cd android
gradle :app:assembleDebug
```

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk` relative to
`mobile/`. Generated libraries, APKs, Gradle state and signing material stay
ignored. The `checklinkname` flag is required by the existing Android networking
dependency [anet on Go 1.23+](https://github.com/wlynxg/anet); it is confined to
this platform build. Android uses the repository's single Go dependency graph;
pins and temporary upstream replacements remain owned by the root `go.mod`.

Install with `adb install -r <apk>`. Open Piik, create a room and select Android
screen capture in the ordinary source picker. Approve the Android prompt. Open
the invitation in another device's Browser on the same LAN; the existing Local
HTTPS certificate requires the normal browser confirmation. Stop from Piik or
Android's projection indicator. Android can also end projection on screen lock.

The API 35 emulator has delivered screen and playback audio to an independent
Browser Viewer, including while another App was foregrounded. Use physical
devices to check hardware AVC, source-audio policies and phone/tablet/TV behavior.
Camera capture, room-voice microphone access and hosted-Site pairing are outside
this first prototype.

Platform references: [Projection lifecycle](https://developer.android.com/media/grow/media-projection),
[playback audio](https://developer.android.com/media/platform/av-capture),
[foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#media-projection),
[Go bindings](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile).
