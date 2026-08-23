# Built-In Peer ICE TURN Candidate

- Research date: 2026-08-20; quota boundary rechecked 2026-08-21
- Scope: authenticated TURN on every ordinary peer `RTCPeerConnection` in an
  exact-room canary
- Status: rejected after bounded production canary; historical evidence only

The remainder records the tested candidate and exact release behavior. Current
transport design is owned by [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md).

## Decision

Do not deploy or continue the built-in participant-wide candidate. Ordinary
peer connections remain STUN-only. Exact release `9461e20` used its dated
SFU-then-selected-TURN recovery slice; current route authority is ADR-0005.

TURN remains a compatibility transport, not a topology. The controller may
authorize it only for an exact logical edge transport or the single Host-SFU
publication path. No room, participant, or ordinary peer connection receives
TURN candidates by default.

This supersedes this document's former recommendation to place STUN plus TURN on
every capable exact-room Web peer connection. Git history retains that analysis;
the durable findings that still apply are summarized below.

The current source no longer contains the rejected participant-wide config,
issuer, authentication capability, refresh wire, or client propagation. Supplying any
stale `PEER_ICE_TURN_*` key, even blank, fails startup. The replacement
selected-edge config, wire, and rebuild now exist and are configured in
production. They remain controller-selected. An isolated Host-SFU ingress canary
proved selected TURN/UDP media; ordinary peer-selected media, deployment
capacity, expiry, heterogeneous networks, and production-route behavior remain
open.

## Production Canary

The first exact-room canary used source `a11a73dfa79d`, immutable release
`a11a73dfa79d-r4`, and artifact SHA-256
`C954185869A3A15CCCE642AB72A4CF90770476C117D61182D7728280C30A036F`.
The candidate switch completed at 2026-08-20 14:59:33 +08. A local coturn REST
allocation passed without retaining or printing its credential, and the
application health, artifact, route, admission, SQLite, service, and local TURN
configuration gates passed.

The real direct Host plus Pion Viewer acceptance path did not establish its peer
connection. The stop line prevented the forced-relay test, so the run proved
neither direct-with-TURN behavior nor relayed media. It was fully rolled back.

Application issuance was disabled before coturn and its firewall rules returned
to the recorded pre-canary authenticated-relay baseline: TCP/UDP 3478 plus UDP
49152-49251. Exact production `7fea60ef6f2ad14a9ac1c23a89a523d91bbb97e4`
was restored and advertised no TURN credential. At the final lock-free check at
2026-08-20 15:12:40 +08, services were active, health/configuration/firewall/
SQLite matched baseline, and coturn reported zero allocations. The inactive
candidate release and `/opt/screener/backups/turn-a11-20260820T065933Z` remain
deployment evidence. Production later advanced independently to `31bee238`.

No candidate, credential, address, or raw signaling value is retained here.

## Why Built-In Issuance Was Rejected

RFC 8445 gives relay candidates a lower recommended type preference than host,
peer-reflexive, and server-reflexive candidates, so a healthy direct path is
normally preferred. That does not make participant-wide TURN free:

- gathering a relay candidate sends a TURN Allocate request and consumes an
  allocation, relay port, memory, quota, and refresh traffic even when direct is
  selected;
- coturn REST credentials authenticate an expiry-tagged bearer, not the room,
  peer edge, route revision, parent, or connection generation;
- one participant credential can be reused by its holder until expiry;
- `setConfiguration()` affects future gathering and does not itself move an
  existing connection, so refresh/recovery still needs lifecycle ownership; and
- placing TURN on every initial peer PC bypasses exact edge selection and spends
  relay resources before the controller has observed a failed direct transport.

The candidate was smaller in code because it delegated selection to standard
ICE, but it widened credential scope and idle server cost. Its failed direct
acceptance supplied no compensating runtime evidence.

## Selected-Edge Boundary

The deployed selected-edge replacement was designed as one coherent
controller-owned change with a current consumer. ADR-0005 now owns path
selection and resource accounting; the transport boundary retained here is:

- a complete default-off deployment tuple with an independent secret, one
  explicit TURN/UDP URI, bounded TTL, quota, bandwidth, and relay-port limits;
- issuance only after the exact logical edge's direct/STUN transport fails and
  the controller selects TURN; SFU subscription is a separate ingress choice;
- one in-memory negotiating attempt bound to room/share generation, viewer and parent
  sessions, route revision, the replaced connection, and a server-generated new
  connection identity;
- one-use grants are bound to the logical edge, both endpoint sessions, route
  revision, and connection generations; independent edges may have independent
  grants under deployment-wide TURN admission. The exact release used one
  `peer-selected` lease per room (excluding Host ingress), but that release
  quota is historical rather than a current topology rule; negotiation remains
  serialized only when route write sets conflict, while an answered exact lease
  is active transport and may coexist with an unrelated migration under route
  carry revalidation;
- coordinated parent and child rebuild for exactly that edge, using relay-only
  ICE only on the new connection;
- revalidation at grant, rebuild, ready, failure, timeout, route change,
  disconnect, and room stop/delete boundaries;
- one-use consumption and explicit terminal failure, with no refresh timer,
  participant-wide credential, SQLite row, URL, log, browser persistence, raw
  candidate, or second router; and
- Native and every ordinary Web peer connection remaining STUN-only.

Coturn still cannot enforce the application edge identity. The application
guards provide selected-edge authorization; short expiry and coturn quotas bound
bearer reuse and resource cost. Coturn's current `user-quota` and `total-quota`
bound allocations by credential user and server/realm, not by Screener room, so
they do not replace this application admission guard. Do not claim cryptographic
edge binding.

The source candidate uses the complete `SELECTED_EDGE_TURN_*` tuple only with
exact-room peer assistance and SFU configuration. `HostPeer`, relay parents, the
Viewer child, and `HybridMediaRouter` share one generation contract; a config-only
or issuer-only partial deployment remains forbidden.

## Retained Acceptance Boundary

Current acceptance must independently prove:

1. ordinary direct/peer PCs contain no TURN candidates;
2. one exact authorized parent/child edge can rebuild, select relay, and reach a
   decoded/rendered frame after its direct transport fails;
3. Host-SFU publication ingress can independently select TURN when authorized,
   without granting TURN to unrelated peer edges;
4. stale/replayed/wrong-session/wrong-revision/wrong-connection grants fail;
5. success stops further escalation, while expiry, coturn failure, disconnect,
   and all-UDP-blocked cases terminate within the bounded window;
6. one and two selected relay edges stay within measured allocation, port, RSS,
   CPU, RX/TX, loss, latency, and 1-GiB host limits; and
7. Android Chrome and iOS Safari complete the representative home, hotspot, and
   carrier matrix before broader rollout.

The media ladder remains UDP-only. HTTPS/WSS remains TLS/TCP and does not
satisfy these media gates.

## Sources

Primary sources accessed 2026-08-20:

- [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html)
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)
- [WebRTC configuration and ICE restart](https://www.w3.org/TR/webrtc/)
- [Coturn turnserver documentation](https://github.com/coturn/coturn/blob/master/README.turnserver)
- [Coturn TURN REST API implementation](https://github.com/coturn/coturn/wiki/turnserver)
- [TURN REST API draft](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00)

No source code was copied.
