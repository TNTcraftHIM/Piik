# Android App runtime

On the isolated 3.0 branch, this directory contains the Java system-browser
shell for the shared Rust App. It currently targets Android 10 or later on
ARM64, with the isolated application ID `tv.piik.android.channel3`. It does not
replace the published 2.x package or its data.

`AppRuntimeService` owns one runtime. Its serial worker starts Rust, receives
the final entry URL, and cancels and joins the runtime when the Service stops.
`MainActivity` retains notification permission and opens the existing launcher
in the system browser. The JNI entry in
[`prototype/channel-android`](../prototype/channel-android/) only supplies
Application Context and data/cache/frontend/helper paths; the shared
[App runtime](../prototype/channel-server/README.md#local-app-link) owns sites, room
hosting and networking.

Application Context is initialized before networking. Android WSS uses the
[official rustls platform verifier](https://github.com/rustls/rustls-platform-verifier)
and Android's certificate trust. Gradle reads the paired Android artifact
version from the JNI crate's Cargo lock. No Go business core or gomobile AAR is
used by this shell. The independent cloudflared helper remains Go-built.

## Development build

Use Rust 1.91 with `aarch64-linux-android`, NDK 30.0.16248370, JDK 17,
Gradle 8.11.1 and Android platform/build-tools 35. Configure Cargo's target linker
and C toolchain to use the NDK with Android API 29 and 16 KB page alignment, then
build the JNI library:

```sh
cargo +1.91.0 build --locked --manifest-path prototype/channel-android/Cargo.toml --target aarch64-linux-android --lib
```

Gradle's existing project consumes the JNI library as
`android/app/src/main/jniLibs/arm64-v8a/libpiik_channel_android.so`, the Android
cloudflared helper as `libcloudflared.so` in that same directory, the existing
App icon, and the [3.0 frontend bundle](../prototype/channel-browser/README.md)
as `android/app/src/main/assets/web/`. Once these generated inputs are staged,
run the ordinary project build:

```sh
gradle --no-daemon --max-workers=2 -p mobile/android :app:assembleDebug
```

The existing `scripts/build-android.mjs`, Go bridge and release workflow still
belong to the 2.x packaging path. They do not build this Rust runtime APK.
The 3.0 packaging replacement remains part of the existing
[TODO](../docs/todo.md); this runtime step adds no alternate release pipeline.
Toolchain paths and generated libraries, assets and APKs stay outside tracked
source.

## Signed release APK

Gradle reads signing material from `PIIK_ANDROID_KEYSTORE` (an absolute path),
`PIIK_ANDROID_STORE_PASSWORD`, `PIIK_ANDROID_KEY_ALIAS` and
`PIIK_ANDROID_KEY_PASSWORD`. Keep the keystore and passwords outside Git and
back up the signing key securely. Updates to an installed package must retain
its application ID and signing key. The experimental application ID above keeps
this runtime separate from the published 2.x App.

This step does not implement MediaProjection, MediaCodec capture/encoding,
playback sound or Android native input. Their accepted producer and permission
boundary is in the [network design](../docs/research/channel-network-design.md#implementation-boundary).
Browser camera and voice continue to use browser permissions.
