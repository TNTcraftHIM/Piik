# Native App Media Evidence

- Reviewed: 2026-09-05
- Scope: platform capture, one shared H.264/Opus source, Pion transport, Browser
  decode, and Browser-mediated SFU fallback
- Status: Windows physical native Host and Viewer gates passed; macOS and Linux adapters
  compile and package but still require physical media gates

## Result

Piik App can own one process-isolated Windows capture and hardware H.264
encoder, feed its Annex-B access units into one Pion source, and deliver that
source through independent WebRTC transports to unmodified Chrome receivers.
The Browser remains the room, route, and signaling authority.

The same App can run the Local authority, open the normal Host page, and
attach that native source to the current route. A remote Pion Viewer then
received 30 packets over a selected `srflx`-to-`srflx` pair. The validation
session carried signaling through a temporary reverse SSH path only; media was
negotiated directly by ICE.

On 2026-09-05, a separate Windows Local gate used a Browser Host with synthetic
1280x720 motion and an App-activated Viewer. The Viewer exclusively claimed
the v8 loopback control session and real Chrome decoded 621 frames at 1280x720.
This proves the Browser-to-Native receive/local-bridge path rather than a silent
Browser fallback. A Pion integration gate separately forwards the same H.264
and Opus payload from one inbound receiver source to a bounded downstream edge,
while dropping upstream connection-local extensions so each outbound Pion
interceptor writes its own negotiated TWCC header.

The one-link form carried the current signaling protocol through its temporary
public WSS origin to an independent Linux Pion Viewer. Repeated runs delivered
30+ packets over selected direct paths using a reflexive candidate; the Quick
Tunnel carried no media.

An isolated LiveKit 1.13.6 gate carried the same native source through one
reserved local Pion edge into the existing Browser `SfuPublisher`; an ordinary
LiveKit Viewer received the default 1080p source, then 15 consecutive 854x480
frames after one live Native/SFU profile change. The direct native P2P path,
Browser, App, LiveKit process, ports, and profiles all cleaned up.

The opt-in `gate:client-media` run proved, in order:

- WGC capture and adapter-bound Media Foundation H.264 became active;
- 30+ encoded 1280x720 frames crossed the bounded process protocol;
- a PLI caused a later recovery unit;
- the packaged App exposed only separately probed video, process-audio,
  system-audio, and hardware-H.264 capability booleans before control connected;
- two Pion ICE/DTLS/SRTP edges each delivered 30+ decoded 1280x720 frames
  to Chrome from that one encoded source;
- the self-hosted STUN endpoint produced ordinary `host` and `srflx`
  candidates;
- process-loopback audio produced non-zero PCM, Opus RTP, and non-zero decoded
  audio energy on both native edges; the same checks pass for a display using
  system loopback;
- closing the captured source ended its share, released the old media path, and
  a second capture generation in the same room delivered a different media
  object plus 30 new frames to the existing Viewer;
- App, capture, Browser, ports, and the isolated profile all closed.

Unit coverage separately enforces the supplied edge capacity, forwards PLI/FIR
to the shared video source, validates the same PeerConnection's Opus section,
and bounds the pure-Go Opus encoder's steady-state allocations. The native Host
session starts the target-appropriate loopback audio only when the capture probe
advertises it; an audio start failure leaves the video session alive. The
cross-NAT result proves reachability and RTP delivery, not heterogeneous
congestion behavior or a paired no-Site Browser media session.

The audio adapter uses `github.com/thesyncim/gopus` behind the private
`nativeaudio` boundary. It accepts fixed 48 kHz stereo PCM16/20 ms frames,
encodes into a caller-owned Opus buffer, and can be replaced without changing
the media edge or control wire. The dependency is BSD-3-Clause licensed and
requires Go 1.25; App CI uses Go 1.26.6.

## Current Boundary

Windows now supports hardware H264 and software VP8 behind the same capture,
source and Pion transport boundary. libvpx 1.17.0 accepts the existing NV12 data
with row pitch preserved, without another color-conversion library. In a local
CPU-only 720p30 trial its mean encoding work was 6.112 ms per frame; this excludes
GPU readback and is not game-quality evidence. Separate real Browser gates
proved manual VP8 and Auto-selected H264, including live presets, pause/resume,
source replacement and exact RTP codec preservation. Auto uses a bounded
synthetic target-profile throughput check, not a score or a runtime codec switch.
GPU-heavy selection and cross-device startup remain open acceptance work.

The Windows Browser gate now also keeps two native PeerConnections alive while
the source changes from 720p30 to 1440p60, then changes to 480p15 while paused
and resumes both Viewers. It proves the same Pion source survives two hardware
capture/encoder generations; direct capture probes also produced every current
resolution/FPS extreme, and the same route survives an explicit native source
switch. The result does not yet prove macOS/Linux physical capture or endurance.
Native Host media is exposed only through an explicit App-launched Host
selection; an ordinary Web Host retains Browser capture.

