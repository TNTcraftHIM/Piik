# Low-Server-Cost Media Routes

- Research date: 2026-08-22
- Scope: one broadcaster, explicit admission up to sixteen trusted viewers,
  low latency, and bounded host media fanout
- Status: research and dated route evidence. Current invariants and assisted
  transport roles are in [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md);
  runtime migration and validation are in [the TODO ledger](../todo.md).

## Historical Candidate Route Ladder

At this dated checkpoint, the candidate plan used direct Host P2P first, then a
bounded browser relay DAG. Browser relays decoded and re-encoded each stream,
while separate native shared-encode and encoded-RTP relay ideas remained
research candidates. A single-node SFU was tested as optional capacity after
peer recovery; its source checkpoint used one or two roots. These measurements
do not define the current topology, fallback order, or capacity policy.

At that checkpoint, any browser-spike failure other than isolated relay
re-encoding closed that browser-relay candidate. Native sender work remained a
separate research track. Closed
PR #12's explicit whole-room SFU mode is superseded. ADR-0005 and merged PR #17
own the automatic cross-mode controller. Production first enabled it only for
room `1` and later removed that rollout boundary. The deployed release observed
participant entry but did not retain media. On 2026-08-21, a latest-source run
forced the first direct edge to fail and then passed one local SFU/UDP root with
Chrome 151, LiveKit 1.13.5, and pinned client 2.22.0. LiveKit produced two sender
RIDs in `q,h` order; Screener's former `q,f` guard caused the Host publisher to
fail closed at `sender-config`. After correcting that contract, Viewer inbound
packets and decoded/rendered frames increased, endpoint edges stayed bounded,
and both clients left cleanly. TURN did not participate in that first run. A
later exact-source canary against the production media tuple proved the active
Host-ingress selected relay described below. Both are functional, not
performance, evidence; public-room and browser-diversity validation remain open.

## Token-Free SFU Standby Prewarm

The pinned Apache-2.0 `livekit-client` 2.22.0 source documents and implements
`Room.prepareConnection(url)` as DNS/TLS preparation. For a self-hosted URL and
no token, it converts `ws(s)` to `http(s)`, sends one `HEAD`, and catches errors.
It does not call `connect`; therefore it does not join a room, acquire a
participant identity, publish, subscribe, or create a media edge. A token is
only relevant to LiveKit Cloud region selection, which this self-hosted spike
does not use.

The smallest integration is to advertise the non-secret LiveKit origin only in
the authoritative peer-assisted authentication snapshot when the complete
fallback tuple exists. Each client dynamically imports the already-pinned SDK
once and attempts the URL once. Newer authentication invalidates a stale task
before the import completes; a failed HEAD is silent and is not retried. No JWT
is issued until the existing route controller actually selects SFU fallback.
With no fallback configuration, the field, import, HEAD, and behavior are all
absent.

A bounded Chrome 151/LiveKit 1.13.5 localhost/headless/video-only same-leaf A/B
reduced failure report to SFU active from 1.481 seconds to 200 ms and to a
rendered frame from 2.257 seconds to 319.7 ms. It retained the fixed direct ->
peer -> SFU order, two allowlisted roots, and host media-edge peak two. The
standby had already downloaded/parsed the SDK and made its token-free network
prewarm, without a participant or media edge, so the A/B does not isolate those
effects. Its roughly 86% result must not be extrapolated to a public network;
internet DNS/TLS reuse, RTT/loss, audio, transport fallback, and browser variance
still require measurement.

At that source checkpoint, the 2026-08-22 in-process
`gate:sfu-root-invariants` proved its fixed-root and Host-publication accounting,
token allowlist, zero-child reauthentication, and subscriber-retention behavior.
It used no LiveKit process, browser RTC stats, or packet counters, so it did not
measure `B_pub`, root egress, forwarding, or congestion behavior and does not
select the current resource model.

## Traffic Conservation And The Impossible Triangle

This is an engineering accounting identity, not a named theorem. Let `B` be
the measured useful media bitrate for one same-representation branch, `B_pub`
the actual SFU publication bitrate, `B_i` server-fed subscriber `i`'s selected
bitrate, `N` the Viewer count, `R` the number of server-fed subscribers, and `D`
their peer descendants. Thus `N = R + D` for this screening model. For the
equal-representation baseline,
useful last-hop delivery is approximately `N*B`. Ignoring protocol overhead:

`host last-hop copies + peer last-hop copies + server last-hop copies = N * B`

| Full-stream shape | Host upload | Viewer-relay upload | Central media traffic |
| --- | ---: | ---: | ---: |
| Peer roots, direct edges | `R*B` | `D*B` | none |
| Peer roots, all `R` seed edges through TURN | `R*B` | `D*B` | TURN ingress `R*B` + egress `R*B` |
| SFU virtual parent to the same relay seeds | `B_pub` | `D*B` | SFU ingress `B_pub` + egress `sum(B_i)` |
| Same-representation full-room SFU | `B` | `0` | SFU ingress `B` + egress `N*B` |

The table's `R*B` and `D*B` rows are equal-representation screening cases with
`E=0`.
With mixed root representations, direct peer-root traffic is `sum(B_i)` and
descendant upload is `sum(B_edge)`. SFU host upload and ingress are `B_pub`, the
sum of all actively published representations; if simulcast `HIGH` and `LOW`
both remain active, that may be `B_HIGH+B_LOW`, not one root bitrate. The
SFU-fed relay-seed row, not full-room SFU, is the retained fallback shape. For equal
representations, `B_pub = B` and `sum(B_i) = R*B`. Publisher-to-SFU and every
SFU-to-seed subscriber transport are independent ICE connections and may use a
separately deployed LiveKit transport. Ordinary descendants are STUN-only;
selected coturn is issued only for an exact authorized edge or Host-SFU ingress.
If a
publisher leg separately uses LiveKit TURN, retain host upload
`B_pub`, TURN ingress `B_pub`, TURN egress `B_pub`, and SFU ingress `B_pub` as
distinct interface/service traffic. A relayed root leg likewise adds TURN
ingress and egress `B_i`; a selected-edge relay adds both directions for that
edge's actual bitrate. They are one logical useful payload copy but real
physical hops, so NIC, service, and billing counters must never be folded.

