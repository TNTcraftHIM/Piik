# iPhone and iPad prototype

This slice provides a Swift/WKWebView shell for Piik's existing HTTPS Web UI and
a local native capture/VideoToolbox probe. Rooms, playback, camera and room voice
use the same Hosted application. Local App rooms and native room sharing are not
connected yet. There is no second frontend, room backend or route controller.

## Open a site

The App opens the public Demo on launch. Use the menu's **Open site** for another
HTTPS site or invitation; its path, query and fragment are retained. Opening a
site leaves the current page. Popups preserve their opener and can close normally.
Actual camera and voice requests use the standard WebKit/iOS permission prompts;
the wrapper rejects requests from cross-origin subframes.

## Run the local capture probe

Choose **Capture probe** and confirm Apple's system picker. The probe encodes
H.264 at up to 30fps and 720x1280/1280x720, logging output metadata without saving
or sending media to a room.

On systems with iOS27 ScreenCaptureKit, an App-owned SCStream uses the standard
`screen-capture` background mode. Camera, application audio and microphone output
are off. Stop through **Stop capture probe** or the system capture control.
Older systems use a ReplayKit broadcast extension. Its system microphone switch
remains visible; the probe discards microphone samples and activates no audio
session. Stop that probe using the system recording indicator.

## Build and check on a Mac

Open `Piik.xcodeproj`, select scheme **Piik**, then choose an iPhone/iPad simulator
or device. The deployment target is iOS16. For a device, select your development
team and a unique `PIIK_BUNDLE_IDENTIFIER`; the extension uses the same value plus
`.Broadcast`. Signing identities and provisioning profiles are not included.

From the repository root, compile for the simulator:

```sh
xcodebuild -project mobile/ios/Piik.xcodeproj -scheme Piik \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios-client/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Run the focused HTTPS/invitation navigation check:

```sh
mkdir -p build/ios-client
swiftc mobile/ios/Piik/SiteAddress.swift mobile/ios/checks/main.swift -o build/ios-client/check-site-address
build/ios-client/check-site-address
```

The source was authored on Windows. XML/project-reference and repository checks
have passed; Swift/Apple SDK compilation and device execution remain outstanding.
System screen capture and hardware encoding require a physical device.

## Integration boundary

The shared Go runtime/capture owner is [mobile/bridge](../bridge); its Objective-C
API has been generated with `gobind`. This Swift probe is not connected to that
bridge and does not advertise Native readiness. Wiring its actual encoded samples
and platform callbacks, then compiling against the Apple SDK, remains outstanding.
ReplayKit's extension has a separate process lifetime from its containing App.
ScreenCaptureKit keeps the capturing App active, but WKWebView has its own Web
process: background Host signaling, new-Viewer admission and reconnect still need
an established owner and runtime acceptance. These integration tasks stay in the
repository's [TODO](../../docs/todo.md#next).

## Platform references

- [ScreenCaptureKit and the iOS sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)
- [ReplayKit sample handler](https://developer.apple.com/documentation/replaykit/rpbroadcastsamplehandler)
- [Extension process boundary](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionOverview.html)
- [VideoToolbox output handler](https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionencodeframe(_:imagebuffer:presentationtimestamp:duration:frameproperties:infoflagsout:outputhandler:))