Native code does not publish directly to LiveKit. One local Pion edge gives the
system Browser a remote `MediaStreamTrack`; WebRTC requires that remote track to
reject capture constraints, so native capture keeps source ownership while the
existing SFU publisher owns sender parameters, simulcast, Dynacast, and recovery.
The bridge adds one local decode for Host preview and a Browser encode only when
SFU publication is active. Direct P2P children continue to reuse the one native
H.264 encode. This preserves the accepted SFU behavior without another LiveKit
SDK or media policy.

A shared encode cannot independently adapt one bitstream for unequal paths.
Rather than lower every Native child, a quality operation originating from a
    persistently degraded Native sender edge may prepare one Browser WebRTC sender
from the stable local bridge. The existing overlapping candidate comparison
alone commits or rolls it back, and a later quality operation can return that
edge to Native. Healthy Native edges keep sharing the hardware encode. This is
implemented without a new route reason, timer, score, or representation ladder;
controlled weak-path physical acceptance remains open.

Native P2P edges negotiate transport-wide feedback and use Pion's send-side GCC
with its immediate no-op pacer. The pacer neither queues nor applies one edge's
estimate to the shared encoder. Once real feedback and source frames exist, the
edge compares GCC's target payload bitrate with the H.264 plus Opus payload
actually produced in the same window. A lower target is `degraded/bandwidth`, a
sufficient target is `healthy/none`, and absent feedback or source progress is
`unknown`. The existing two-second evidence cadence and three-window route rule
own persistence. This is a direct capacity relation, not a loss/RTT score or a
new adaptation ladder. The known Pion no-op-pacer issue concerns separately
negotiated RTX SSRCs; the current native H.264 contract has no RTX codec and must
reopen that choice before adding one.

No-Site Internet control can use the one-link mode owned by ADR-0010. Its remote
Pion gate proves public signaling plus direct media, but not decoded Browser
media on a physical second device. Cloudflare carries HTTPS/WebSocket control
and provides public STUN, while DTLS-SRTP media remains direct. STUN alone
cannot replace SFU/TURN on a restricted pair.

Native shares use the same Pion UDP socket for all edges. Site and one-link
shares make one bounded, best-effort PCP, UPnP, or NAT-PMP mapping through
NetBird's standalone Go NAT package; pure LAN Local mode does not. A physical
router created and removed an ephemeral UPnP mapping; the Apache-2.0 dependency
added about 0.38 MiB to the stripped Windows App. Mapping begins
with the share, is awaited before the first PeerConnection, refreshes only when
a later edge arrives after half the requested lease, and is removed with the
engine. Failure is cached for that share and leaves ordinary ICE/STUN unchanged.
The returned port is advertised once per observed public address as a
lower-priority candidate. Only the three explicit same-socket survey candidates
feed NAT prediction; the mapped candidate does not. This proves lifecycle and
signaling, not that the mapped candidate has yet rescued a pair that public STUN
alone could not connect.

The retained hardware fixture also changed one live NVIDIA MFT through
`3 Mbps -> 1.5 Mbps -> 3 Mbps` without recreating it. Equal 120-frame phases
produced about `1.00 MB -> 0.68 MB -> 0.97 MB`, while ordered 30 fps output and
the pinned profile remained intact. Both AMD MFT candidates failed activation
before this probe, so the evidence is not a cross-vendor dynamic-rate contract.
The product therefore observes GCC for routing but does not yet apply one edge's
target globally to the shared encoder.

The Windows source boundary now enumerates displays and windows and returns a
bounded best-effort preview. A display uses WGC plus default render-device
loopback audio; a window uses WGC plus process-tree loopback when that actual
capability probe succeeds. Preview failure is advisory and cannot tear down
the control session.

A controlled 144 fps window on Windows build 26200 exposed two capture-cadence
failures: WGC's zero `MinUpdateInterval` delivered 48 fps, and sampling from the
last emitted timestamp reduced 48 fps input to 24 fps for a 30 fps profile.
Using WGC's supported non-zero interval plus a phase-continuous output cadence
delivered 29.99 fps and 60.00 fps from the same source. Older Windows versions
without the optional session interface retain their existing WGC behavior.

A Browser-capture/Pion fanout gate exposed a separate RTP input defect:
payload-empty padding was rejected and ended the video or audio reader. Chrome
then fell to a 30 kbps video target even at zero media loss and about 1 ms RTT.
Discarding padding kept the reader alive but introduced downstream sequence
gaps, NACKs and reduced decoded cadence. Forwarding valid padding through Pion's
existing `WriteRTP`, while excluding it from media-frame counts, restored two
1080p Viewers to about 30 fps with zero packet loss. The same gate passed live
quality, pause/resume, audio-presence source changes and App-exit fallback.
Native payload-capacity evidence does not require decoded dimensions; encoded
receivers can supply real transport evidence without opening a decoder.

