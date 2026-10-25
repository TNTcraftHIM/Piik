# iPhone and iPad App

This development candidate targets iOS and iPadOS 27 or later. It uses the same
Web application in WKWebView and the shared [Go mobile bridge](../bridge).
One App-owned ScreenCaptureKit stream supplies VideoToolbox H.264 access units
to the existing native media pipeline. There is no separate room backend,
frontend or ReplayKit extension.

## Shared Web workflow

Open Piik App to start its runtime and show the shared startup page. Saved sites,
exact-origin approval and Local entry use the same UI as desktop and Android.
The native **App page** action opens management alongside a live page;
**Stop Piik** closes this runtime and its capture. A new start waits for the old
runtime to retire. No public-link helper is packaged for iOS.

Use **+** to enter a site, then explicitly allow its displayed origin. WebKit
popups keep their real opener. Native site approval and browser camera/microphone
prompts remain separate; the wrapper permits media prompts only for the current
approved top-level origin. Revocation ends that page by returning to management.

Choose the system capture source in the ordinary source picker, then confirm
Apple's recording chooser. Actual encoded frames and the existing native ACK
complete startup. Encoder-profile replacement shares the current physical stream;
an OS-selected filter change replaces that stream inside the same capture owner.
Explicit cancellation and platform stop retire the owning Go request.

The candidate advertises native video only. Native source audio and commentary
are unavailable; camera and room voice keep the shared Web application's existing
permissions and capture. Other iOS versions can use Piik sites in their normal browser.

## Build with the Apple SDK

Use macOS with Xcode 27, the Go version in the root `go.mod` and Node from
`.node-version`. Install the repository's pinned binding tools, then run:

```sh
npm ci
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20261011034528-197770444867
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20261011034528-197770444867
node scripts/build-ios.mjs
```

`PIIK_GOMOBILE` may select an installed tool outside `PATH`. The entry builds the
shared Web assets and license notices, creates `Frameworks/PiikBridge.xcframework`
from the unique `mobile/bridge` package, and runs Xcode for device and simulator.
Outputs are unsigned development `.app` bundles under
`build/ios-client/DerivedData/Build/Products`, also packaged with macOS `ditto` as
`build/ios-client/piik-{iphoneos,iphonesimulator}-unsigned.zip` to preserve bundle
permissions and links. They are not installable release IPAs. For a device,
select a development team, bundle identifier and provisioning profile with the
`com.apple.developer.screen-recording` entitlement requested by `Piik.entitlements`;
no signing identity or profile is included. ScreenCaptureKit is absent from the
simulator SDK: that build supports the shared UI and runtime, and advertises no
native capture encoder. Actual recording requires a physical iOS 27 device.

The `iOS build` workflow uses the official `xcode-27` runner and uploads only
unsigned build artifacts. It neither publishes a release nor changes `main`.
Generated frameworks, notice files and build output are ignored.
The same build entry compiles the production video encoder on macOS and checks
real VideoToolbox access units, pause/recovery and idempotent controls. Hardware
unavailability is an explicit skip, separate from iOS device capture acceptance.

## Integration boundary

The foreground App owns one Go runtime; platform callbacks implement start, encoder control,
preparation completion and precise stop. Full-display capture uses the real
`screen-capture` background mode only while a real stream is active. Idle startup,
configuration, camera and room voice keep their normal foreground lifetime. There
is no background task, dummy audio session or unrelated keepalive mode. Ordinary
Safari-to-App operation is not advertised as a persistent native service.

Apple SDK compilation and physical-device acceptance are separate checks. System
consent, rotation, background capture, late Viewer admission and reconnect require
an iOS 27 device. Safari's Web process has its own background lifecycle; active
App capture does not promise perpetual execution of WKWebView's separate Web
process or a background browser tab. Existing native output can remain App-owned;
new Viewer admission, route changes and Web camera/voice still require actual
Web-process execution and must be checked on a device.

Local uses same-origin loopback HTTP. Approved hosted HTTPS sites additionally
depend on WebKit allowing their active fetch/WebSocket requests to loopback;
the narrow ATS loopback exception alone does not establish that capability.
Hosted native linkage remains unverified rather than bypassing WebKit policy.

References: [Apple's iOS capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios),
[SCStream availability](https://developer.apple.com/documentation/screencapturekit/scstream),
[official Xcode 27 runner](https://github.com/actions/runner-images/issues/14404).
