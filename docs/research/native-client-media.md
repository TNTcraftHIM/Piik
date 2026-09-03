# Native Client Media Evidence

- Reviewed: 2026-09-03
- Scope: Windows capture, one shared H.264/Opus source, Pion transport, Browser
  decode
- Status: native Host, cross-NAT video, Windows process audio, capture-failure
  restart, and native P2P quality-evidence gates passed; SFU and other platform
  media remain outside the boundary

## Result

Screener Client can own one process-isolated Windows capture and hardware H.264
encoder, feed its Annex-B access units into one Pion source, and deliver that
source through independent WebRTC transports to unmodified Chrome receivers.
The Browser remains the room, route, and signaling authority.

The same Client can run the Local authority, open the normal Host page, and
attach that native source to the current route. A remote Pion Viewer then
received 30 packets over a selected `srflx`-to-`srflx` pair. The validation
session carried signaling through a temporary reverse SSH path only; media was
negotiated directly by ICE.

The one-link form carried the current signaling protocol through its temporary
public WSS origin to an independent Linux Pion Viewer. Repeated runs delivered
30+ packets over selected direct paths using a reflexive candidate; the Quick
Tunnel carried no media.

The opt-in `gate:client-media` run proved, in order:

- WGC capture and adapter-bound Media Foundation H.264 became active;
- 30+ encoded 1280x720 frames crossed the bounded process protocol;
- a PLI caused a later recovery unit;
- the packaged Client exposed only separately probed video, process-audio, and
  hardware-H.264 capability booleans before control connected;
- two Pion ICE/DTLS/SRTP edges each delivered 30+ decoded 1280x720 frames
  to Chrome from that one encoded source;
- the self-hosted STUN endpoint produced ordinary `host` and `srflx`
  candidates;
- process-loopback audio produced Opus RTP on both native edges (66 packets per
  edge in the bounded run);
- closing the captured source ended its share, released the old media path, and
  a second capture generation in the same room delivered a different media
  object plus 30 new frames to the existing Viewer;
- Client, capture, Browser, ports, and the isolated profile all closed.

Unit coverage separately enforces the supplied edge capacity, forwards PLI/FIR
to the shared video source, validates the same PeerConnection's Opus section,
and bounds the pure-Go Opus encoder's steady-state allocations. The native Host
session starts process-loopback audio only when the capture probe advertises it;
an audio start or read failure leaves the video session alive. The cross-NAT
result proves reachability and RTP delivery, not heterogeneous congestion
behavior or a paired no-Site Browser media session.

The audio adapter uses `github.com/thesyncim/gopus` behind the private
`nativeaudio` boundary. It accepts fixed 48 kHz stereo PCM16/20 ms frames,
encodes into a caller-owned Opus buffer, and can be replaced without changing
the media edge or control wire. The dependency is BSD-3-Clause licensed and
requires Go 1.25; Client CI uses Go 1.26.6.

## Current Boundary

The result does not yet prove native SFU publication, live quality-profile
changes, macOS/Linux capture, or endurance. Native Host media is exposed only
through the explicit Client `--native` launch; these other capabilities remain
unavailable there.

LiveKit Go SDK v2.18.1 speaks protocol 17 and accepts a Pion `TrackLocal`, so SDK
connectivity is not the native SFU blocker. The current native source has one
fixed H.264 representation; publishing it directly would discard the accepted
HIGH+LOW/Dynacast behavior. Native SFU and encoded relay therefore wait for one
shared representation decision rather than shipping a single-layer exception.
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
added about 0.38 MiB to the stripped Windows Client. Mapping begins
with the share, is awaited before the first PeerConnection, refreshes only when
a later edge arrives after half the requested lease, and is removed with the
engine. Failure is cached for that share and leaves ordinary ICE/STUN unchanged.
This proves lifecycle and non-regression, not that a mapped candidate has yet
rescued a pair that public STUN alone could not connect.

The retained hardware fixture also changed one live NVIDIA MFT through
`3 Mbps -> 1.5 Mbps -> 3 Mbps` without recreating it. Equal 120-frame phases
produced about `1.00 MB -> 0.68 MB -> 0.97 MB`, while ordered 30 fps output and
the pinned profile remained intact. Both AMD MFT candidates failed activation
before this probe, so the evidence is not a cross-vendor dynamic-rate contract.
The product therefore observes GCC for routing but does not yet apply one edge's
target globally to the shared encoder.

Non-Windows capture keeps the existing process/frame boundary and replaces only
the platform sidecar. On macOS, ScreenCaptureKit supplies system source
selection and `CMSampleBuffer` output, while VideoToolbox can require and report
hardware H.264. On Wayland Linux, the XDG ScreenCast Portal owns source consent
and returns PipeWire streams; portal version 6 clients identify streams by
`pipewire-serial` rather than a reusable node ID. These platform contracts rule
out a fake common window handle. macOS uses the system sharing picker and Linux
uses the portal picker, while both feed the same native Host media edge after
encoding.

## Implementation Boundary

- `nativecapture` owns the child process and bounded frame protocol.
- `mediaedge` owns the stable Pion API, one UDP mux, shared H.264/Opus sources,
  and independent PeerConnections.
- `nativehost` composes one capture generation with its bounded edges.
- `nativecontrol` maps only local share/edge commands and exact native sender
  quality windows to the loopback v3 wire.

The deleted sender application, UI, room client, and old wire are not
compatibility inputs. Historical measurements remain in the separately marked
[native sender evidence](./native-sender.md).

## Primary Sources

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [WGC `CreateForWindow`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)
- [WASAPI process loopback](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [Media Foundation hardware MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)
- [Pion v4.2.18 stats implementation](https://github.com/pion/webrtc/blob/v4.2.18/stats.go)
- [Pion Google congestion control](https://github.com/pion/interceptor/tree/v0.1.47/pkg/gcc)
- [Pion bandwidth-estimation example](https://github.com/pion/webrtc/tree/v4.2.18/examples/bandwidth-estimation-from-disk)
- [WebRTC Stats target bitrate and limitation semantics](https://www.w3.org/TR/webrtc-stats/)
- [Pion no-op pacer RTX issue](https://github.com/pion/interceptor/issues/406)
- [LiveKit Go SDK](https://github.com/livekit/server-sdk-go/tree/v2.18.1)
- [Pion single-port ICE](https://github.com/pion/webrtc/tree/master/examples/ice-single-port)
- [gopus pure-Go Opus codec](https://github.com/thesyncim/gopus)
- [Tailscale port mapper](https://github.com/tailscale/tailscale/tree/main/net/portmapper)
- [libp2p NAT port mapping](https://github.com/libp2p/go-libp2p/blob/master/options.go)
- [NetBird standalone Go NAT](https://github.com/netbirdio/go-nat)
- [WebRTC signaling and ICE](https://webrtc.org/getting-started/peer-connections)
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Apple VideoToolbox hardware encoder requirement](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder)
- [XDG ScreenCast Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