If `E>0`, SFU relay-seed/exception egress is
`sum(B_i) + sum(B_exc,j)` and central SFU traffic is
`B_pub + sum(B_i) + sum(B_exc,j)`. Peer descendant upload remains
`sum(B_edge)`. Any separately TURN-relayed LiveKit subscription or
controller-selected peer edge adds TURN ingress and egress equal to that leg's
measured bitrate. Server-fed subscriptions are never hidden inside endpoint
child capacity or the equal-representation formulas. Their ingress, egress and
TURN allocations are admitted explicitly; `R` is a measured scenario variable,
not a fixed product root limit.

RTP/RTCP/SRTP, DTLS, ICE/TURN and IP headers, retransmission, FEC, and redundant
paths only add traffic. W3C candidate-pair byte counters exclude some transport
overhead, and a provider may bill ingress and egress differently, so formulas
screen candidates but never replace host NIC, TURN/SFU, and billing counters
from the same run. Encoding once can reduce compute and memory bandwidth, but
it cannot remove the network copy delivered to each viewer.

## Transport And Topology Layers

TURN is an ICE transport and an SFU is a media service; neither fact alone
defines logical parentage or resource admission. Ordinary peer PCs gather only
STUN candidates. The holistic model must bind any SFU subscription or selected
TURN transport to current route authority while preserving sticky unaffected
subtrees, the configured ordinary endpoint cap, and bounded failure.

This distinction follows TURN's allocation/relay role in RFC 8656 and the media
topology boundary in RFC 7667. A relay candidate proves transport for one edge;
it is not evidence that an SFU topology would be cheaper or faster.

## Hard NAT And UDP-Blocked Boundary

"Symmetric NAT" is legacy shorthand. The actionable properties are endpoint-
independent versus endpoint-dependent mapping and filtering, whether outbound
UDP reaches a public server, and whether a public IPv6 path exists. CGNAT names
an operator topology, not one mapping behavior: RFC 6888 inherits the UDP NAT
behavior requirements and recommends endpoint-independent filtering. Cellular
networks can add translation layers, short-lived state, strict filtering, and
network changes, but their selected ICE path must be measured.

| Network condition | Honest WebRTC boundary | Screener consequence |
| --- | --- | --- |
| Endpoint-independent mapping with UDP | Full ICE can check host, server-reflexive, and peer-reflexive paths | Keep direct/peer UDP first |
| One endpoint-dependent mapper | Coordinated checks can sometimes create a peer-reflexive path; success is not guaranteed | Exhaust the existing bounded restart/rebuild/alternate-parent steps |
| Both peer endpoints use endpoint-dependent mapping | A direct peer path is not reliable; RFC 8835 requires TURN support for this case | A public SFU/UDP or authorized TURN path may still work when outbound UDP reaches that server; ADR-0005 owns exact edge and resource authority |
| All outbound UDP is blocked | The UDP media ladder has no reachable candidate | End with a clear bounded failure |
| Wi-Fi/cellular or address change | Old mappings and candidate pairs can become invalid | Use a new opaque generation and bounded ICE restart/rebuild, then re-run the same priority ladder |

Peer-reflexive discovery records an address only after a connectivity check
succeeds; it does not cross two incompatible mappings by itself. A restricted
endpoint may still reach SFU or TURN infrastructure over outbound UDP. The
holistic route model must decide publication ownership, subscription placement,
selected transport, and resource admission without changing this NAT boundary.

Do not infer endpoint-dependent mapping from a `cellular` or `CGNAT` label. A
2023 experiment reached three of four Dutch mobile carriers, but that cohort is
too small and unlike Screener's target networks. A 2026 native DCUtR study found
that 97.6% of its successful traversals completed on the first attempt; its
roughly 70% result is conditional on relay reservation and address discovery,
which had already failed for about 29% of collected attempts. ProbeLab also says
that its reported 39.7% "symmetric" success may include classification error or
a network change. These studies justify measurement and bounded retry, not a
browser success-rate claim or repeated-refresh roulette.

One field observation retained a working P2P route after a Wi-Fi-to-cellular
switch and still retained P2P when the user requested reconnect. That single
session cannot distinguish endpoint-independent cellular mapping, public IPv6,
an ICE-selected replacement pair, or operator mapping/filtering lifetime. It
supports one fresh, generation-bound P2P opportunity after a discrete network
change or explicit reconnect; it does not support periodic probing, a carrier
"kept channel" assumption, or a universal hard-NAT traversal claim.

### Deployable Browser-First Priorities

**1. Dual-stack Web, STUN, SFU, and selected TURN**

- Smallest change: publish working `AAAA` records, bind every public endpoint on
  IPv6, and open the same bounded UDP paths. Browser ICE already gathers and
  intermixes IPv4/IPv6 candidates; do not add application candidate ordering.
  Product code can remain unchanged; any retained evidence is only a sanitized
  selected-address-family enum tied to the existing opaque generation.
- Dependency: routed IPv6 at the provider, dual-stack STUN/SFU/TURN listeners,
  correct firewall rules, and no IPv4-only hostname hidden in the media ladder.
- Acceptance: owned desktop, Wi-Fi, and cellular probes select an IPv6 P2P path
  and an IPv6 SFU/selected-TURN path where available; broken IPv6 still reaches
  the IPv4 ladder within the current route deadline. Retain only an `ipv4|ipv6`
  enum with the existing opaque generation and media proof, never a raw address.
