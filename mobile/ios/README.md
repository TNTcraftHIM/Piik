# iPhone and iPad App

This development candidate targets iOS and iPadOS 27 or later. It opens the same
Web application in the system browser and uses the shared [Go mobile bridge](../bridge).
One App-owned ScreenCaptureKit stream supplies VideoToolbox H.264 access units
to the existing native media pipeline. There is no separate room backend,
frontend or ReplayKit extension.

## Shared Web workflow

Open Piik App and choose **Start Piik**. The App requests a visible system
background session, starts Go only after actual admission, then opens the shared
startup page in the default browser. Admission can fail; the App reports that
without starting a foreground-only backend. Saved sites, exact-origin approval
and Local entry use the same UI as desktop and Android. **Open App page** opens
management deliberately; **Stop Piik** closes this runtime and its capture. A new
start waits for the old runtime to retire. No public-link helper is packaged for iOS.

Use **+** to enter a site, then explicitly allow its displayed origin. Ordinary
browser popups keep their real opener. Native site approval and browser
camera/microphone prompts remain separate. Revocation retires native access
through the existing exact-origin loopback authority.

Choose the system capture source in the ordinary source picker, then confirm
Apple's recording chooser in App. **Confirm in App** uses the fixed
`piik://media` action; waking App never approves a site. After confirmation, use
iOS's return-to-browser button or app switcher to return to the same room tab.
Piik does not reopen a startup URL after capture and lose that tab's
ownership. A normal App open also presents any current pending chooser.
Actual encoded frames and the existing native ACK
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
The same build entry exercises the production session owner on macOS with only
OS/task/runtime boundaries replaced: admission, late callbacks, startup/stop,
browser opening and expiry. It also compiles the production video encoder and checks
real VideoToolbox access units, pause/recovery and idempotent controls. Hardware
unavailability is an explicit skip, separate from iOS device capture acceptance.

## Integration boundary

One user-started `BGContinuedProcessingTask` owns one Go runtime. Each attempt
registers and submits its exact unique identifier; only the permitted plist entry
uses a wildcard. The task's system interface displays an indeterminate session
and elapsed time. There is no fabricated completion percentage or automatic
maximum duration. A five-second progress update belongs only to that admitted
session and retires on Stop, failure or expiry. It is not a media/network controller.
The system may refuse or expire a task, including cancellation from its controls;
that ends the runtime. It does not promise an indefinitely resident server.
Force-quitting ends the process without a cancellation callback.

Platform callbacks retain capture start, encoder control, preparation completion
and precise stop. Full-display capture additionally uses the real `screen-capture`
background mode while a real stream is active. Idle Local rooms, native Viewer
media and browser camera/voice depend on the admitted background session. No
dummy audio session, location mode, VPN or second runtime supplies execution time.

Apple SDK compilation and physical-device acceptance are separate checks. System
consent and browser return, idle-session survival, OS cancellation, rotation,
background capture, late Viewer admission and reconnect require an iOS 27 device.
The indeterminate continued-session behavior is an experiment, not physical
acceptance. Safari has its own background lifecycle: leaving or locking the
browser can still affect browser camera, voice and route control independently.

Local uses same-origin loopback HTTP. Approved hosted HTTPS sites additionally
depend on WebKit allowing their active fetch/WebSocket requests to loopback;
the narrow ATS loopback exception alone does not establish that capability.
Hosted native linkage remains unverified rather than bypassing WebKit policy.

References: [Apple's iOS capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios),
[continued processing](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados),
[Apple DTS on user-controlled sessions](https://developer.apple.com/forums/thread/840384),
[Synctrain's Go/gomobile architecture](https://github.com/pixelspark/sushitrain),
[SCStream availability](https://developer.apple.com/documentation/screencapturekit/scstream),
[official Xcode 27 runner](https://github.com/actions/runner-images/issues/14404).

Synctrain's MPL-2.0 source was studied as an architecture reference; this session
owner is independently written and contains no copied implementation.
