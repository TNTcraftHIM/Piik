# ADR-0006: Fixed-HIGH Native Sender Canary

- Status: Proposed - Product Gate No-Go
- Date: 2026-08-19

## Context

The Draft #16/#18/#22/#23/#25/#28 ladder proved isolated WebCodecs/Pion
properties, not integration with Screener's current rooms, signaling, ordinary
browser viewers, or per-edge ICE/TURN. A native sender remains a later
optimization and must not be presented as available product behavior.

## Retained Boundary

Any renewed product-wiring canary stays deliberately narrow:

- one fixed VP8 `HIGH` representation at 1280x720, 30 fps, and a 3 Mbps ceiling;
- one WebCodecs encoder object feeding at most two independent Pion WebRTC legs;
- the current strict ordinary-P2P signaling wire and unmodified browser viewers;
- independent STUN-backed ICE, RTP/RTCP, congestion, and lifecycle state per leg;
- read-only feedback, with PLI/FIR limited to requesting a shared keyframe; and
- bounded local queues, fail-closed critical errors, and sanitized local-only
  diagnostics.

This canary excludes room-wide minimum feedback, automatic quality control,
`LOW`, viewer C reporting, peer-assisted/SFU routing, audio, packaging, and any
claim of one physical or hardware encoder. A third viewer must never create a
third host edge. The missing audio path remains a product-acceptance gap.

## 2026-08-19 Gate Result

The sole authorized run is `no-go-unclassified`; the retained evidence and
probe limitations are recorded in the native sender research. The earliest
missing checkpoint is viewer authentication, not a proven authentication
failure. No viewer-1 acceptance means there is no two-viewer, third-viewer
FIFO, or direct/TURN proof. The attempted native branch must not be opened or
merged as product code from this state.

## 2026-08-20 Current-Wire Checkpoint

A clean local delivery candidate now targets only `screener-v2`: it exchanges
`HOST_ADMISSION_PASSWORD` for the bounded HttpOnly Host-admission cookie, uses
that cookie to create an explicit `private-link` room, carries it on the Host
WebSocket upgrade, and strictly decodes the current ordinary authenticated and
read-only Viewer-evidence shapes. There is no v1 parser, translator, raw-grant
persistence, or Bearer room-creation shortcut. Its fixed 300-second provisional
request always creates a random transient room in memory, even when SQLite is
configured. A connected current Host suppresses that reclaim deadline; only its
generation-matched disconnect resets the five-minute window, while the ordinary
transient `ROOM_TTL_SECONDS` cap always remains. A pre-auth connection or
authentication failure gets one retry with the same room/token/client generation
and never another room POST. Server restart drops the room; SQLite stays at v2
and ordinary Web rooms are unchanged. No claim-confirm message, durable native token, or recovery
subsystem is added. Focused Go/TypeScript tests and static checks pass. The unused
generic probe framework is deliberately not retained.
No runtime/browser revalidation has run, so the product gate remains no-go and
this local branch is not a product availability claim.

## Staged Revalidation

A new run requires separate authorization and must stop at the first failed
stage while retaining a bounded final-negative snapshot:

1. Prove host room/auth, local config acknowledgement, one encoder object,
   bridge ingress, frame decode, source RTP, and zero critical errors.
2. Prove viewer auth, `peer-joined`, exact offer/answer/candidate exchange, and
   both PeerConnection state timelines.
3. Prove one viewer's inbound packets, `framesDecoded`, video readiness/current
   time/dimensions, and rendered frames.
4. Add viewer 2 and prove two independent legs while encoder instances stay one
   and host media edges stay at most two.
5. Add viewer 3, prove no third edge and a host-side waiting observation while
   the viewer keeps its existing waiting state, then close viewer 1 and prove
   FIFO promotion plus decoding/rendering.
6. Keep this candidate STUN-only. If a selected-edge TURN contract is later
   accepted, prove it in a separate bounded gate rather than widening ordinary
   native ICE or blocking the direct-path canary.

Only after these stages pass may separate performance, quality, loss,
reconnect, browser, audio/A-V-sync, packaging, and license gates begin. Do not
expand the feature to make the diagnostic gate pass.

## Consequences

ADR-0006 records a bounded candidate and its failed first product gate, not an
accepted architecture or shipped sender. The deployed Web sender and ordinary
viewer remain unchanged. ADR-0007 continues to own path-isolated
`HIGH + at most one LOW`; this canary cannot advance or replace it.

## References

- `docs/research/native-shared-encode-sender.md`
- `docs/adr/0007-demand-driven-dual-representation-quality.md`
- `docs/research/browser-screen-audio-quality.md`
