# Native Client Media Evidence

- Reviewed: 2026-09-03
- Scope: Windows capture, one shared H.264/Opus source, Pion transport, Browser
  decode
- Status: native Host and cross-NAT video gates passed; native audio is wired and
  unit/build verified, while physical audio, SFU, quality evidence, and other
  platform media remain outside the boundary

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

The opt-in `gate:client-media` run proved, in order:

- WGC capture and adapter-bound Media Foundation H.264 became active;
- 30+ encoded 1280x720 frames crossed the bounded process protocol;
- a PLI caused a later recovery unit;
- the packaged Client exposed only separately probed video, process-audio, and
  hardware-H.264 capability booleans before control connected;
- two Pion ICE/DTLS/SRTP edges each delivered 30+ decoded 1280x720 frames
  to Chrome from that one encoded source;
- the self-hosted STUN endpoint produced ordinary `host` and `srflx`
  candidates; and
- Client, capture, Browser, ports, and the isolated profile all closed.

Unit coverage separately enforces the supplied edge capacity, forwards PLI/FIR
to the shared video source, validates the same PeerConnection's Opus section,
and bounds the pure-Go Opus encoder's steady-state allocations. The native Host
session starts process-loopback audio only when the capture probe advertises it;
an audio start or read failure leaves the video session alive. The cross-NAT
result proves reachability and RTP delivery, not heterogeneous congestion
behavior or a no-rendezvous Internet mode.

The audio adapter uses `github.com/thesyncim/gopus` behind the private
`nativeaudio` boundary. It accepts fixed 48 kHz stereo PCM16/20 ms frames,
encodes into a caller-owned Opus buffer, and can be replaced without changing
the media edge or control wire. The dependency is BSD-3-Clause licensed and
requires Go 1.25; Client CI uses Go 1.26.6.

## Current Boundary

The result does not yet prove physical process-audio delivery, native SFU
publication, live quality-profile changes, native quality evidence, macOS/Linux
capture, or endurance. Native Host media is exposed only through the explicit
Client `--native` launch; these other capabilities remain unavailable there.

No-Site Internet use still needs a lightweight rendezvous service. Public STUN
is an optional address-discovery dependency; its operator sees endpoint
metadata but never carries DTLS-SRTP media. STUN alone does not exchange peer
descriptions and cannot replace SFU/TURN on a restricted pair.

The next native-only NAT gate is an optional PCP/NAT-PMP/UPnP mapping for the
same Pion UDP port, following Tailscale/libp2p practice. It is not implemented
until a small dependency and a real router can prove create, advertise, renew,
and release. Pion v4.2.18 can mux host candidates; its STUN-on-the-same-socket
Universal UDP mux API is not yet in that stable release, so Screener does not
track an unreleased commit or recreate ICE internals.

## Implementation Boundary

- `nativecapture` owns the child process and bounded frame protocol.
- `mediaedge` owns the stable Pion API, one UDP mux, shared H.264/Opus sources,
  and independent PeerConnections.
- `nativehost` composes one capture generation with its bounded edges.
- `nativecontrol` maps only local share/edge commands to the loopback v2 wire.

The deleted sender application, UI, room client, and old wire are not
compatibility inputs. Historical measurements remain in the separately marked
[native sender evidence](./native-sender.md).

## Primary Sources

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [WGC `CreateForWindow`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)
- [WASAPI process loopback](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [Media Foundation hardware MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)
- [Pion WebRTC](https://github.com/pion/webrtc)
- [Pion single-port ICE](https://github.com/pion/webrtc/tree/master/examples/ice-single-port)
- [Tailscale port mapper](https://github.com/tailscale/tailscale/tree/main/net/portmapper)
- [libp2p NAT port mapping](https://github.com/libp2p/go-libp2p/blob/master/options.go)
- [WebRTC signaling and ICE](https://webrtc.org/getting-started/peer-connections)