- Stop line: if any required public media endpoint has no routed IPv6, record the
  deployment as incomplete and keep the IPv4 ladder. Do not build a custom IPv6
  selector or claim NAT bypass from an `AAAA` record alone.

**2. Exactly two independent-destination STUN servers**

- Smallest change: set the existing `STUN_URLS` list to two URLs. Current server
  code already accepts the list and sends both URLs in one ICE server entry.
  Existing schema capacity for eight URLs is not a product recommendation.
- Dependency: each URL must resolve to a different public destination IP;
  separate failure domains and dual-stack coverage are preferable. Current
  libwebrtc tests show that equal observed mappings are deduplicated while two
  different observed mappings from two STUN destinations can yield two `srflx`
  candidates from the shared UDP port.
- Acceptance: each server alone gathers a usable `srflx` candidate on the exact
  Chrome, Firefox, and Safari releases recorded in the matrix, the pair does not
  regress time to first decoded frame, and gathering still succeeds with either
  server unavailable. Confirm server identity only in locally retained browser
  diagnostics; do not add URL or address retention to production telemetry.
- Stop line: two STUN destinations improve address-family/failure diversity and
  can expose mapping differences in an owned canary; they do not reveal the
  mapping that a peer destination will receive and do not solve two endpoint-
  dependent mappers. Do not add a third server or a NAT classifier without a
  measured failure that the second server fixes.

**3. Healthy SFU-to-P2P bounded re-probe**

- Historical checkpoint: production `27ad90d` had the first deployed one-root slice: it
  reserves bounded capacity, keeps the healthy SFU route playing, proves one
  fresh P2P generation with current decoded-media progress, then commits
  atomically and closes the old route. Source `4c9174d` additionally
  retains one cooldown-time opportunity as a current tuple and requires two new
  evidence windows at expiry. Later production deployed that bounded continuation
  and subsequent peer-quality MBB work. Exact current capacity, SFU, TURN, and
  accounting semantics remain unaccepted pending the holistic route model. None
  of these generations polls network state.
- Retained candidate: a discrete network-change or explicit-reconnect event may
  open one opportunity through that same controller after cooldown. It must not
  create a second route controller or treat an ICE restart on the SFU
  `RTCPeerConnection` as P2P discovery.
- Acceptance: an owned viewer that fell back to SFU changes Wi-Fi/cellular,
  receives one bounded fresh probe, and moves to P2P without playback loss or
  duplicate active edges. A failed probe leaves the healthy SFU route unchanged;
  stale answers or repeated browser events cannot start another generation or
  leak capacity.
- Stop line: no polling loop and no periodic probing. If one discrete probe
  causes SFU playback regression, overlapping offers, cap violation, or route
  churn, keep the healthy SFU route and fix the generation/commit boundary before
  another rollout.

### Isolated Bounded Guessed-Candidate Spike

WebRTC does not expose raw UDP, but the WebRTC API lets the application signal a
remote ICE candidate and call `addIceCandidate()`. An owned experiment can
therefore inject a small, explicitly capped set of nearby
remote-port candidate guesses for one edge generation and let the browser ICE
agents send authenticated connectivity checks. The initial harness ceiling of
eight guesses across both endpoints is a safety fixture to bound abuse and ICE
work, not a product constant or evidence that eight is optimal. This is bounded
port prediction, not the birthday-paradox technique proposed for native peers
with hundreds of sockets and probes.

RFC 5780 behavior discovery is Experimental, requires a STUN server that
supports alternate addresses, observes only current behavior toward those test
destinations, and explicitly does not replace ICE. It may help an owned emulator
confirm that a mapping pattern exists, but route decisions must still use actual
operating connectivity and media evidence. A NAT label or two observed ports do
not authorize a guessed production path.

- Current status: zero product or production integration and not yet eligible
  for a production canary. Use an isolated test page or harness and
  a sequential endpoint-dependent NAT emulator fixture. Reuse existing candidate
  signaling and ICE generations; do not mutate SDP or create a second production
  protocol.
- Dependency: two controlled STUN destination IPs, a deterministic owned NAT
  emulator, the same ICE base/socket across observations and peer checks, an
  allowlisted test room, and a hard maximum of eight extra candidate guesses in
  total across both endpoints per edge generation. No guessed address, candidate
  string, or SDP may be retained.
- Acceptance: ordinary ICE must deterministically fail direct connection in the
  emulator; then the bounded variant must reach decoded media within the current
  15-second route window in at least 90 of 100 runs on the exact stable Chrome
  and Firefox releases recorded in the matrix, with no more than eight injected
  guesses in total and no candidate-error or resource-growth regression. Actual
  connectivity-check packets may exceed eight because guesses pair with local
  candidates and ICE retransmits checks; the candidate budget is not a packet
  budget. Safari is measured separately before any product decision. Only an
  emulator pass permits one manually approved canary in an operator-owned test
  room. Both endpoints must explicitly consent, and the canary must be default-off
  behind a kill switch and bound to one exact room, logical edge, ICE generation,
  deadline, and aggregate candidate budget. It is still not general production
  evidence.
- Stop line: reject the candidate if it needs raw sockets, extra peer
  connections, browser-specific SDP rewriting, more than eight total guesses,
  unbounded retries, a longer black-screen deadline, or fails the two-engine
  repeatability gate. A failure closes this candidate in favor of bounded
  SFU/UDP and selected TURN/UDP; it does not justify a native sender by itself.

### Ordinary-Browser Hard Boundaries

- Birthday-paradox traversal, broad multi-socket probing, source-port binding,
  PCP/NAT-PMP/UPnP, and TCP simultaneous-open require socket or gateway control
  that an ordinary page does not have. Many `RTCPeerConnection` objects are not
  an acceptable substitute: the page still cannot bind ports and would create
  unbounded ICE, DTLS, memory, and abuse risk.
