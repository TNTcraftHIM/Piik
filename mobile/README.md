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

Screen/app selection uses Android's system picker. One MediaProjection owns the
image source and optional playback sound; Rust encodings use the shared Native
producer and source clock. Permission and first-frame waits belong to the
selecting page and use the same stop operation as active capture. The
[network design](../docs/research/channel-network-design.md#implementation-boundary)
owns that boundary. Android does not expose a controlled keyboard/mouse endpoint;
Browser camera and room voice keep their Browser permissions.

## Development build

Use Rust 1.91 with `aarch64-linux-android`, NDK 30.0.16248370, JDK 17,
Gradle 8.11.1 and Android platform/build-tools 35. Also install the
`x86_64-linux-android` and `wasm32-unknown-unknown` Rust targets,
wasm-bindgen CLI 0.2.129 and cargo-about 0.9.3.
Set `ANDROID_HOME`, `ANDROID_NDK_HOME` and `GRADLE_HOME`, then run the shared
packaging entry point:

```sh
node scripts/build-android.mjs
```

That script configures API 29 and 16 KB alignment, builds the ARM64 and x64
Rust JNI libraries and cloudflared helpers, bundles the
[shared frontend](../prototype/channel-browser/README.md), and passes those
inputs, icons and third-party notices to the existing Gradle project.
`CARGO_TARGET_DIR` can place build output outside the checkout;
`WASM_BINDGEN` and `CARGO_ABOUT` can point to installed tool executables.
For a signed release candidate, use the same entry point with a new output directory:

```sh
node scripts/build-android.mjs --release --output build/android-release
```

Toolchain paths and generated libraries, assets and APKs stay outside tracked
source. [TODO](../docs/todo.md) owns remaining device acceptance and publication holds.

## Signed release APK

Gradle reads signing material from `PIIK_ANDROID_KEYSTORE` (an absolute path),
`PIIK_ANDROID_STORE_PASSWORD`, `PIIK_ANDROID_KEY_ALIAS` and
`PIIK_ANDROID_KEY_PASSWORD`. Keep the keystore and passwords outside Git and
back up the signing key securely. Updates to an installed package must retain
its application ID and signing key. The experimental application ID above keeps
this runtime separate from the published 2.x App.