DevTools accepted weak-network emulation commands in this loopback run, but RTP
traffic exceeded the requested limit without the requested loss. That run does
not establish weak-network quality or automatic fallback performance.

Non-Windows capture keeps the existing process/frame boundary and replaces only
the platform sidecar. The macOS adapter enumerates `SCShareableContent`, fences
the selected process/window generation, receives change-driven
`CMSampleBuffer`s, and requires VideoToolbox constrained-baseline hardware H.264.
It retains one latest pixel buffer so an existing PLI/FIR can encode a fresh IDR
even while the screen is unchanged; capture timestamps drive the shared Pion RTP
clock. A GitHub `macos-15` arm64 runner compiled the sidecar, created the same
hardware-only encoder, and encoded an in-memory 420v frame into a validated
`42c01f` SPS/PPS/IDR. The current adapter also emits ScreenCaptureKit application
or display audio through the common PCM boundary. ScreenCaptureKit permissions,
real video/audio capture, static-frame recovery, and endurance still require a
physical Mac.

The Linux adapter lets the XDG ScreenCast Portal own source selection, consumes
its restricted PipeWire stream through one bounded GStreamer pipeline, and
requires an installed element classified as a hardware H.264 encoder. It emits
the same Annex-B protocol and can use the PulseAudio-compatible default monitor
for system audio; it does not claim per-process audio. GitHub Linux CI compiles,
probes, packages, starts, and stops the candidate. A real Portal desktop,
hardware encoder, audio source, Browser decode, and recovery still require a
physical Linux gate. GStreamer stays a system dependency: bundling another RTC
or an 80+ MB media runtime would defeat the thin-adapter boundary, while an
unavailable dependency cleanly leaves Browser capture available.

## Implementation Boundary

- `nativecapture` owns the child process, source identity, and bounded frame protocol.
- `mediaedge` owns the stable Pion API, one UDP mux, shared H.264/Opus sources,
  and independent PeerConnections.
- `nativehost` owns the current capture generation and its bounded stable edges.
- `nativeviewer` owns one native inbound H.264/Opus source and its encoded child
  edges; it does not own room or route state.
- `nativecontrol` maps local source/share/receive/edge commands and exact native
  sender quality windows, live profile updates, and source replacement to the
  loopback v8 wire.

The deleted sender application, UI, room client, and old wire are not
compatibility inputs. Historical measurements remain in the separately marked
[native sender evidence](./native-sender.md).

## Primary Sources

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [WGC `MinUpdateInterval`](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval)
- [Sunshine WGC update interval](https://github.com/LizardByte/Sunshine/blob/master/src/platform/windows/display_wgc.cpp)
- [WGC `CreateForWindow`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)
- [WASAPI process loopback](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [OBS application-audio capture guide](https://obsproject.com/kb/application-audio-capture-guide/)
- [Media Foundation hardware MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)
- [Pion v4.2.18 stats implementation](https://github.com/pion/webrtc/blob/v4.2.18/stats.go)
- [Pion Google congestion control](https://github.com/pion/interceptor/tree/v0.1.47/pkg/gcc)
- [Pion bandwidth-estimation example](https://github.com/pion/webrtc/tree/v4.2.18/examples/bandwidth-estimation-from-disk)
- [WebRTC Stats target bitrate and limitation semantics](https://www.w3.org/TR/webrtc-stats/)
- [Pion no-op pacer RTX issue](https://github.com/pion/interceptor/issues/406)
- [WebRTC remote-track constraints](https://www.w3.org/TR/webrtc/#mediastreamtrack-network-use)
- [Pion single-port ICE](https://github.com/pion/webrtc/tree/master/examples/ice-single-port)
- [Pion broadcast relay](https://github.com/pion/webrtc/tree/master/examples/broadcast)
- [gopus pure-Go Opus codec](https://github.com/thesyncim/gopus)
- [Tailscale port mapper](https://github.com/tailscale/tailscale/tree/main/net/portmapper)
- [libp2p NAT port mapping](https://github.com/libp2p/go-libp2p/blob/master/options.go)
- [NetBird standalone Go NAT](https://github.com/netbirdio/go-nat)
- [WebRTC signaling and ICE](https://webrtc.org/getting-started/peer-connections)
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [ScreenCaptureKit audio output](https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype/audio)
- [ScreenCaptureKit idle frames](https://developer.apple.com/documentation/screencapturekit/scframestatus/idle)
- [Apple VideoToolbox hardware encoder requirement](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder)
- [XDG ScreenCast Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [libportal](https://libportal.org/libportal.html)
- [PipeWire DMA-BUF contract](https://docs.pipewire.org/devel/page_dma_buf.html)
- [GStreamer PipeWire source](https://gstreamer.freedesktop.org/documentation/pipewire/pipewiresrc.html)