- Peer-reflexive candidates remain useful, but browser ICE creates them only
  after a connectivity check succeeds. RFC 8863's recommended 39.5-second PAC
  timer is an ICE-agent failure boundary, not a JavaScript tuning API. Do not
  extend Screener's current route deadline to 40 seconds; measure late recovery
  behind a playing SFU route through the bounded re-probe instead.
- The April 2026 ICE-renomination draft requires opt-in from both ICE agents and
  the W3C `RTCConfiguration` exposes no renomination switch. Historical
  libwebrtc native code has a disabled-by-default flag for an older renomination
  proposal; it is neither this draft nor a browser API. Renomination can choose
  among retained pairs inside one ICE session; it cannot turn an SFU connection
  into a peer topology.
- Current QUIC traversal work also assumes an existing relay and candidate
  discovery from the same application-controlled UDP socket. Browser
  WebTransport is a client connection to a server, not a raw UDP socket or an
  inbound peer listener. Native TCP/QUIC DCUtR results therefore do not reopen
  Screener's accepted browser media transport boundary.
- `iceCandidatePoolSize` only pre-gathers implementation-managed candidates for
  future ICE use. It does not expose ports, create birthday probes, or repair an
  endpoint-dependent mapping. Repeated refreshes and a large STUN list likewise
  add delay and mappings without a stable traversal mechanism.

The shared acceptance matrix remains EIM/EIM, one endpoint-dependent mapper,
two endpoint-dependent mappers including cellular-to-cellular, all UDP blocked,
and a Wi-Fi-to-cellular change. Record only sanitized selected transport,
address family, generation, time to first decoded frame, loss, RTT, bitrate, and
relay/SFU bytes. Keep credentials short-lived and edge-scoped and retain
allocation, relay-port, and egress caps.

## Privacy-Safe ICE Evidence Candidate

Start with locally retained, redacted `webrtc-internals` as manual ground truth.
Only then may one exact allowlisted room record, without changing its route:

- selected local/remote candidate type and protocol plus local
  `relayProtocol`;
- selected address family reduced locally to `ipv4|ipv6`, without retaining the
  source address;
- `iceGatheringState`, `iceConnectionState`, and `connectionState` transitions
  with monotonic event-derived establishment duration;
- `selectedCandidatePairChanges` when implemented, reported only as a delta
  from the current opaque connection/ICE-restart generation baseline;
- RTT, loss, and actual/available bitrate for the selected RTP-bound path; and
- `icecandidateerror.errorCode` bucketed as
  `3xx|4xx|5xx|6xx|701|other`.

Never retain raw `errorText`, address, port, URL, candidate strings, SDP, or
device/network identifiers. Stats members may be absent, and the pair-change
counter is transport-lifetime state, so events and generation baselines prevent
old connection or ICE-restart history from being attributed to a new route.
Use opaque generations only. This is a bounded diagnostic manifest, not a
backend telemetry schema or controller input.

### Local Diagnostic Export Boundary

