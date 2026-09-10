# Browser Platform Output

Last reviewed: 2026-08-31

This document owns evidence for showing a live Piik session on an AirPlay,
Cast, or Presentation API display. It does not add a product output surface.

## Current Decision

Do not add an application Cast or AirPlay button yet. Browser or operating-system
tab/screen mirroring is already usable without Piik integration. The Web
platform does not give the current `video.srcObject = MediaStream` a portable
remote-playback contract.

The only application design worth a physical prototype is a custom Cast
receiver acting as another authenticated Piik Viewer. It would receive its
own WebRTC route and count toward room and endpoint capacity; it would not reuse
or fling the controlling Browser's decoded video element.

## Three Different Capabilities

### System Or Tab Mirroring

Browser and operating-system UI can mirror a tab, window, screen, or media
element. The W3C Remote Playback model explicitly permits this implementation
shape but does not standardize its transport, latency, quality, lifecycle, or
device coverage. Piik needs no adapter for it and cannot claim its result.

### Media Remoting Or Flinging

Remote Playback selects a compatible source from an HTML media element's
availability source set. The specification never defines `MediaStream` or
`srcObject` as a remote playback source. Local Media Capture support for
rendering a `MediaStream` in an HTML media element does not create a cross-device
source.

The product implementations have the same boundary:

- WebKit documents that AirPlay needs a unique playback URL; even local MSE/MMS
  data needs a separate HTTP/HLS alternative.
- Google's default and styled Web Receivers load a media URL and document
  containers plus progressive HTTP, HLS, DASH, and SmoothStreaming. Their
  supported-media contract does not include a WebRTC `MediaStream`.

Creating an HLS, DASH, MSE, MediaRecorder, or WebCodecs bridge would introduce a
second media plane, buffering, packaging, server delivery, codec policy, and
cleanup. It is not a small output adapter for the current low-latency route.

### Receiver As A Viewer

The Presentation API can ask a receiving user agent to load a presentation URL
and provides two-way messaging between the controlling and receiving browsing
contexts. A Google Custom Web Receiver is likewise a registered, hosted HTML5
application with custom messaging.

That makes a narrow architecture possible: launch a receiver page, deliver a
short-lived room-scoped Viewer grant over the established control channel, and
let that page join through the normal Piik Viewer and routing contracts. The
grant must not appear in the presentation URL, logs, storage, or device metadata.

This is not accepted product behavior. Google's documented media matrix does
not promise WebRTC in a Custom Web Receiver, the Presentation API is not a
cross-Browser surface, and no target receiver has proved Piik's codec,
autoplay, audio, network, or lifecycle requirements.

## Physical Acceptance Gate

A prototype needs a named sender Browser and physical receiver. It must prove:

- receiver-page HTTPS/WSS, `RTCPeerConnection`, H.264/VP8 negotiation, decoded
  progress, screen audio, autoplay, and user-visible failure;
- end-to-end latency, cadence, resolution, recovery, pause/resume, and receiver
  teardown on Cast session end;
- exact room admission, one Viewer identity, one route, endpoint-cap accounting,
  and no credential in URLs or retained receiver state; and
- comparison with built-in tab/screen mirroring on the same sender and display.

Until that gate exists, feature detection alone cannot justify a control. A
native helper, custom encoded transport, or server restream is not authorized by
this research.

## Primary Sources

- [Remote Playback API](https://www.w3.org/TR/remote-playback/)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [Presentation API](https://www.w3.org/TR/presentation-api/)
- [Google Web Receiver overview](https://developers.google.com/cast/docs/web_receiver)
- [Google Custom Web Receiver](https://developers.google.com/cast/docs/web_receiver/basic)
- [Google Cast supported media](https://developers.google.com/cast/docs/media)
- [Google Cast registration](https://developers.google.com/cast/docs/registration)
- [WebKit MSE/MMS and AirPlay](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/)
- [Apple AirPlay overview](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/AirPlayGuide/Introduction/Introduction.html)
