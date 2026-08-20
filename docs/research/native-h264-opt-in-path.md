# Native H.264 Opt-In Path

## 2026-08-21 00:15

The native sender now has a small, explicit H.264 mode. VP8 remains the default
and the Web sender is unchanged. A sender chooses H.264 in its local Codec
control; the choice is carried only through the loopback start/media handshake.

The H.264 path is:

```text
Chrome WebCodecs H.264 Annex-B
  -> existing 17-byte local frame envelope
  -> one Go queue and Pion H264Payloader
  -> one TrackLocalStaticRTP
  -> at most two independent PeerConnections
```

The Go session creates a private Pion `MediaEngine` only for H.264 sessions. It
registers the fixture-derived Constrained Baseline `profile-level-id=42c01f`,
`packetization-mode=1`, and a dedicated dynamic payload type, then restricts
the sender transceiver to that H.264 capability. The shared fanout and keyframe
feedback remain unchanged. The default VP8 session still uses Pion's default
API and payloader.

## Bounded Loopback Evidence

One short Chrome 151 one-viewer gate ran on 2026-08-20/21 with the in-memory
development server, no peer assistance, no TURN, and a synthetic animated
1280x720 source. The H.264 sender configuration was 720p30, 3 Mbps, one
encoder instance, Annex-B output, and `hardwareAcceleration: prefer-hardware`.

Retained evidence:

| Boundary | Result |
| --- | --- |
| Sender configuration / encoder | H.264 config accepted; one encoder; 18 frames written; 156 source RTP packets; 174,978 source RTP bytes; zero encoder/fatal errors |
| Signaling and ICE | Host authentication, room creation, offer/answer, trickle ICE, and both peer connections reached connected |
| Viewer media | 2,690 inbound packets, about 3.0 MiB, 299 decoded and 298 rendered frames, 1280x720 |
| Resource/lifecycle | One host edge; cleanup completed; no production endpoint or TURN allocation |

The generic gate reported failure only because its two-second Pion diagnostics
snapshot did not refresh during the final sample (`pionPacketDelta=0`), the same
probe-timing residual retained by the earlier VP8 run. All independent viewer
receive/decode/render and sender checks passed. This is one functional
loopback, not a public-network, multi-viewer, endurance, or codec benchmark.

## Hardware Boundary

The Media Foundation/NVIDIA fixture remains the physical hardware evidence and
informed the exact `42c01f` profile and in-band SPS/PPS/keyframe contract. The
product sender requests WebCodecs H.264 hardware acceleration, but browser
`isConfigSupported()` and the preference string do not prove which encoder was
selected. The UI therefore reports hardware preference separately from hardware
evidence, which remains unverified. Physical hardware attribution and direct
Media Foundation capture integration are later work; this change does not
silently claim either one.

## Scope

- No production deployment was made.
- No SFU, TURN, Web viewer, access protocol, or default VP8 behavior changed.
- No codec matrix, benchmark, second viewer, or endurance run is required for
  this landing slice.
- H.264 distribution still carries the existing patent/license review boundary.

---