The local report is a projection of current sanitized metrics, not a serialized
stats object or signaling snapshot. It uses a fixed field allowlist and writes
unavailable values as `null`; selected addresses/ports, internal IDs, participant
identity, raw SDP/candidates, media-service URLs, and credentials never enter the
report input. The file is created only after a user click with a local JSON
`Blob`, is not uploaded or persisted, and its object URL is explicitly revoked.
The [W3C File API](https://www.w3.org/TR/FileAPI/) (accessed 2026-08-22) defines
Blob URLs for locally generated downloads and requires explicit revocation to
release their backing store.

### Pre-Share Self-Check Boundary

A temporary, unpaired `RTCPeerConnection` can create a data channel, set its
local offer, and inspect only `RTCIceCandidate.type`. Gathering a `srflx`
candidate proves that the browser received a STUN response for this generation;
it proves neither a usable peer candidate pair nor bandwidth, latency, NAT type,
or media quality. A same-origin WebSocket open followed by immediate close proves
only the signaling handshake. Neither probe creates a Screener room or media
edge, and both discard their temporary resources.

Pinned LiveKit `Room.prepareConnection(url)` without a token performs an HTTP
`HEAD`; it does not establish ICE/UDP. A real LiveKit transport requires a token
and participant connection, which would create the room/SFU state this pre-share
check deliberately avoids. The UI therefore reports configured SFU as unknown
until an actual controller-selected route proves current-generation media. The
public, `no-store` self-check config returns only the existing STUN-only
`iceConfig` and an SFU-configured boolean. It returns no SFU or TURN URL, token,
username, credential, address, candidate, or selected-edge grant.

## Historical SFU/UDP And Selected-Edge TURN Slice

Every ordinary bounded peer `RTCPeerConnection` used STUN-only ICE. The tested
source attempted bounded peer recovery, then its fixed-root SFU/UDP slice, then
one controller-selected authenticated TURN/UDP rebuild before failure. That
ordering and accounting are historical implementation evidence, not current
route authority.

STUN/ICE discovers and checks paths. RFC 8656 TURN allocates a relayed address
and continuously carries media when selected; it is not a handshake helper or
topology. Ordinary PCs do not gather relay candidates, so healthy paths consume
no idle allocation. Exact-room, complete-tuple, current-generation and one-use
controller gates prevent participant-wide or process-wide rollout.

Coturn validates a REST bearer's HMAC and expiry, not the originating room,
peer edge, revision, parent, or connection generation. Application issuance and
both endpoint rebuilds therefore must revalidate the controller's current edge
identity and consume the attempt on success, failure, expiry, or generation
change. This is application selected-edge enforcement plus TTL, fanout, and
quota containment, not coturn-side cryptographic edge binding. The failed
built-in alternative and retained standards evidence are in
[Built-In Peer ICE TURN Candidate](./built-in-peer-ice-turn.md).

Pinned LiveKit 1.13.5 can advertise authenticated TURN to LiveKit participants,
but that separate ICE domain covers publisher/subscriber connections to the
SFU, not ordinary peer PCs. Selected-edge coturn uses independent configuration
and credentials. LiveKit TURN cannot rescue an unavailable SFU; the application
controller selects whether independent coturn may rebuild one failed peer edge.

Pinned client 2.22.0 accepts a per-connect `rtcConfig`; its engine retains
explicit ICE servers when constructing the publisher PeerConnection. A selected
Host ingress can therefore supply only its coturn server plus relay policy
without advertising that credential to ordinary peer PCs.

Ordinary peer ICE remains STUN-only. The participant-wide TURN
config, capability and refresh wire are removed; any stale `PEER_ICE_TURN_*`
key, including an empty value, fails startup. Selected-edge TURN is deployed as
a configured, controller-issued exceptional transport. Its active Host-ingress
media path is canary-proven; initial ingress and `peer-selected` remain open.
Every ordinary Web peer and Native-shaped client remains STUN-only. The tracked coturn example is UDP
`stun-only`; the LiveKit example exposes only ICE/UDP mux 7882, explicitly sets
`tcp_port: 0` and `allow_tcp_fallback: false`, supplies the self-hosted STUN
endpoint, and configures no external or embedded TURN. Candidate validation and rollback use isolated
instances rather than a process-wide old-release compatibility branch. HTTPS/WSS remains TLS/TCP.

### Active Host-Ingress Functional Evidence

On 2026-08-21 the tracked standalone gate reused the production selected-edge
tuple parser and credential issuer, supplied the short-lived credential only to
an isolated loopback Chrome page, and returned a sanitized result: one UDP relay
candidate and an otherwise non-blocking `701` error bucket. No URL, username,
credential, candidate address, or raw error text was emitted or persisted.

The canonical Chrome 151 product canary then used exact deployed Web source
`16f6eab27bdfb1c15cdbd814a35864f4f18be767` in a local Screener room while
connecting to the production LiveKit 1.13.5 and coturn tuple. After direct media
and active SFU media, a temporary DEV-only hook failed the refreshed publisher
once; the normal application failure path requested `host-sfu-ingress` and the
hook was removed after the run. The relay-policy publisher had only a TURN
server, reached connected/ICE-connected, and selected a succeeded/nominated UDP
pair with `relayProtocol=udp`. Pair counters reached 1,054,606 bytes sent and
4,934 received; outbound RTP reached 837,103 bytes and 101 frames. Viewer decode
and render counters both advanced during the selected stage. Ordinary peer PCs
kept policy `all` with STUN-only servers, Host active outbound edges stayed at
one, and explicit stop reduced them to zero. The production Screener app and
database were not used or modified.

Chrome reported the selected local candidate's `candidateType` as `prflx` while
also reporting `relayProtocol=udp`. That tuple is internally inconsistent with
the W3C model: `iceTransportPolicy="relay"` permits only media-relay candidates,
and `relayProtocol` is defined for a local relay candidate. The evidence is
therefore retained verbatim and classified from the relay-only configuration,
TURN-only server set, `relayProtocol`, and transmitted media together; the
`candidateType` field is not rewritten. This proves one active functional route,
not latency, quality, capacity, expiry, mobile, resource, or bandwidth behavior.
Coturn 4.17.2 documents `stun-only` as ignoring TURN requests and provides
`no-tcp` and `no-tls`; it marks `no-dtls` deprecated, so the tracked temporary
template does not use that switch. The shared production host instead retains its old
authenticated-relay daemon and TCP/UDP 3478 plus UDP 49152-49251 rules. The
rejected participant-wide candidate advertised no TURN credential, and that
historical post-canary audit found zero allocations. This baseline is not the
later selected-edge functional evidence above.

No public port is selected by this decision. LiveKit documents ICE/UDP mux as
optional and its pinned sample recommends a multi-port UDP mux range at least
as wide as the CPU count for performance. Embedded TURN/UDP defaults to 3478.
The current nginx template has no HTTP/3 listener, but that fact alone does not
prove one UDP port is the best production layout.

For one equal representation of measured bitrate `B` and `R` roots:

- `R` TURN seed edges: host upload `R*B`, server ingress `R*B`, server egress
  `R*B`, total central traffic `2R*B`;
- one SFU publisher to `R` roots: host upload `B`, server ingress `B`, server
  egress `R*B`, total central traffic `(R+1)*B`.

At `R=1` useful-payload traffic is equal, so the identity alone gives neither
route a preference; CPU and allocation cost require the same-host benchmark.
At `R=2`, the equal-representation SFU case halves host upload and
central ingress and reduces total central traffic from `4B` to `3B`, with the
same `2B` egress. Mixed representations replace `B` with measured `B_pub` and
`sum(B_i)`; a HIGH+LOW publication may erase that advantage. Public LiveKit
benchmarks and the Jitsi profiling breakdown establish capacity and component
categories only. Different machines and implementations cannot support a
universal coturn/SFU CPU ratio or a claimed fixed percentage saving.

One bounded exact-room gate owns rollout evidence:

1. On the same host and NIC, compare coturn UDP and LiveKit SFU UDP at measured
   8 and 12 Mbps with one and two roots. Record CPU seconds/GiB, RX/TX bytes,
   packets/s, RSS, host upload, p95/p99 forwarding latency, loss/recovery, and
   final decoded quality.
2. Cover representative consumer networks with independent STUN-only
   direct/peer, SFU/UDP subscription, exact selected-edge TURN, and Host-SFU TURN
   gates. The test order does not define the controller's per-edge route choice.
   All ordinary peer connections must remain STUN-only.
3. Measure allocation count/relay ports/RSS/CPU/latency for one and two selected
   attempts, plus relay RX/TX/loss/latency. There is no participant-count idle
   allocation target because ordinary peer PCs do not receive TURN candidates.
   Block all UDP and show a bounded explicit failure; TURN/UDP is not media TCP.
4. Exercise assisted-route departure, reconnect, service unavailability, and
   rollback. Non-server ordinary downstream edges stay within the configured
   cap, server allocations stay within accepted resource admission, and
   unaffected peer subtrees do not migrate.
5. Correlate only selected candidate type/protocol/relayProtocol and opaque
   generations; never upload raw SDP, candidate/address/IP, credentials, or
   device identifiers.

Selected-edge TURN retains endpoint-to-endpoint DTLS-SRTP. Ordinary SFU transport
terminates DTLS-SRTP on both sides, so its operator can access media unless
Screener later implements application E2EE and key distribution. That accepted
tradeoff remains visible in deployment and UI claims.

A peer simultaneously re-publishing its received stream to the SFU and serving
peer children is outside the current product. A browser relay would decode and
re-encode, and publication ownership would add another failure domain; the
current model uses one authoritative Host publication. No global score,
continuous optimizer, geography, IP, UA, or self-reported capability chooses
routes.

On today's unicast Internet, a design cannot maximize all three of these for
more than one viewer:

1. near-zero central-server media egress;
2. near-zero host and viewer upload, compute, and installation burden; and
3. ultra-low-latency, robust recovery across churn, NAT, and restrictive networks.

If the server does not emit the copies, endpoints must. If endpoints do not,
the server must. Redundancy can improve recovery but costs traffic and
coordination; removing redundancy leaves a recovery interval after a relay is
lost.

## Deployment-Wide SFU Admission

LiveKit's official benchmark guidance says each room must fit on one SFU node
and identifies published tracks, subscribers, and bytes forwarded per subscriber
as separate capacity drivers. Its room `maxParticipants` setting is a participant
count guard; it does not express Screener's Host-publication ingress or
per-subscription egress budget. The application therefore needs its own typed
admission boundary instead of treating a root count or the SDK room setting as
resource evidence.

Pinned LiveKit 1.13.5 treats `canPublishSources` as a source allowlist, not a
per-participant or per-source publication-count limit. `limit.num_tracks` gates
node-wide `NumTracksIn + NumTracksOut` admission, while
`subscription_limit_video/audio` caps each participant's concurrent subscribed
tracks by kind and leaves excess requests pending. Neither is an SFU bandwidth
budget or a replacement for Screener's ingress and egress admission.

For the current single application process, one O(1) ledger owns two explicitly
configured positive safe-integer capacities: each Host publication uses one
ingress unit and each authorized SFU subscription uses one egress unit. There is
no built-in default or fixed root count. A candidate reserves its full actual
ingress/egress demand under exact room/share/publication identity before any
token is issued; reserved, committed, and draining generations are all charged.
Capacity exhaustion leaves the current route unchanged and returns control to
the bounded fallback sequence. Screener sizes those capacities for its shipped
clients in private rooms where authenticated Hosts are trusted media
participants; the pinned upstream LiveKit release is sufficient for that
boundary.

Self-hosted `RemoveParticipant` closes the current participant but does not
invalidate a still-valid join token, and token expiry governs connection
admission rather than terminating an existing participant. A route commit or
client disconnect therefore cannot prove resource release. The dedicated
LiveKit instance disables automatic room creation. Screener explicitly creates
an exact-generation room containing an unguessable publication generation and
never reuses that name; `DeleteRoom` plus an absent-room readback is the drain
proof. With `room.auto_create: false`, an old token cannot recreate the absent
room. Reserved, committed, and draining generations remain charged until that
proof completes.

At process startup, the application first acquires its configured listener; a
competing process that cannot bind performs no LiveKit operation. The bound owner
returns `503` and installs no signaling upgrade handler while it rejects foreign
room names, drains all stale Screener rooms, and confirms the namespace empty
before admitting a new generation. Host signaling loss is checked against the
exact LiveKit Host participant on a bounded interval, so healthy media stays
charged while an abandoned generation is reclaimed after the participant
disappears.

These capacities are operator inputs derived from the actual instance, codec,
representation, bitrate, and accepted concurrency matrix. LiveKit's published
example benchmark cannot supply Screener defaults. A later multi-process
Screener deployment needs a shared atomic ledger; independent process-local
counters would not be deployment-wide admission.

## Route Screening

| Route | Where copies are emitted | Endpoint cost | Evidence status |
| --- | --- | --- | --- |
| Direct host P2P | Host emits one copy per Viewer | Host upload and sender pipelines grow with Viewers | Baseline evidence; current capacity is owned by the product contract |
| Bounded browser relay DAG | Host and each Web relay emit at most the configured endpoint cap | Ordinary browser, but every relay decodes and re-encodes and adds a hop | Admission defaults to eight and permits 1-16; representative resource/quality gate remains eight viewers |
| Native shared-encode host | Host targets one encode for standard WebRTC edges | libwebrtc public-API proxy risk spike, with Pion as fallback | Research evidence; still pays per-edge upload |
| Native volunteer encoded-RTP relay | Each volunteer forwards one encoded copy | Native install, RTP/RTCP forwarding, packaging, and opt-in relay policy | Research only; no current product authorization |
| SFU service | SFU emits authorized subscription copies | Service pays measured egress; an authoritative Host publisher supplies media | Functional evidence exists; accepted topology/admission still needs runtime validation |
| Additional server-assisted paths | SFU/TURN emits authorized copies | Additional central ingress, egress, or allocation cost | Accepted resource-admission input; validate each bounded path at release |
| SVC plus multiple trees | Peers emit striped layer copies across several trees | Layer scheduling, reassembly, redundancy, and more churn state | Separate conditional spike; target endpoint upload near `B` |
| Network coding | Peers or servers emit coded blocks | Generations, buffering, decoding, integrity, and a custom media plane | Trace/FEC spike only; optimize loss recovery, not clean bandwidth |
| MoQ | Publishers and MoQ relays emit object copies | New transport, packaging, player, relay, and auth stack | Optional central-fallback benchmark; still pays server egress |
| Peer-assisted CDN | Peers cache or upload segments/objects | Discovery, locality, scheduling, incentives, abuse, and privacy systems | Reject for this trusted group |
| IP multicast | Multicast routers replicate packets | Requires multicast-enabled hosts and routed networks unavailable to ordinary Internet browsers | Reject outside managed networks |

## Native Sender And Encoded-RTP Relay Research

Pion exposes the necessary native building blocks: `TrackRemote.ReadRTP()` reads
encoded RTP, `TrackLocalStaticRTP.WriteRTP()` writes pre-packetized RTP into
standard downstream WebRTC connections, and `RTPSender.ReadRTCP()` exposes
receiver feedback. A native volunteer could therefore terminate an upstream
WebRTC connection and forward encoded RTP to one downstream connection without
decoding or re-encoding. The downstream leaf can remain a normal browser.

This is feasibility evidence, not a ready relay. A real implementation still
has to prove codec/profile agreement, SSRC and sequence/timestamp handling,
RTCP feedback translation, NACK/RTX behavior, congestion control, keyframe
requests, generation changes, security, packaging, and voluntary use. The host
also needs a separate native shared encoder so its two WebRTC packetizers consume
one encoded result. Pion's broadcast example demonstrates server-side RTP
fanout, but it does not supply this end-user topology or product behavior.

Draft PR [#16](https://github.com/TNTcraftHIM/Screener/pull/16) has now passed
the narrower transport oracle: one Pion v4.2.18
`TrackLocalStaticRTP.WriteRTP` call fans a pre-packetized semantic payload to
two independent PeerConnections with binding-specific SSRCs. Because that
oracle contains no encoder, browsers, RTCP arbitration, or bandwidth-control
loop, it proves neither one physical encode nor a usable native relay. The
unresolved evidence boundary is browser-to-native-to-two-browser interoperability
with bounded RTCP/PLI, congestion, queues, throughput, and latency.

The native shared-encode sender and volunteer relay remain research candidates,
not current product work. Any later decision must keep deterministic assignment,
fanout, recovery, connectivity, mobile, and end-to-end latency concerns in their
proper owners.

## Outside The Current Browser-Track Spike

- **SVC and multiple trees:** WebRTC SVC controls layered encoding; it does not
  distribute replicas. SplitStream shows how striping across multiple trees can
  spread peer load. A separate encoded-object/native spike now owns its tree
  maintenance, reassembly, scheduling, and redundancy gates; none belongs in
  the fixed full-stream two-chain experiment.
- **Network coding:** published work improves block distribution in large
  overlays. A trace-first FEC experiment must prove lower freeze/repair delay
  within strict byte and buffering budgets before any media integration.
- **MoQ:** Media over QUIC provides promising relay-oriented publish/subscribe,
  priorities, and partial reliability, but MOQT remains an active Internet-Draft.
  Benchmark it only as a central fallback because a browser cannot act as an
  inbound WebTransport peer and the relay still pays fanout egress.
- **Peer-assisted CDN:** PCDN research addresses large file or segmented VoD
  distribution and ISP/provider cost. Its discovery, caching, locality,
  scheduling, incentives, and abuse controls are disproportionate for at most
  eight trusted viewers and do not guarantee sub-second live latency.
- **IP multicast:** Internet Group Management and Source-Specific Multicast
  require participating hosts and multicast routers. ICE establishes unicast
  candidate-pair transports; normal browser WebRTC across NAT and mobile networks
  exposes no Internet multicast delivery path.

The measurable gates and exact staged experiments are in
[Advanced Peer Distribution](./advanced-peer-distribution.md).

## Sources And License Boundary

Primary sources accessed on 2026-08-19, 2026-08-21, 2026-08-22, and 2026-08-23:

- [Pion WebRTC](https://github.com/pion/webrtc) - MIT; no code copied.
- [Pion WebRTC v4 API](https://pkg.go.dev/github.com/pion/webrtc/v4) - API
  evidence for RTP and RTCP access.
- [Pion broadcast example](https://github.com/pion/webrtc/tree/main/examples/broadcast)
  and [examples index](https://github.com/pion/webrtc/blob/main/examples/README.md)
  - MIT; reference behavior only.
- [RTP Topologies, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html),
  [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html),
  [dual-stack ICE guidance, RFC 8421](https://www.rfc-editor.org/rfc/rfc8421.html),
  and [ICE PAC, RFC 8863](https://www.rfc-editor.org/rfc/rfc8863.html) - IETF
  standards and BCP under IETF Trust terms.
- [UDP NAT behavior, RFC 4787](https://www.rfc-editor.org/rfc/rfc4787.html),
  [P2P across NATs, RFC 5128](https://www.rfc-editor.org/rfc/rfc5128.html),
  [NAT behavior discovery, RFC 5780](https://www.rfc-editor.org/rfc/rfc5780.html),
  [PCP, RFC 6887](https://www.rfc-editor.org/rfc/rfc6887.html), and
  [CGN requirements, RFC 6888](https://www.rfc-editor.org/rfc/rfc6888.html) -
  mapping, filtering, prediction, simultaneous-open, gateway-control, and CGN
  resource boundaries.
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html) - the relay is
  transport for client/peer traffic, not a room distribution topology.
- [coturn 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2)
  and [pinned turnserver documentation](https://github.com/coturn/coturn/blob/4.17.2/README.turnserver)
  - `stun-only` and UDP-only listener configuration; BSD-3-Clause, no code copied.
- [WebRTC transports, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html) -
  browser transport capability requirements do not require an application to
  advertise every supported fallback on every connection.
- [WebRTC](https://www.w3.org/TR/webrtc/),
  [WebRTC Statistics](https://w3c.github.io/webrtc-stats/),
  [WebRTC Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/#stream-processing),
  [WebRTC SVC](https://www.w3.org/TR/webrtc-svc/), and
  [WebTransport](https://www.w3.org/TR/webtransport/) - W3C specifications;
  their JavaScript surfaces do not expose raw socket or gateway control.
- [Current libwebrtc STUN-port tests](https://chromium.googlesource.com/external/webrtc/+/refs/heads/main/p2p/base/stun_port_unittest.cc),
  [native peer-connection configuration](https://chromium.googlesource.com/external/webrtc/+/refs/heads/main/api/peer_connection_interface.h),
  and [native port allocator](https://chromium.googlesource.com/external/webrtc.git/+/master/p2p/base/port_allocator.h)
  - `TestNoDuplicatedAddressWithTwoStunServers` and
  `TestTwoCandidatesWithTwoStunServersAcrossNat` are current evidence for the
  two-STUN behavior; the other controls are not exposed to browser JavaScript.
  BSD-3-Clause, no code copied.
- [ICE Renomination, April 2026 Internet-Draft](https://datatracker.ietf.org/doc/draft-thatcher-tsvwg-renomination/)
  and [n0 QUIC NAT Traversal, July 2026 Internet-Draft](https://datatracker.ietf.org/doc/draft-bruynooghe-n0-quic-nat-traversal/)
  - active individual drafts, not browser APIs or final standards.
- [MoQ Transport](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/),
  [MoQ Streaming Format](https://datatracker.ietf.org/doc/draft-ietf-moq-msf/),
  and the [MoQ working group](https://datatracker.ietf.org/wg/moq/) - active IETF
  work, not final RFCs.
- [moq-dev/moq](https://github.com/moq-dev/moq) - core crates are dual
  MIT/Apache-2.0; its separately distributed `cpp/obs` plugin is
  GPL-2.0-or-later. No code was copied.
- [SplitStream, SOSP 2003](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/)
  - published research, no implementation license granted here.
- [Network Coding for Large Scale Content Distribution, INFOCOM 2005](https://www.microsoft.com/en-us/research/publication/network-coding-for-large-scale-content-distribution/)
  - published research, no implementation license granted here.
- [Should Internet Service Providers Fear Peer-Assisted Content Distribution?](https://www.usenix.org/conference/imc-05/should-internet-service-providers-fear-peer-assisted-content-distribution)
  - published research, no implementation license granted here.
- [IP multicast, RFC 1112](https://www.rfc-editor.org/rfc/rfc1112.html) and
  [Source-Specific Multicast, RFC 4607](https://www.rfc-editor.org/rfc/rfc4607.html)
  - IETF standards under IETF Trust terms.
- [LiveKit](https://github.com/livekit/livekit) - Apache-2.0; the SFU
  reference, with no code copied into this research change.
- [LiveKit 1.13.5 configuration sample](https://github.com/livekit/livekit/blob/v1.13.5/config-sample.yaml),
  [pinned configuration source](https://github.com/livekit/livekit/blob/v1.13.5/pkg/config/config.go),
  [node track-limit selection](https://github.com/livekit/livekit/blob/v1.13.5/pkg/routing/selector/utils.go),
  [participant publication checks](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/participant.go),
  [subscription-limit handling](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/subscriptionmanager.go),
  [room allocation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/service/roomallocator.go),
  [room-service lifecycle](https://github.com/livekit/livekit/blob/v1.13.5/pkg/service/roomservice.go),
  [access tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/),
  [RoomService API](https://docs.livekit.io/reference/other/roomservice-api/),
  [server SDK 2.17.0 RoomServiceClient](https://github.com/livekit/node-sdks/blob/livekit-server-sdk%402.17.0/packages/livekit-server-sdk/src/RoomServiceClient.ts),
  [ports/firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/),
  [deployment/embedded TURN](https://docs.livekit.io/transport/self-hosting/deployment/),
  and [benchmark guidance](https://docs.livekit.io/transport/self-hosting/benchmark/)
  - transport, port, authentication, and capacity boundaries; no source copied.
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
  and [end-to-end encryption](https://docs.livekit.io/transport/encryption/) -
  official behavior and operator-boundary references.
- [LiveKit client 2.22.0 `Room.prepareConnection`](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts),
  [connection options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/options.ts),
  [RTC configuration construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/RTCEngine.ts),
  [two-layer RID construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts),
  and [official usage](https://github.com/livekit/client-sdk-js#usage) -
  Apache-2.0; API behavior and RID construction were inspected, with no source
  copied.
- [libp2p hole-punching platform boundary](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md),
  [2026 large-scale DCUtR measurement](https://arxiv.org/html/2604.12484), and
  [ProbeLab's 2026 final report](https://github.com/probe-lab/dcutr-project/blob/main/docs/dcutr-final-report.md)
  - native relay-assisted evidence with conditional cohorts and explicit NAT-
  classification caveats, not a browser-WebRTC success rate.
- [2023 CGNAT survey and four-carrier mobile experiment](https://arxiv.org/abs/2311.04658)
  - small native mobile evidence, not a target-market coverage estimate.
- [Tailscale NAT traversal](https://tailscale.com/blog/how-nat-traversal-works) and
  [2025 hard-NAT probing](https://tailscale.com/blog/nat-traversal-improvements-pt-1) - native operational references; no code copied.
- [Grozev, *Towards a Scalable Video Conferencing System*](https://publication-theses.unistra.fr/public/theses_doctorat/2019/Grozev_Boris_2019_ED269.pdf)
  - one Jitsi profiling breakdown, not a coturn/LiveKit cross-system CPU ratio.

No GPL/AGPL code was copied. Published papers and specifications support design
analysis only; their presence here is not an implementation license.
