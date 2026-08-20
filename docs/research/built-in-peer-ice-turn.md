# Built-In Peer ICE TURN Candidate

- Research date: 2026-08-20
- Scope: optional authenticated TURN on ordinary peer `RTCPeerConnection`
  values in one exact-room canary
- Status: default-off source candidate implemented; no coturn rollout or deployment

## Result

The smallest standard-WebRTC fallback is to give each participant a short-lived
STUN-plus-TURN `RTCConfiguration` when it authenticates. Each peer connection
then gathers host, server-reflexive, and relayed candidates with
`iceTransportPolicy: "all"`. ICE prefers a working direct candidate pair and
can select the relay pair without an application-owned transport transition.
Only after that peer connection fails does Screener need its existing bounded
recovery ladder: one ICE restart, one same-parent rebuild, one alternate peer,
then the SFU virtual parent.

This is substantially smaller than an application-selected edge grant. The
owning requirements and ADR now accept it only behind the existing exact-room
allowlist and a complete default-off deployment tuple. It does not add another
router state machine or broaden TURN to non-allowlisted rooms.

## Current-Code Boundary

At `f806689896db9719509b0e0695d741daa6ecb364`:

- `authenticated.iceConfig` is STUN-only. Its schema accepts neither TURN URLs
  nor usernames, credentials, or expiry.
- `HostPeer`, `ViewerPeer`, and `ViewerRelay` already support
  `RTCPeerConnection.setConfiguration()` through `updateIceConfig()`.
- Host and Viewer authentication handlers already replace the retained ICE
  config and update every live peer after signaling reconnect.
- `ViewerPeer` owns the 15-second initial checking deadline, one ICE restart,
  and one same-parent rebuild. `HybridMediaRouter` then owns alternate-parent
  selection and SFU preparation.
- `TURN_URLS`, `TURN_SHARED_SECRET`, and
  `TURN_CREDENTIAL_TTL_SECONDS` are rejected removed configuration. They must
  not be reused for a new contract.
- The tracked coturn service is `stun-only`, UDP-only, and has no auth secret,
  allocation quota, or relay port range.

The built-in candidate therefore needs no new router state, route revision,
assignment, parent/viewer synchronization, or connection-ID protocol.

## Standards Behavior

RFC 8445 defines candidate gathering from configured STUN and TURN servers. A
TURN Allocate request creates a relayed candidate and consumes a relay address
even when that candidate is never selected. Its recommended type preferences
are host `126`, peer-reflexive `110`, server-reflexive `100`, and relay `0`, so
the ordinary checklist prefers direct candidates over a relay candidate.
Actual browser nomination and timing still require a canary measurement.

The WebRTC specification says that replacing `iceServers` with
`setConfiguration()` takes effect at the next gathering phase; an application
that needs it immediately performs an ICE restart. Consequently, a credential
refresh should update healthy peer connections without restarting them. Their
next existing recovery attempt will gather with the fresh credentials.

Coturn implements the TURN REST credential convention:

```text
username = <expiry-unix-seconds>:<opaque-participant-tag>
credential = base64(HMAC-SHA1(shared-secret, username))
```

The browser receives only the temporary username and credential. The shared
secret remains in the application and coturn service configuration. Credential
expiry prevents a new allocation with that credential; it is not immediate
revocation of an allocation that already exists. Allocation quotas and
application admission remain necessary cost boundaries.

## Minimal Config And Wire

Use new names that describe the actual all-peer-ICE behavior and cannot be
confused with the deleted all-room contract:

```dotenv
PEER_ICE_TURN_URLS=turn:turn.example.com:3478?transport=udp
PEER_ICE_TURN_SHARED_SECRET=<independent untracked secret>
PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS=600
```

The tuple is optional and default-off, but partial configuration fails startup.
The shared secret is at least 32 independent bytes and must differ from Host
admission and LiveKit credentials. The first canary accepts exactly one explicit
TURN UDP URI without embedded username, password, fragment, or unrelated query
parameters. It issues TURN credentials only for explicitly allowlisted
peer-assisted rooms; every other room retains STUN-only ICE.

