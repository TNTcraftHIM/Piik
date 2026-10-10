# Browser And Native NAT Traversal

Last reviewed: 2026-10-10

This document owns evidence for improving direct ICE without adding a
new relay or a custom transport. The current product contract remains standard
WebRTC ICE with STUN discovery and bounded SFU fallback.

## Confirmed Boundaries

- STUN discovers mapped addresses for ICE; it does not carry media.
- Chromium's shared UDP port sends to multiple configured STUN servers. Its
  tests retain two srflx candidates when the servers report different mapped
  addresses and deduplicate the result when they report the same address.
- A STUN operator observes the client's source address, source port, request
  time and protocol metadata. It never receives the DTLS-SRTP media path. An
  external STUN endpoint is therefore a metadata dependency, not a media relay.
- The current `STUN_URLS` wire already accepts a bounded list. Adding an
  auxiliary STUN destination needs no client compatibility surface, but it has
  no product value until a valid Browser observation or prediction consumer
  exists.

On 2026-08-31, Chrome 151 on Windows gathered a host plus IPv4 srflx candidate
through the self-hosted STUN endpoint and independently through Cloudflare's
official STUN endpoint while the machine used TUN and fake-IP DNS. With both
configured, Chromium emitted one deduplicated srflx candidate. No raw address or
port was retained. This proves endpoint reachability and candidate
deduplication; it does not classify the NAT or prove another direct path.

### SFU Behind Server NAT

An isolated Linux kernel-NAT control on 2026-10-09 places the current Server
behind same-port UDP forwarding with `SFU_PUBLIC_IP`; direct access to its private
address is blocked. Chromium 152 Host/Viewer pages use the real SFU route owners
and authenticated signaling under `SFU_ONLY`. VP8/Opus reception, 720p-to-480p
changes, fresh decoding after Viewer reauthentication and retirement all pass.
Windows Native H264/Opus also passes through QEMU UDP forwarding and the Linux
NAT, decoding 300 720p frames in Chrome 154, changing to 480p, recovering its
subscription and reauthenticating after local media loss. The App captures a
dedicated generated window; this does not reproduce a phone or carrier network.

The published v1.9.2 Windows App/capture and Linux Server artifacts, verified
against their release hashes and paired with that revision's Browser source,
also pass this Native H264/Opus startup control: 300 decoded 720p frames, a 480p
change, subscription recovery and retirement. This original-release control
excludes reauthentication after lost local media, which has a separate confirmed
repair below. The desktop control does not establish physical phone or carrier
network coverage.

Blocking only the Viewer process's UDP preserves connected Host ingress and
LiveKit's `downtrack bound`, but the Viewer remains connecting without RTP or
decoded frames. Its transport fails after about 15 seconds and the controller
rejects that candidate without committing a publication. Thus binding plus
healthy ingress cannot establish Viewer readiness or a controller defect.
A separate control discards only the Viewer's RTP/RTCP datagrams while allowing
STUN and DTLS. Both endpoints connect and the exact subscription binds, but no
Viewer frames arrive; the existing 20-second operation deadline then expires.
Connected endpoints, a bound track and an operation timeout do not identify a
unique cause; diagnosis requires the affected Viewer's transport/decode evidence.
Neither control changes a product deadline, retry or first-frame rule.

## Browser Prediction Preflight

A 2026-09-01 Chrome 151 preflight repeated the combined self-hosted plus
Cloudflare STUN gathering in six fresh PeerConnections. Each STUN destination
produced an srflx candidate when tested alone, while every combined run exposed
only one deduplicated srflx endpoint. The only valid mapping result remained
`unknown`; individual reachability does not make a single combined candidate
positive evidence of EIM.

One ICE restart exposed a different srflx endpoint in that environment, and a
synthetic standards-shaped remote srflx candidate using a documentation address
was accepted by `addIceCandidate()`. The first observation proves only that a
new mapping can occur: WebRTC specifies new ICE credentials and a new gathering
phase, not a new socket or mapping on every implementation and network. The
second proves candidate syntax only; it does not prove that a predicted NAT
mapping receives an authenticated connectivity check. The probe retained no raw
address or port.

This preflight also leaves the Browser-only mapper without an ordered port
delta. Candidate events expose response completion, while configured STUN order
does not specify the NAT allocation order. A disposable namespace matrix then
provided the controlled gate: its four-by-four baseline matched the expected
reachability classes, and bounded prediction improved sequential-to-restricted
connectivity in 14/15 runs. Sequential-to-sequential pairs still depended on
candidate ordering and remained sensitive to intervening mappings. The result
supports an opt-in mechanism, not a default or a participant-wide classifier.

## Current Decision

An ordinary STUN endpoint remains the discovery service. A Site may enable
same-host STUN-only listeners on 3479 and 3480. Public-link App mode supplies
one ordinary public endpoint plus two public survey destinations; pure LAN mode
supplies none. Available authorities expose the same per-share Host switch,
which defaults on and remains locked while sharing.

The accepted adapter is deliberately connection-local and additive. It waits for a
clear three-point arithmetic `srflx` shape in one ICE generation, and appends a
small two-sided candidate window from the observed port-sequence endpoint.
Ordinary candidates trickle immediately, so unavailable auxiliary listeners
cannot hold back stock ICE. There is no NAT label, hard candidate skip,
route-controller input, or SFU preference. Browser candidates are filtered by
their reported STUN URL. Native uses Pion's STUN client over its ordinary UDP
mux, so every fresh observation and subsequent media packet uses one socket.
Only explicitly marked Native survey observations feed prediction;
the independently mapped-port candidate does not. The switch applies to Host,
Viewer upstream, and Viewer relay P2P connections. Its exact scope is recorded in
[ADR-0009](../adr/0009-optional-nat-prediction.md).

