# iPhone and iPad prototype

This branch contains a native Swift/WKWebView shell over Piik's existing HTTPS
Web application and an explicitly local native capture/VideoToolbox probe.
It contains no second room backend, frontend, route controller or signaling
protocol. The first launch opens the public Demo; Open site accepts another HTTPS
site or a full invitation while retaining its path/query/fragment. WebKit owns
playback, camera and room voice. Its standard origin prompt and iOS permissions
are requested only by an actual page request. Cross-origin subframes cannot
request capture through the wrapper's permission delegate. Popup windows keep
their actual opener and can close themselves.

On iOS27+, Capture probe uses Apple's current ScreenCaptureKit content-sharing
picker and an App-owned SCStream. The declared `screen-capture` background mode
is the standard capture lifetime; microphone and camera controls are not enabled.
Stop capture probe or the system capture control ends it. Scene-based App setup
supports the current UIKit lifecycle.

On older systems the same menu opens Apple's ReplayKit broadcast picker. Its extension
scales ReplayKit video to at most 720x1280 or 1280x720, submits at most 30fps to a
H.264 Constrained Baseline encoder, and logs first encoded output and
available application audio metadata. Only one encode is in flight; sample data
is neither written to disk nor sent over a network. The legacy system picker
retains its visible microphone control; the probe discards microphone samples
and activates no audio session. iOS17.4's encoder-specification API requires hardware;
older systems select the platform encoder without that unavailable property.
Pause/finish retire the encoder; rotation creates an
encoder for the new dimensions. The system recording indicator stops the probe.
It is **not connected to a Piik room** and never advertises native sharing ready.

## Build on a Mac

Open `Piik.xcodeproj`, select scheme Piik, and choose an iPhone/iPad simulator or
device. The minimum deployment target is iOS16, matching the pixel-transfer API,
without an upper OS allowlist.
For a device choose your own development team and unique `PIIK_BUNDLE_IDENTIFIER`
in the project settings. The extension identifier follows the same value with
`.Broadcast`. No account, signing identity or provisioning profile is included.

From the repository root, an unsigned simulator compile is:

```sh
xcodebuild -project mobile/ios/Piik.xcodeproj -scheme Piik \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios-client/DerivedData CODE_SIGNING_ALLOWED=NO build
```

ReplayKit system broadcast and hardware encoding require physical acceptance;
simulator compilation is not that acceptance. This prototype was authored on
Windows without Xcode/Apple SDKs. Neither a successful Swift compile nor device
execution has been established. XML/project source checks only establish file
and configuration consistency.

The narrow URL-navigation check uses the actual Swift owner on a Mac:

```sh
mkdir -p build/ios-client
swiftc mobile/ios/Piik/SiteAddress.swift mobile/ios/checks/main.swift -o build/ios-client/check-site-address
build/ios-client/check-site-address
```

## Integration boundary

The Android candidate's Go runtime and capture queues must become one common
mobile bridge before iOS receives them; this tree does not copy that owner.
Canonical main does not yet contain the in-process CaptureProvider interface.
Local App rooms and native room sharing are therefore not offered by this slice.

For older systems, ReplayKit's broadcast upload extension is a separate process; the containing
App/WKWebView may be suspended when another app is foreground. Passing buffers
back to an App-owned Go process is not a complete background solution. A complete
broadcast needs an extension-owned media/runtime lifetime **and** an accepted
way to keep the existing room Host signaling available independently of the
suspended Web document. Merely moving Go does not solve the latter responsibility.
This remains a design hold; there is no audio-background-mode or keepalive trick.
For current iOS27, ScreenCaptureKit removes the extension requirement and gives
the actual capturing App a documented background mode. This makes an App-owned
common Go bridge viable, but does not by itself prove that WKWebView's separate
Web process will continue the existing Host signaling when another App is in
front. That boundary still needs actual acceptance before claiming background
new-Viewer admission or reconnection.

Extension memory is constrained by the platform. A historical 50MB observation
is not treated as a universal current API contract or an invented safe budget;
the complete Go/media composition needs measured peak-memory acceptance. No
per-frame filesystem IPC, shared raw-frame spool or permanent media log is added.

Apple's official release index lists iOS27 as released on 2026-09-14. Current
DocC metadata marks RPBroadcastSampleHandler deprecated at iOS/
iPadOS27 with “No longer supported”, not obsoleted. This does not prove its
runtime operation fails on that release, and this prototype does not block an
OS version. ScreenCaptureKit is the documented successor and is used on systems
where that API is available. A Mac with the current SDK must establish compiler
diagnostics and the actual start result for both adapters.

## Primary platform references

- [ReplayKit](https://developer.apple.com/documentation/replaykit)
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Apple iOS screen capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)
- [Official releases](https://developer.apple.com/news/releases/)
- [Broadcast sample handler](https://developer.apple.com/documentation/replaykit/rpbroadcastsamplehandler)
- [System broadcast picker](https://developer.apple.com/documentation/replaykit/rpsystembroadcastpickerview)
- [ReplayKit security](https://support.apple.com/guide/security/seca5fc039dd/web)
- [Extension process boundary](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionOverview.html)
- [Background execution](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)
- [VideoToolbox per-frame output handler](https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionencodeframe(_:imagebuffer:presentationtimestamp:duration:frameproperties:infoflagsout:outputhandler:))