The initial authenticated message remains the primary config response:

```ts
type PeerIceConfig = {
  iceServers: Array<
    | { urls: string | string[] }
    | {
        urls: string | string[];
        username: string;
        credential: string;
      }
  >;
  turnCredentialsExpiresAt?: string;
};
```

Add exactly one refresh request and response:

```ts
type RefreshIce = { type: "refresh-ice" };
type IceConfigUpdated = { type: "ice-config"; iceConfig: PeerIceConfig };
```

`refresh-ice` has no room, participant, edge, or expiry supplied by the client.
The current authenticated WebSocket session is the sole authority. The server
rejects it unless that session opted into the capability and belongs to an
exact allowlisted room with the tuple enabled. Its initial authenticated
snapshot remains STUN-only otherwise.

The participant session, not the media router, owns issuance of the bearer.
`SocketState` retains only its latest in-memory config, expiry, and refresh
window. The opaque username tag is derived from current room, peer, role, and
session identity with domain-separated HMAC; none of those values appears in
the username. No credential, username, or tag enters a URL, log, SQLite, room
row, or browser persistence.

`SignalingClient` is the one refresh-timer owner. It requests a refresh two
minutes before a ten-minute expiry, cancels that timer on disconnect, and gets
a fresh config through normal reauthentication after reconnect. Early or
duplicate requests in the same issuance window reuse the current grant rather
than minting unbounded credentials; the server also enforces a five-second
per-session request interval. A 30-second client timer floor prevents clock
skew from creating an immediate response loop. Pages handle `ice-config`
through the same retained config and `updateIceConfig()` path already used by
`authenticated`.

Ten minutes with a two-minute lead is a canary value, not a security optimum.
The accepted parser should keep a narrow five-to-thirty-minute range and the
deployment must keep application and coturn clocks synchronized.

## Scope Limit

TURN REST authentication does not cryptographically bind a credential to a
remote peer, route revision, or one `RTCPeerConnection`. Coturn validates the
expiry, HMAC, realm, and quotas. The simplest honest scope is therefore one
opaque credential per authenticated participant session, reused by that
participant's bounded peer connections.

Per-edge cryptographic or application binding requires separate grant/rebuild
state and cannot be claimed by this built-in design. A client that receives the
bearer can reuse it until expiry; coturn cannot tell which room, edge, or peer
connection caused an allocation. App-side issuance is still bounded by short
expiry, exact-room authorization, the current WebSocket session, endpoint
fanout, and coturn quotas.

## Resource Bound

An `N`-viewer peer tree has `N` peer connections. If both endpoints gather one
TURN allocation for one BUNDLE/RTCP-mux component and one TURN URI, the ideal
upper bound is about `2N`, or 16 allocations for eight viewers. Multiple local
interfaces, address families, TURN URIs, or browser gathering choices can make
the real count higher. This must be measured rather than encoded as a promise.

An unselected allocation still consumes a relay port, coturn memory, quota, and
small Allocate/Refresh/connectivity-check traffic. It does not carry continuous
media. If one `B`-bit/s media edge selects TURN, the server sees roughly `B`
ingress plus `B` egress, before headers and retransmission. At the current
8-Mbit/s recommendation that is about 16 Mbit/s of useful-payload NIC traffic;
at the 12-Mbit/s ceiling it is about 24 Mbit/s.

For the first exact-room test, one TURN UDP URI, a 64-port relay range, and
reviewed starting quotas such as four allocations per username and 32 total
allocations give a bounded failure instead of an allocation storm. These are
test starting points, not production capacity claims. Measure coturn RSS, CPU,
allocation count, occupied relay ports, RX/TX bytes, packets per second, and
connection latency on the actual 1-GiB host before accepting them. Coturn does
not encode media, but that fact alone does not prove its memory or network
budget.