Browser and Native candidate adapters use the same generation-scoped predictor;
Native observations do not need a second Go predictor. Predictions can trickle
as soon as the third qualifying survey observation arrives. Route scheduling
continues to use the operation deadline in ADR-0005, independently of whether
prediction produces candidates.
On an ICE restart, discard the old prediction batch rather than emitting an
unscoped end marker into the new generation. The real gathering owner supplies
completion, following [Trickle ICE generation rules](https://www.rfc-editor.org/rfc/rfc8838.html#section-13).
An earlier remote description is not readiness for a new generation's candidates.
Native event delivery can precede its offer/answer response; the existing
negotiation queue retains those candidates until the matching answer is applied.

The Browser queue must also isolate a candidate-processing `OperationError`.
Fault injection showed that one rejection formerly skipped later candidates in
both Host and Viewer queues and could prevent the Viewer's SDP answer. Chrome
152 independently rejected a mismatched media identifier while the connection
still succeeded with valid candidates. The shared receiver now records that
individual rejection and continues; missing-description errors are not hidden.
This agrees with [WebRTC candidate processing](https://www.w3.org/TR/webrtc/#dom-peerconnection-addicecandidate)
and does not establish the cause of undiagnosed field route failures.

### Native Shared-Socket Preflight

Each Native connection requests a dual-stack wildcard UDP socket through Go and Pion's existing
UDP mux. IPv4 remains usable on IPv4-only systems, and concrete IPv4 bindings
remain IPv4-only. Usable IPv6 interfaces can supply direct ICE candidates on the
same port; IPv4 discovery, prediction and gateway mapping retain their current
owners. IPv6 does not remove firewall restrictions or prove a reachable peer.

On 2026-09-05, the unmodified Pion srflx gatherer contacted three public STUN
destinations from three different temporary local ports, despite the media
engine's ordinary UDP mux. This invalidated the prior assumption that Native
STUN and media already shared one socket. Pion ICE's `UniversalUDPMux` was then
used as the media mux and direct STUN observation owner. Its emitted srflx
candidate reported the exact Engine listener as its related port.
That initial-gathering check did not establish mapping freshness when the same
Engine survived a later retry; the [cache correction](#native-mapping-cache-and-retry-lifetimes)
retains the socket while replacing completed observation reuse.

The same build carried a public-link session to an independent Linux Pion
Viewer: 35 H.264 RTP packets arrived over a selected direct host-to-srflx pair,
while the Quick Tunnel carried signaling only. The active TUN network yielded
one distinct mapped endpoint across the public survey, so no port sequence or
prediction was claimed. The result proves shared-socket discovery and transport,
not public-survey availability or a predicted-path success rate.

Native Site and public-link P2P connections also request one PCP, UPnP, or NAT-PMP
mapping for that same socket. The returned port is advertised as a
lower-priority candidate using a public address already observed by ordinary
STUN. This is additive and bounded; a VPN, double NAT, or absent mapping service
can make it unusable without delaying or replacing ordinary ICE.
Gateway preparation runs alongside ordinary gathering. Each survey destination
resolves and sends Binding independently within one shared deadline; an unhealthy
DNS target cannot withhold a healthy target's result. End-of-candidates follows
both the ordinary gatherer and the bounded supplemental work, and retirement
discards that gathering generation's late output.
A local UDP-forwarding gate then withheld every ordinary Host candidate and
connected Pion ICE/DTLS in 1.26 seconds through the advertised `mp1` endpoint.
That proves the same-socket ICE mechanism, not rescue through a physical NAT.

### Gateway And Survey Limits

The root module uses [scoped local repairs](../../internal/thirdparty/README.md)
for `go-nat` and its NAT-PMP client. The unmodified upstream revisions discard
gateway-assigned ports, send no deletion and ignore context cancellation.
The repaired adapter retains `MappedExternalPort` on creation and renewal,
sends lifetime-zero deletion under [RFC 6886](https://www.rfc-editor.org/rfc/rfc6886.html#section-3.4),
and propagates discovery, mapping and deletion cancellation to socket I/O.
Packet-level loopback regressions cover reassignment, renewal, deletion,
cancellation and the existing PCPv6 combination. They do not establish physical
router coverage or a higher field connection-success rate.

Piik bounds a mapping caller's wait to three seconds. Connection retirement
cancels both discovery and pending creation; a canceled owner cannot start a
later mapping request. Cleanup has its own deadline because it must still run
after cancellation. PCPv6 rollback can
finish after that wait, so cleanup must wait for the in-flight gateway call
before accessing its bookkeeping. A connection does not relaunch failed mapping
requests. Replacement connections have independent sockets and rediscover their
gateway; one connection's failure does not disable later attempts. Close attempts
deletion even after a failed request, because losing a
reply does not prove the router rejected the mapping. Cleanup is best effort:
an unreachable gateway or unsettled rollback can leave a lease to expire.
Caller cancellation and router lease expiry remain distinct lifecycle boundaries.
The gateway selector and its NAT-PMP/PCPv6 combination retain one mapping owner;
ordinary ICE candidates remain independent.

Binding all three STUN listeners proves local startup, not public reachability.
A local self-probe also cannot prove traversal through an operator's firewall.
Missing prediction may reflect unreachable survey destinations or insufficient
distinct mappings. Library packet logs remain disabled because they expose
remote addresses; future health summaries must retain that privacy boundary.
Candidate provenance, selected paths and connection outcomes already have Debug
owners. Count emitted candidates separately from successful connections; zero
predicted selections alone does not establish a broken predictor or a success
rate. Further observation work belongs to [TODO](../todo.md).

### Independent Observation And Attribution Preflight

On 2026-09-01, Chrome 151 on the flagship Windows network gathered one `srflx`
candidate independently from the self-hosted endpoint, Xiaomi, Bilibili, and
Cloudflare within a five-second bound. `stun.qq.com:3478` produced none in the
same ordered run. Candidate events and local candidate stats preserved the exact
STUN `url`, but the destinations supplied no selected-path benefit. They remain
research evidence only; the product has no independent or third-party STUN
configuration.

A second real-Chrome loopback rewrote only one remote candidate foundation to
`sp1`, established the data channel, and read `sp1` from the selected remote
candidate stats. The product can therefore report `predicted | ordinary |
unknown` selection without retaining or uploading addresses, ports, foundations,
or STUN URLs. Field acceptance still requires target-network outcomes; this
preflight proves the attribution mechanism, not prediction prevalence.

The first flagship field runs emitted six predicted candidates in one 8545
generation and selected none. Later 8545 and 5643 generations did not form the
required arithmetic survey shape, so no prediction was emitted. This is
negative prevalence evidence, not a regression: ordinary ICE and SFU fallback
remained independent. The flagship deployment enables the bounded capability
to continue attributable field observation without claiming a demonstrated
reachability gain.

Background P2P acquisition behind SFU uses the same bounded opportunity budget
as foreground acquisition under [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md).
Fresh connection attempts do not guarantee a new socket, mapping or predictable
port sequence; field measurements must attribute the selected path to its actual
connection generation.

The Browser-only alternatives do not yet have an accepted implementation:

- WebRTC ICE already exchanges observed candidates and performs coordinated
  connectivity checks. libp2p's mature hole-punching specification explicitly
  keeps private Browser peers on WebRTC because Browser code cannot own or
  reuse the underlying UDP, QUIC or TCP socket.
- Tailscale compares mappings observed by different STUN destinations, but
  keeps `MappingVariesByDestIP` as a tri-state network report. It retains an
  additional mapped endpoint only after repeated observation; it does not turn
  one NAT label into hard connection rejection or a predicted port.
- A second STUN destination supplies an observation, not a new path through an
  endpoint-dependent NAT. Deploying it without a consumer adds metadata
  exposure and candidate traffic without proving more direct connections.

The Browser API is also weaker than the raw-socket netcheck model:

- Different srflx endpoints prove only that the current Browser socket's mapping
  varied by destination. An identical endpoint is deduplicated before the
  application sees it, so one emitted candidate cannot distinguish stable
  mapping from a second STUN destination that did not answer.
- Candidate events expose response completion order, not a specified STUN send
  or NAT allocation order. Sorting by configured URL or event time cannot turn
  observed ports into a standards-backed sequential delta.
- ICE restart creates a new generation and may use a new socket. Network
  interface, VPN/TUN route and CGNAT allocation traffic can all change between
  generations.

Consequently Browser observations can support a positive `varies` diagnostic,
but cannot produce the proposed `eim | edm-sequential | edm-random` participant
fact. They cannot safely remove a Peer candidate or alter route ordering and
deadlines.

Port prediction remains additive rather than an assumed path. The controlled
namespace matrix supports the bounded mechanism, but field prevalence,
direction, and resource impact are not established. Configuration therefore
stays off by default even though the flagship deployment explicitly enables its
field rollout.

## Rejected Product Inference

Multiple STUN destinations can expose whether one current socket received the
same or different mappings. They do not establish a stable participant-wide NAT
type:

- RFC 5780 behavior discovery requires carefully controlled alternate address
  tests, warns that adding destinations can change observed behavior, and says
  results can vary by source port or become more restrictive later.
- Mapping behavior does not reveal filtering behavior. A Browser cannot infer
  that a Peer pair is impossible from mapping samples alone.
- A global `eim | edm` fact would cross connection generations, interfaces,
  VPN/TUN routes and physical network changes that own different sockets.

Therefore NAT samples must not skip a P2P candidate, alter the committed graph,
or become a persistent participant capability. Successful `addIceCandidate()`
parsing proves only candidate syntax; it does not prove that a predicted mapping
receives authenticated ICE checks. The accepted experiment keeps this boundary:
it adds no protocol fields or controller state and falls back to ordinary ICE
when its shape test is inconclusive.

QUIC on UDP 443 does not change this Browser boundary. WebRTC's ICE agent owns
its UDP sockets and candidate checks; the Web application cannot replace that
transport with a custom QUIC hole-punching socket. LiveKit may use its own
supported WebRTC transport configuration, but that is the bounded SFU path, not
a new Peer route.

## Iroh And Tailscale Comparison

Iroh's [NAT guide](https://docs.iroh.computer/concepts/nat-traversal) estimates
direct reachability for roughly nine in ten network configurations. It does not
provide a matched 70%-to-90% before/after measurement against Piik or its ICE
stack. Tailscale also [reports direct success above 90% in typical conditions](https://tailscale.com/blog/nat-traversal-improvements-pt-1);
that figure explicitly counts direct connections, not relay-only success.
Keep direct success separate from the
[relay fallback](https://docs.iroh.computer/concepts/relays) that carries traffic
when hole punching fails; neither statistic transfers to our user population.

| Mechanism | Piik comparison |
| --- | --- |
| Exchange endpoints and coordinate outbound probes | Existing room signaling plus Browser/Pion ICE connectivity checks. |
| Discover and use the same UDP mapping | Each Native connection shares its Pion UDP socket across fresh STUN discovery, prediction and media; Chromium owns Browser sockets. |
| IPv4/IPv6 and gateway mapping | Native dual-stack candidates and bounded PCP/NAT-PMP/UPnP already exist; actual availability depends on the network. |
| Switch between direct and relay paths | Iroh manages QUIC paths; Piik hands off WebRTC edges through one room-route operation. These are different contracts. |
| Relay data over TLS/TCP when direct UDP fails | Iroh and Tailscale provide this. Piik currently has optional SFU/UDP, while App public invitations remain P2P-only. This is a coverage difference, not a missing prediction formula. |

[Tailscale magicsock](https://github.com/tailscale/tailscale/blob/main/wgengine/magicsock/magicsock.go)
is implemented in Go and is integrated with WireGuard, peer discovery, network
maps and DERP. Its language is not an obstacle, but it is not an interchangeable
Browser ICE socket. Iroh's current
[Browser implementation](https://docs.iroh.computer/languages/wasm-browser)
requires relay traffic; it cannot directly hole-punch from the Browser sandbox.
Adding either stack would require another transport/interop and deployment
boundary, not just replacing a NAT helper.

Use their [network-change and mapping-recovery work](https://tailscale.com/blog/nat-traversal-improvements-pt-1)
as evidence prompts for existing ICE/gateway owners. Iroh's
[asymmetric hard-NAT repair](https://www.iroh.computer/blog/iroh-1-0-0-rc-1)
also reinforces testing both initiator directions. A future comparison should
hold endpoint pairs, NAT/filtering, IPv6, network transitions and relay policy
constant, measuring direct success, relay use and first media separately.
No new transport or universal success-rate claim is accepted by this review.

The [retired Go experiment](#integration-cost-and-recovery-controls) establishes
reuse feasibility and its cost, not a Browser-compatible reachability gain.

### Browser-Compatible Follow-Up

The product target remains App-to-Browser and Browser-to-Browser sharing without
requiring every Viewer to install software. Existing IPv6, bounded gateway
mapping and standard ICE can benefit those edges; a new transport must be judged
against that same endpoint pair and relay policy.

- The [2026 DCUtR paper](https://arxiv.org/abs/2604.12484) covers 4.4 million
  attempts across more than 85,000 networks, collected in December 2022 through
  January 2023. Its roughly 70% success is conditional
  on relay reservation and address discovery; 97.6% of successful punches occur
  on the first attempt. These are libp2p results, not a Piik baseline. They justify
  separating preparation failures from hole-punch failures and measuring the
  marginal benefit of retries, not copying a retry count or replacing ICE. Its
  proposed role reversal and probabilistic port probing are future work, not
  measured improvements in that campaign. Standard full ICE already checks in
  both directions; a QUIC initiator-role proposal is not evidence for changing
  Piik's Host authority or adding another retry owner.
- [QUIC hole punching and migration](https://arxiv.org/abs/2408.01791) reports
  shorter connection/restoration latency than its TCP/re-punching controls.
  It does not demonstrate a drop-in improvement for Browser WebRTC. Current
  [WebTransport](https://www.w3.org/TR/webtransport/) targets Browser-to-server
  transport; it is not an arbitrary UDP socket for Magicsock.
- [ICE renomination](https://datatracker.ietf.org/doc/draft-thatcher-tsvwg-renomination/)
  proposes changing the selected candidate pair without a full restart. It
  remains an Internet-Draft. The tested Pion WebRTC v4.2.19 already exposed
  `SetICERenomination`; Piik does not enable it. That ICE v4.4.0 implementation
  references an earlier draft and automatically probes and reselects candidate
  pairs. Verify wire-version agreement, Browser interoperability, probe cost and
  recovery benefit before enabling it. This targets path changes after connection,
  not a demonstrated increase in initial NAT reachability. Keep selection in the
  framework; do not add a Piik path-selection loop.
- [Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets) is
  restricted to explicitly installed Isolated Web Apps. It does not remove the
  installation requirement for an ordinary invitation page.
- [SPED](https://datatracker.ietf.org/doc/draft-hancke-webrtc-sped/) carries DTLS
  handshake data in STUN so ICE and encryption setup can overlap. Its target is
  setup latency and handshake loss recovery, not newly reachable NAT classes.
  The March 2026 individual draft is expired as of this review; implementation
  interest does not establish interoperable product support. Evaluate only
  framework-owned negotiation and stock Browser builds, retaining authentication
  and ordinary fallback. A Browser field-trial flag is not an adoption path.
- The July 2026 [WARP draft](https://datatracker.ietf.org/doc/html/draft-uberti-tsvwg-warp-00)
  combines SPED, SCTP setup negotiation (SNAP) and DTLS 1.3. Its combined model
  reduces media-and-data setup from six round trips to two; media alone starts
  after four round trips in its baseline. These are handshake savings, not
  evidence that previously unreachable NAT pairs connect. Pion's
  [ICE v5 release candidate](https://github.com/pion/ice/releases/tag/v5.0.0-rc.6)
  already contains SPED/DTLS 1.3 work, so an expired individual draft does not
  imply abandoned implementation. Follow stable framework support and negotiated
  stock-Browser interoperability before a latency comparison; this assessment
  does not accept a prerelease transport upgrade or changes to ICE consent.

#### Stable Pion Interoperability

The candidate uses Pion WebRTC v4.2.23 / ICE v4.4.7. The
[upstream changes](https://github.com/pion/ice/compare/v4.4.0...v4.4.7) include
STUN retransmission, gathering-generation ownership, Chromium mDNS compatibility
and pre-created mux lifetime corrections. This updates the shared Native/SFU
composition; ordinary Browser-to-Browser ICE remains Browser-owned.

A controlled Chrome 152 check reproduced the
[mDNS query incompatibility](https://github.com/pion/mdns/commit/5b0a717e4ff6e81300d54ce2fef53e635b95fe3c):
after the Browser's initial announcement, a fresh v2.1.0 resolver could not resolve
its generated `.local` candidate before the fixture's four-second deadline.
v2.2.2 resolved the same name in about 12 ms; another fresh old resolver still
timed out. The upstream repair sends separate A/AAAA questions without the
unicast-response bit that Chromium rejects. This fixes an address-resolution
boundary useful to App-to-Browser edges; it is not a field success-rate result
or proof of the cause of an unmatched report. Peer-reflexive discovery can also
let a connection succeed despite failed mDNS resolution.

The package-major adaptations retain Pion's STUN transaction owner and SRTP
buffer bounds/attributes. LiveKit forwarding and the existing ICE recovery
owners remain unchanged. Chrome 152 and Firefox 151.0.3 recovered synthetic VP8,
reverse RTCP and echoed data through ordinary ICE restart after the selected
UDP path was cut. Shared forwarding, Native edges, SFU and STUN tests passed,
including Linux race checks and a disposable-namespace interface-replacement
control. No new automatic renomination, probing loop or retry budget is enabled.

Keep Piik's fresh-interface mux and connection-owned STUN/mapping repairs: the
newer framework still snapshots its default interface view and caches successful
universal-mux observations. An upstream release-note match is not sufficient to
remove these protections. Physical network/device coverage remains in
[verification status](../verification-status.md#remaining-device-and-network-acceptance).

#### Pion Renomination Preflight

The current decision is not to enable automatic renomination. An isolated
two-UDP-path control with pinned WebRTC v4.2.19/ICE v4.4.0 cut the selected socket
after stable VP8 playback. Chromium 152 recovered video and reverse feedback
without new SDP after about 5.6 seconds. Firefox 151.0.3 repeatedly resumed video
after about 5.7 seconds but retained the failed outbound candidate: RTCP reception
and echoed data stopped for the full 20-second observation while new video kept
decoding. An explicit ICE restart on that same connection selected the surviving
path and restored both reverse flows. The stock-ICE controls also recovered
through restart.

Both Browsers answered with only `trickle`; the enabled Pion call nevertheless
sent the older nomination attribute. Thus receiving new frames alone cannot
establish compatible path migration. In these fixtures, steady Binding requests
also rose from 3 to 27-75 per five seconds, depending on interface enumeration.
These are local transport controls, not physical-network success measurements or
a defect in Piik's currently disabled feature. Reopen only for negotiated Browser
support and bounded probe/recovery behavior; do not add UA exceptions, a second
recovery loop or a Browser fork to enable this option.

### Integration Cost And Recovery Controls

**Current decision: no-go for the 2.0 candidate.** This composition requires
Native App transport at both ends of the enhanced edge. An App Host with a plain
Browser Viewer still uses ordinary WebRTC; mixed relaying does not enhance that
Browser edge. The owner stopped integration and field-package work. Reopen only
for a concrete Browser-compatible benefit or an explicitly accepted App-only
scope. The controls established no additional reachable NAT class.

The isolated experiment remains at `d67f0d6d` on
`spike/magicsock-assessment`, outside Piik's production dependency graph.
`git show d67f0d6d:scripts/tailcat-probe/README.md` retrieves its commands,
fixture boundaries and opt-in dependency patches. The complete experimental
observations remain in `git show 82e3f253:docs/research/nat-traversal.md`.
Its internal package is retired, not a current 2.0 test deliverable.

#### Reachability And Cost

The October 5-10, 2026 controls used
[Tailcat](https://github.com/tailscale/tailcat/blob/b4dc28e8aa8936f0a90a41ad8293a64e3d6b645f/README.md):
Magicsock/WireGuard with DERP bootstrap and relay fallback. Its Browser path at
that pin is relay-only. Tailscale's
[Browser P2P proposal](https://github.com/tailscale/tailscale/issues/21027)
uses WebRTC; it is not an implemented Browser Magicsock hole-puncher.

| Controlled question | Result and boundary |
| --- | --- |
| Does it reach more NAT classes than fresh ordinary ICE? | In the initial kernel-NAT matrix without a usable gateway mapping, both connected directly through ordinary/ordinary and open/hard gateways in either direction. Neither established direct media through the other tested hard/blocked combinations within the observation windows. DERP delivered otherwise unreachable cases, establishing relay coverage rather than additional P2P coverage. |
| Does network-change handling help? | Some local-address changes recovered on the same session without new SDP. Gateway-only rebinding and longer interruptions had separate discovery/recovery failures. These results do not establish physical roaming, a universal recovery improvement or increased initial reachability. |
| Does it coexist with ordinary ICE? | An isolated optional multi-mux composition retained ordinary media with bootstrap unavailable and used a delayed tunnel candidate when needed. It required dependency patches and readiness/cancellation integration; it is not a supported plug-in. |
| What is the bounded cost? | Matched stripped Windows App builds grew from 44.1 to 59.8 MiB. A local four-Viewer full-App comparison peaked at 81.8/93.2 MiB RSS for ordinary/optional modes; final goroutines returned to the same baseline. Codec and Browser processes were separate. These are not sustained or per-room budgets. |

Closing DERP removes endpoint exchange as well as relay media. Later controls
therefore retained discovery and counted encrypted relay traffic separately;
a selected direct address alone was insufficient. Tests required fresh media
and either no relayed data or continued delivery after relay closure. The
Native mapping, prediction and dual-stack controls are retained
[below](#gateway-and-address-family-controls).

#### Integration Boundaries

The experimental composition exposed costs that a future adoption must address
without another retry owner, timeout extension or silent relay policy change:

- **Relay policy:** the reviewed upstream API has no direct-only media policy
  retaining discovery. An isolated overlay filtered encrypted data in both
  directions while allowing discovery/handshakes. This is not an accepted
  product mechanism; disabled UDP must not silently become DERP media.
- **Startup and recovery:** outer discovery can outlast the inner ICE check
  budget. A diagnostic `DiscoPing` reply did not prove bidirectional media
  readiness. Experiments with more checks, extra prefaces and readiness probes
  did not establish a universal fix. Initial advertisement also needed an
  isolated dependency correction to send direct probes before relying on the
  peer's stateful firewall. Ordinary ICE must remain independently usable.
- **Datagram bounds:** Tailcat's reviewed payload ceiling is 1232 bytes. Actual
  encrypted TWCC reports reached 1244 bytes, with compound batches larger still;
  ordinary Pion delivered them while the tunnel did not. A delayed packet could
  grow a report despite a shorter feedback interval. The isolated recorder/writer
  split preserves statuses, but is not a supported upstream option. The
  [feedback-MTU issue](https://github.com/pion/interceptor/issues/416) and recorded
  dependency patches own this finding; reducing RTP size alone is insufficient.
- **Authorization:** the pinned Tailcat/WireGuard composition could retain a
  revoked inbound peer or install it from a late authorization result. Scoped
  experimental corrections passed revocation, unrelated-peer, sibling-media
  and race controls. Piik's production transport does not use these dependencies;
  the result is an adoption requirement, not a published Piik defect.
- **Flow ownership:** unrelated listener changes could discard an existing
  inbound filter entry. Duplicate client identities could collide at DERP;
  close-before-initialization was not terminal. Isolated repairs preserved
  filter state, used fresh parent-bound clients and joined canceled creation.
  New media flows must retire through their existing connection owner.
- **Optional candidate lifecycle:** stock multi-mux construction and supported
  dialing do not independently provide the required delayed socket admission.
  A private reservation API plus the existing candidate collector kept ordinary
  ICE independent, advertised the tunnel only when ready, fenced cancellation
  and delayed end-of-candidates. Its multi-mux also needed a correction for
  newly enumerated child addresses. These remain experimental dependency changes.

#### Scope Of The Retained Evidence

The isolated overlays exercised real Pion/LiveKit forwarding, H264/VP8 and Opus,
Browser decoding, Native control and room authorization. Bounded rendered checks
covered reconnect, invitation revocation, overlapping parent replacement,
healthy siblings, denial at the room capacity limit and final resource cleanup.
Generated changing pixels distinguished fresh output from retained frames.
The final full-App controls could select the tunnel with ordinary remote
candidates withheld, while ordinary Web edges retained ICE.

Those checks established local composition and ownership behavior. They did
not establish physical capture, difficult-network benefit, broad mobile support
or sustained field reliability. The experiment's detailed intermediate controls,
failed counterfactuals and package evidence remain in Git rather than this
candidate's work ledger. Independent ordinary-media findings are retained here
and in their existing owners.

## Ordinary ICE And Media Recovery

These findings apply without Magicsock. They must remain part of candidate
acceptance independently of the retired experiment.

### Interface Refresh And Local Browser Bridge

The local restart control reproduced an address-cache defect: Pion ICE v4.4.0's
[wildcard UDP mux](https://github.com/pion/ice/blob/v4.4.0/udp_mux.go) retained its
own `stdnet.Net` interface snapshot across gatherings. After an interface address
changed, both ICE restart and a new SFU connection sharing that mux could
advertise the removed address. The shared mux now takes a private current
snapshot when gathering. Socket identity and Pion's candidate filters remain;
no monitor or timer is added. The regression covers both restart and a new
connection, and restoring the former constructor fails on the stale candidate.
The [stable Pion update](#stable-pion-interoperability) still needs this adapter.

Forcing the same-machine Browser bridge to loopback is not a portable solution.
A Windows control decoded through `127.0.0.1` in Chrome 154 but failed in
Firefox 155; Firefox decoded using the current wildcard bind and a non-loopback
pair. Mozilla keeps
[ICE loopback disabled by default](https://searchfox.org/firefox-main/source/modules/libpref/init/all.js).
These observations establish a compatibility limit, not every Browser permission
or public-Site behavior. Keep the existing address policy.

Complete App controls on October 10, 2026 reproduced the consequence in a
disposable Linux namespace. Chromium 152 retained its loopback bridge after a
LAN address change. Firefox 151 selected the removed LAN address: its Host
ended an otherwise healthy share, while its Viewer eventually used Browser
fallback. Fresh rendered frames, rather than accumulated frame counts, were
used for acceptance. The source was generated VP8 through the real capture
process boundary, not physical capture.

The corrected existing bridge owner performs standard ICE restart after a
three-second disconnect grace or immediately on failure. Initial and restart
negotiations use complete SDP and fence answers by request ID. The eight-second
negotiation bound includes up to five seconds of Native gathering; retirement
cancels it. Existing Host/Viewer terminal owners handle failure, and paused
sources need not produce frames to establish the transport connection.
There is no second local candidate queue or recovery controller.

Matched controls retained the same Firefox Host and Viewer tracks through the
address change. Host sharing and downstream decoding continued; the Native
Viewer recovered without a route replacement or Browser fallback. Chromium
retained its working loopback leg. Replacing only the Native PeerConnection,
while keeping the Browser connection, instead reported connected without fresh
pictures in a counterfactual. The tests therefore support standard ICE restart,
not unilateral reconstruction or a claim of physical roaming coverage.

### Recovery Ownership And Forwarding

A real Viewer-owner fixture retained sockets and external conditions through
interruption and replacement. It exposed recovery counts being renewed with a
new Native/Browser backend, permitting an extra request. The corrected budget
belongs to the parent opportunity, as specified by the existing
[recovery owner](../standards/routing-transport.md#reconciliation).
Trickle-exchange controls recovered ordinary Pion after two-, nine- and
eleven-second interruptions in three runs each. A full-gathering fixture failed
while the network was unavailable; that negative control was a fixture limit,
not evidence for extending product deadlines.

A separate live Windows VP8/Native forwarding control exposed stale decoded
pictures after roughly one second of UDP loss: hundreds of already-encoded
packets remained in the former throttled queue. Forwarder frame counts preceded
actual paced writes and could not prove delivery. With the upstream default send
queue and the local playback leg isolated, all six ordinary/experimental
unchanged, address-change and short-loss controls retained fresh decoded
content after relay closure. The
[send-queue assessment](./node-local-media-design.md#send-queue-recovery)
owns the constrained-bandwidth comparison and adopted correction. This is not
proof that every brief blur or unmatched interruption shares that cause.

The same full-room work found a denied Viewer retaining its App control slot
across repeated invitation generations. The
[control-retirement assessment](./native-client-lifecycle.md#viewer-control-retirement)
owns that independent repair and its rendered acceptance boundary.

### Gateway And Address-Family Controls

The actual Native `mediaedge.Engine` Host/Viewer also ran through Linux kernel
gateways with local playback and the unchanged TypeScript predictor. Three race
repetitions required distinct generated VP8 RTP, excluding padding and duplicate
packets. Without a gateway service, best-effort mapping did not block ordinary
media behind discovery. Either usable IP family carried media when the other
was blocked. Sequential-port NAT failed without prediction and used a predicted
candidate when enabled, with the changing-port gateway on either endpoint;
random-port NAT remained unreachable in the bounded controls. A real MiniUPnPd
gateway made a hard/hard pair reachable with mapping enabled.

These are encoded-media controls, not physical capture, Browser decode, complete
room admission or a new field-success measurement. The matched Tailcat controls
needed its optional portmapper module and a fair multi-region STUN projection;
they still established no additional direct path. Existing mapping, prediction
and IPv6 should be assessed against the same endpoints and relay policy before
another mechanism is proposed.

## Native Mapping Cache And Retry Lifetimes

Pion ICE `v4.4.0` caches a shared socket's STUN mapping by destination for 25
seconds. The former Native Host/Viewer Engine socket outlived its media edges;
edge replacement and ICE restart did not invalidate that cache. Browser-only ICE
does not use it. Piik's default route-operation deadline is 20 seconds, while
committed-edge recovery has three-second steps. These are distinct lifetimes:
a new connection or new ICE credentials do not promise a new public port.

On 2026-10-04, a loopback check through Native `Engine.NewEdge`, `CreateOffer`
and edge replacement re-emitted the old `ns` candidate after the STUN fixture
changed its mapping. Replacing the Engine queried the new mapping. An isolated
Pion virtual-network comparison then kept sockets/muxes alive and expired one
NAT mapping: four fresh-agent attempts within the cache lifetime failed against
address-and-port filtering, then fresh gathering after expiry connected. An
unchanged mapping connected with the cache, and an independent-filtering peer
recovered through peer-reflexive discovery despite the stale advertised address.
The one-second virtual lease injected mapping loss; it does not establish a
typical router lease or the cause of an unmatched field report. The fast lab
attempts also do not represent four full 20-second product operation timeouts.

The correction keeps Pion's ordinary UDP mux and uses the existing Pion STUN
client for each observation. Only concurrent in-flight queries to the same
destination are shared; completed addresses are not cached. Pion owns request
transaction matching and retransmission within the existing five-second survey
bound. A caller can stop waiting independently; connection retirement ends discovery.
ICE restart retains its socket. The separate overlap correction below isolates
replacement connections without adding a retry loop, periodic probe or new transport.

The same review reproduced acceptance of an unmatched STUN response in the old
universal cache path. Stock STUN transactions reject it and recover a dropped
Binding response. Native edge replacement and receiver ICE restart now query
again while ordinary SDP renegotiation keeps its collector. Regression checks
exercise a healthy encoded-media sibling, concurrent/canceled gatherings,
Engine shutdown and both address families. Replacing only the implementation
with the prior revision makes the address-refresh and transaction tests fail.
These controlled checks do not assign a cause to unmatched field reports.

The missing case in the earlier shared-socket preflight was a retained Engine
whose router mapping changed between gatherings. Proving one socket, a new
connection ID, or new ICE credentials did not prove a fresh library observation.
Recovery checks must retain the resources production retains while changing the
external condition; recreating everything would hide this cache boundary.

The same lifetime review found gateway mappings were reused until half their
requested lease elapsed. A router restart can lose that mapping sooner. Each
actual gathering now refreshes a successful mapping through the existing bounded
gateway owner; ordinary renegotiation does not. A retained-owner fixture changes
the allocated external port between gatherings and verifies the new result.
Failed attempts still obey the existing cancellation and cleanup rules; this
adds no periodic renewal loop or claim of improved field success rates.

A separate Chrome 152 Windows loopback probe on 2026-10-04 changed a STUN
fixture's reported mapping across four gatherings on one PeerConnection and
four replacement PeerConnections. Every gathering sent a new Binding request
and emitted only the current mapping; a lost valid response plus an unmatched
transaction response recovered through retransmission in both sequences. This
checks real Browser candidate gathering, not a connected media session, a
physical NAT mapping change, Firefox/Safari behavior or field success rate.
The scoped review also retains the controller's four-attempt, final-candidate
deadline and stale-event checks; slow DNS and gateway preparation do not hold
ordinary candidates. Those boundaries do not establish exhaustive traversal
coverage or justify a claim that no implementation can limit connectivity.

## Native Connection Socket Ownership

A real Native-to-Native overlap reproduced a second shared-resource defect:
the first connection delivered encoded video, the candidate connected, then the
current connection stopped receiving RTP. Both connections had the same local
and remote UDP tuple. Pion's mux routes non-STUN traffic by remote IP and port;
new ICE credentials do not separate those DTLS/SRTP sessions. This is also an
[upstream-documented limitation](https://github.com/pion/webrtc/discussions/2598).
The old fan-out check used a separate remote socket for each receiver and could
not expose this Native-to-Native boundary.

Each Native send, receive and SFU publication now owns its socket. STUN, optional
gateway mapping and media still share that socket; an ICE restart retains it,
while a replacement allocates another. Encoded sources and the existing route
operation remain unchanged. Gateway cleanup precedes socket release so a late
delete cannot target a replacement's recycled port. Engine retirement closes
remaining owned sockets, including a preparation that fails before registration.

Regression checks exercise real ICE/DTLS/SRTP for two simultaneous Native routes
through commit and rollback, and two publications against one unchanged
SFU-style UDP listener through rollback. Surviving media continues. The Native overlap
test fails on the pre-correction product. Receiver renegotiation retains its
socket, source and downstream media; failed admission releases its reservation
and socket. IPv4, IPv6, canceled surveys and slow supplemental discovery keep
their existing checks.

An additional cancellation fixture showed pending mapping creation could retain
its three-second wait after connection retirement: only discovery inherited the
mapping owner's cancellation. Both now share that owner; the fixture verifies
prompt cancellation followed by bounded cleanup.

The cost is one ephemeral UDP socket and, when enabled, one gateway mapping per
physical connection instead of per Engine. Existing connection/copy limits bound
their number. This changes no public wire format, fixed service port or route
policy, and is not evidence that any unmatched field report has been resolved.

## Primary Sources

- [RFC 8445: Interactive Connectivity Establishment](https://datatracker.ietf.org/doc/html/rfc8445)
- [RFC 4787: UDP NAT behavioral requirements](https://datatracker.ietf.org/doc/html/rfc4787)
- [RFC 5780: NAT Behavior Discovery Using STUN](https://datatracker.ietf.org/doc/html/rfc5780)
- [IETF symmetric NAT prediction draft](https://datatracker.ietf.org/doc/html/draft-takeda-symmetric-nat-traversal-00)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
- [Chromium shared-socket STUN tests](https://webrtc.googlesource.com/src/+/refs/heads/main/p2p/base/stun_port_unittest.cc)
- [Tailscale netcheck mapping observations](https://github.com/tailscale/tailscale/blob/main/net/netcheck/netcheck.go)
- [libp2p Browser and DCUtR hole-punching boundary](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md)
- [coturn listener and auxiliary endpoint reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
- [Cloudflare Realtime STUN service](https://developers.cloudflare.com/realtime/turn/)
- [Pion Universal UDP mux](https://github.com/pion/ice/blob/main/udp_mux_universal.go)
- [Pion dual-stack candidate enumeration](https://github.com/pion/ice/blob/v4.4.0/udp_mux.go)
- [Go wildcard socket family selection](https://go.dev/src/net/ipsock_posix.go)
- [WebRTC selected candidate stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatestats-foundation)
- [Pinned go-nat NAT-PMP adapter](https://github.com/netbirdio/go-nat/blob/6b2c8c5c74e8331ed41811cfd2fdc4c3dd8c3ff0/natpmp.go)
- [NAT-PMP client timeout and mapping calls](https://github.com/jackpal/go-nat-pmp/blob/v1.0.2/natpmp.go)
