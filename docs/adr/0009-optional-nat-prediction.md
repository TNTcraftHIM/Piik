# ADR-0009: Optional Connection-Local NAT Prediction

- Status: accepted as an optional Site and App capability
- Date: 2026-09-02

## Context

The self-hosted deployment has two auxiliary STUN-only listeners for controlled
NAT measurements, while a self-contained App needs public discovery without
depending on that deployment. A disposable namespace lab showed that a sequential,
endpoint-dependent mapping can sometimes be reached when the remote peer
receives a small set of adjacent server-reflexive candidates. The result is
network- and generation-specific; it is not a reliable NAT type or participant
capability.

The existing ICE configuration, route policy, and candidate owners are
sufficient. Prediction needs no NAT classification or new media path; bounded
connection acquisition reuses the route controller's existing opportunity ledger.

## Decision

1. `NAT_PREDICTION_ENABLED` defaults to `false`. A disabled deployment does not
   expose the Host control and the server rejects NAT prediction in the room
   policy. An enabled deployment exposes `NAT traversal`; the pre-share switch
   defaults on, remains Host-controllable, locks while sharing, and is not
   persisted beyond that share generation.
2. An enabled Site derives ports 3479 and 3480 from its first ordinary STUN
   authority on UDP 3478. Public-link App mode instead supplies one ordinary
   public STUN destination and two fixed public survey destinations; pure LAN
   mode supplies none. The same share switch and ICE configuration cover every
   Browser or Native P2P edge. SFU PeerConnections remain unchanged.
3. For one ICE gathering generation, the adapter observes only UDP `srflx`
   candidates belonging to the exact three-destination survey set. Browser
   candidates are matched by their reported STUN URL. Native Pion uses its
   `UniversalUDPMux` to perform the survey on the media socket and emits standard
   srflx-shaped observations marked with an `ns` foundation. Only those explicit
   survey observations feed prediction; port-mapped candidates remain ordinary
   ICE inputs. If three or more distinct survey candidates for
   one media section and public address form an arithmetic port sequence, the
   adapter appends at most eight bounded candidates outward from both sequence
   endpoints: four above the high endpoint and four below the low endpoint.
   Every host and observed srflx candidate keeps normal Trickle ICE timing; no ordinary
   candidate is delayed, rejected, or replaced. A Browser that does not expose
   candidate source URLs keeps ordinary ICE without prediction. Rejection of a
   predicted remote candidate discards only that optional candidate; ordinary
   candidate errors retain their normal connection error semantics.
4. Candidate observations remain in memory for that connection only. They do
   not create persistent NAT labels, endpoint addresses, routing scores, hard
   candidate skips, or periodic probes. Sanitized diagnostics record only
   whether a signaled candidate was ordinary, predicted, or end-of-candidates,
   and whether the selected remote foundation was ordinary, predicted, or
   unknown.
5. The same per-share gate also enables the three-attempt Peer acquisition
   budget in [ADR-0005](0005-automatic-hybrid-media-routing.md). Browser and
   Native candidates use the ordinary server-owned prepare/rollback lifecycle;
   no Viewer-owned ICE-restart loop is added. Local public-link and Hosted
   peer-only rooms can exhaust that budget without SFU, while mixed rooms use
   the remaining attempts behind a working SFU route. A new connection can
   provide another mapping opportunity, not guaranteed independent randomness:
   in particular, Native connections may retain the same shared UDP socket.
   A committed Browser P2P edge uses its existing two-request automatic-recovery
   budget: first ICE restart on the same connection, then connection rebuild.
   Recovery does not choose a new parent or add a route candidate; unsuccessful
   recovery follows the normal route-failed path. A prepared candidate remains owned by the route
   operation and is reported failed to that operation instead of starting a
   separate ICE-restart loop.

## Consequences

Positive:

- Sites with their own listeners and self-contained public-link Apps can use
  the same bounded mechanism while pure Browser/LAN operation stays unchanged;
- normal ICE remains immediately available, so an unavailable auxiliary STUN
  listener or unsuccessful prediction cannot delay direct or SFU fallback;
- prediction is bounded to one connection generation and one small candidate
  set; and
- selected-foundation attribution can validate actual field benefit without
  uploading candidate endpoints.

Negative:

- the Browser may still reject synthetic candidates or the NAT may not have a
  matching mapping;
- enabled P2P connections perform two extra STUN transactions and
  may add connectivity checks for up to eight adjacent UDP ports;
- two endpoint-dependent NATs remain sensitive to candidate scheduling and
  intervening mappings, so room-wide coverage is not a success guarantee; and
- enabled acquisition can occupy up to three ordinary operation windows when
  one parent remains, yielding between operations to other waiting Viewers.

Predicted connectivity checks originate from participant ICE agents and target
the other participant's bounded candidate window. A Site server only receives
Binding requests on its fixed listeners; it does not scan external ports.
Public survey operators receive STUN metadata but never the media stream.

The controlled lab result (14/15 sequential-to-restricted runs with a bounded
prediction set) is mechanism evidence, not a production success guarantee.
Target-network prevalence, candidate direction, and long-run resource impact
remain acceptance work.

A Windows Native Host preflight first exposed three different temporary local
ports under Pion's ordinary srflx gatherer. Replacing that boundary with Pion's
`UniversalUDPMux` produced an srflx observation whose related port exactly
matched the one media listener. A subsequent public-link run delivered 35 H.264
RTP packets to an independent Linux Pion Viewer over a selected direct
host-to-srflx pair. This proves the shared-socket candidate carries DTLS-SRTP;
the tested TUN network exposed only one distinct public mapping, so it does not
prove a predicted candidate win.
Survey inputs, platform limits and the measured boundaries live in
[NAT traversal research](../research/nat-traversal.md).
The current Native path maps selected Pion candidate foundations to the same
anonymous `ordinary | predicted | unknown` evidence as Browser ICE.

## Primary Sources

- [RFC 8445: Interactive Connectivity Establishment](https://www.rfc-editor.org/rfc/rfc8445)
- [RFC 4787: UDP NAT behavioral requirements](https://www.rfc-editor.org/rfc/rfc4787)
- [RFC 5780: NAT Behavior Discovery Using STUN](https://www.rfc-editor.org/rfc/rfc5780)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
- [Pion Universal UDP mux](https://github.com/pion/ice/blob/main/udp_mux_universal.go)