## Coturn Deployment And Rollback

The existing coturn process could be the first canary owner instead of adding a
second daemon. Remove `stun-only`, retain UDP listener 3478, and enable
`use-auth-secret`, an explicit realm, the untracked static auth secret, a small
relay range, and allocation/bandwidth quotas. Keep `no-tcp` and `no-tls` for the
first UDP-only measurement. Verify that unauthenticated STUN Binding still
works and that an authenticated temporary allocation succeeds before the
application issues any credentials.

This source slice deliberately does not change or deploy coturn. A later
deployment acceptance boundary follows this order:

1. Open only the reviewed UDP relay range and deploy authenticated coturn.
2. Verify STUN and a temporary TURN allocation without printing credentials.
3. Deploy the application tuple and exact-room issuance.

Rollback reverses the ownership:

1. Disable application issuance first.
2. Restore coturn `stun-only` and close the relay range.

Existing relay allocations are intentionally interrupted by this rollback.
Healthy direct connections remain independent. TURN/UDP can work around NATs
that cannot form a peer pair while still reaching the server over UDP; it does
not help a network that blocks all UDP. TURN/TCP or TURN/TLS, especially on
TCP 443, needs its own port, certificate, shared-IP, and mobile-network gate.

## Failure Surface Comparison

| Boundary | Built-in participant ICE | Application-selected edge |
| --- | --- | --- |
| Core owner | signaling session and client refresh timer | router plus both edge endpoints |
| Route state | unchanged | attempt generation and old/new connection binding |
| New runtime wire | refresh request and config response | grant, parent rebuild, readiness/failure |
| Direct preference | standard ICE priority | application first exhausts a STUN-only PC |
| Idle server cost | allocations for configured peer connections | none until selection |
| Credential scope | participant session | application edge attempt |
| Main failure risks | allocation count, refresh/clock skew, unreachable TURN delaying ICE | stale grants, split endpoint state, rebuild timeout, revision races |
| Estimated core TypeScript | about 250-400 lines | about 600-1,000 lines |

The estimates are review-planning ranges, not delivery commitments. Tests and
documentation are additional.

## Validation Layers

P0/P1 automated gates:

- default-off and strict complete-tuple parsing;
- TURN URI and TTL bounds plus secret independence;
- exact-room/session-only issuance and refresh rate limiting;
- deterministic expiry/HMAC vectors without snapshotting real credentials;
- no credential in URLs, logs, persistence, errors, or non-allowlisted rooms;
- authenticated refresh updates Host, Viewer, and relay peer configs;
- stale/replaced sessions cannot refresh;
- a next ICE restart uses refreshed config while a healthy PC is not restarted;
- current restart/rebuild/alternate-peer/SFU order remains unchanged after a
  peer connection reports failure.

Acceptance canary:

- Chrome/Edge direct selection with TURN configured and relay candidates
  present;
- forced direct failure selecting TURN without an application route change;
- unreachable coturn while a direct pair remains possible;
- expired credential, refresh, reconnect, and coturn restart;
- `1/3/5/8` direct-selected allocation/RSS/CPU/latency comparison;
- `1/2` forced-relay media bandwidth, packet loss, latency, and recovery;
- Android Chrome and iOS Safari on home, hotspot, carrier, and UDP-blocked
  networks, with UDP-blocked failure expected in the first UDP-only slice.

No broad rollout or 1-GiB capacity claim follows from unit tests.

## Sources

Primary sources accessed 2026-08-20:

- [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html)
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)
- [WebRTC configuration and ICE restart](https://www.w3.org/TR/webrtc/)
- [Coturn turnserver documentation](https://github.com/coturn/coturn/blob/master/README.turnserver)
- [Coturn TURN REST API implementation](https://github.com/coturn/coturn/wiki/turnserver)
- [TURN REST API draft](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00)

No source code was copied.
