# Native Client Media Evidence

- Reviewed: 2026-09-02
- Scope: Windows capture, one shared H.264 source, Pion transport, Browser decode
- Status: two-edge foundation passed; product and public-network gates remain

## Result

Screener Client can own one process-isolated Windows capture and hardware H.264
encoder, feed its Annex-B access units into one Pion source, and deliver that
source through independent WebRTC transports to unmodified Chrome receivers.
The Browser remains the room, route, and signaling authority.

The opt-in `gate:client-media` run proved, in order:

- WGC capture and adapter-bound Media Foundation H.264 became active;
- 30+ encoded 1280x720 frames crossed the bounded process protocol;
- a PLI caused a later recovery unit;
- the packaged Client exposed only separately probed video, process-audio, and
  hardware-H.264 capability booleans before control connected;
- two Pion ICE/DTLS/SRTP edges each delivered 30+ decoded 1280x720 frames
  to Chrome from that one encoded source;
- self-hosted and Cloudflare STUN produced ordinary `host` and `srflx`
  candidates; and
- Client, capture, Browser, ports, and the isolated profile all closed.

Unit coverage separately enforces the supplied edge capacity and forwards
PLI/FIR to the shared source. Neither gate proves heterogeneous congestion
behavior.

## Current Boundary

The result does not yet prove current Site route-generation integration, an
actual peer across NATs, native SFU publication, process audio delivery, live
quality-profile changes, native quality evidence, macOS/Linux capture, or
endurance. Native media therefore remains unavailable in the product UI.

No-Site Internet use still needs a lightweight rendezvous service. Public STUN
is a reasonable optional address-discovery dependency for users without a
server; its operator sees endpoint metadata but never carries DTLS-SRTP media.
STUN alone does not exchange peer descriptions and cannot replace SFU/TURN on a
restricted pair.

The next native-only NAT gate is an optional PCP/NAT-PMP/UPnP mapping for the
same Pion UDP port, following Tailscale/libp2p practice. It is not implemented
until a small dependency and a real router can prove create, advertise, renew,
and release. Pion v4.2.18 can mux host candidates; its STUN-on-the-same-socket
Universal UDP mux API is not yet in that stable release, so Screener does not
track an unreleased commit or recreate ICE internals.

## Implementation Boundary

- `nativecapture` owns the child process and bounded frame protocol.
- `mediaedge` owns the stable Pion API, one UDP mux, shared H.264 source, and
  independent PeerConnections.
- `nativehost` composes one capture generation with its bounded edges.
- `nativecontrol` maps only local share/edge commands to the loopback v2 wire.

The deleted `native/sender` application, UI, room client, and old wire are not
compatibility inputs. Historical measurements remain in
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
- [Cloudflare STUN](https://developers.cloudflare.com/realtime/turn/)
- [WebRTC signaling and ICE](https://webrtc.org/getting-started/peer-connections)
