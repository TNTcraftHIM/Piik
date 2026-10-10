# Browser And Native NAT Traversal

Last reviewed: 2026-10-09

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

The initial Go control carried Pion ICE/DTLS/SRTP over magicsock and delivered
fresh media after both UDP endpoints changed without new SDP. Loopback and
separate address-and-port-filtering NATs passed five race repetitions. The
fixture supplied peer identities and endpoint updates; it did not prove automatic
OS network-change detection, decoded playback or real-router behavior. Its
seven-pair direct matrix matched Pion within four-second windows. Go reuse is
feasible; product integration and network benefit require the controls below.

### Integration Cost And Recovery Controls

The isolated `spike/magicsock-assessment` branch retains the comparison probes.
The nested modules are outside Piik's build. Local bootstrap, peer denial and
synthetic SRTP media checks passed. Initial withdrawal checks observed stopped
outbound media; the stronger authorization checks below found revocation defects.
The raw magicsock direct-path matrix found the same reachable classes as fresh
Pion ICE. Retired mapping-cache reproductions remain controls, not the baseline.

[Tailcat](https://github.com/tailscale/tailcat/blob/b4dc28e8aa8936f0a90a41ad8293a64e3d6b645f/README.md)
provides an upstream Go reuse candidate: magicsock plus WireGuard, with DERP bootstrap
and relay fallback. Its Browser path at that pin is relay-only. Tailscale's open
[Browser P2P proposal](https://github.com/tailscale/tailscale/issues/21027) uses
WebRTC because the Browser cannot expose raw UDP; it is not an implemented
Browser Magicsock hole-puncher. In the isolated
Linux kernel NAT comparison on 2026-10-05, both stacks connected directly through
ordinary/ordinary and open/hard gateways in either direction. Neither delivered
fresh direct payloads through ordinary/hard, hard/ordinary, hard/hard or blocked
UDP pairs within the observation window. Tailcat delivered those cases while
the fixture relay remained available. This demonstrates relay coverage, not
an additional P2P reachability class or a field success rate.

Relay policy remains a separate integration boundary. Tailcat's documented
fallback may carry media through DERP during startup or recovery. Closing DERP
or counting its packets in a fixture measures the path; neither enforces Piik's
product policy. The reviewed Tailcat API does not expose a direct-only media
policy that retains discovery. Disabling DERP also removes bootstrap/endpoint
exchange, and polling a direct-path status cannot authorize each later packet.

An isolated packet-policy overlay separates discovery and fixed
[WireGuard handshake messages](https://www.wireguard.com/protocol/#key-exchange-and-data-packets)
from encapsulated data. Blocked UDP carries no media; a relay-allowed peer's
incoming data is also rejected. Removing either direction's guard fails its
corresponding control. The ordinary-NAT Pion fixture delivered fresh direct SRTP
in an initial run but failed cold startup on a repeat, so it is not a passing
acceptance gate.
The relay counts encrypted data envelopes without recording keys or payloads;
ordinary relay delivery validates that counter. The stricter variant that also
blocks WireGuard handshakes leaves inner ICE connecting without media after
20 seconds, even after the outer endpoint is known. Native control replacement,
sibling continuity and final retirement pass with the media-only restriction
on loopback. These checks do not establish Native startup through NAT.

Without another preparation step, the complete Native Engine/receiver/playback
fixture also fails cold startup through ordinary kernel NAT with this restriction,
before any address move. Its relay-allowed control passes and retains fresh
playback after DERP closes.
Discovery traces show one direction's initial ping unanswered: one endpoint
confirms direct access promptly, while the other confirms it around six seconds
later. Native's eight initial ICE writes end around 1.4 seconds; a pending UDP
flow may still be unaccepted then. The late direct path does not revive that
exhausted generation. The late side can be either endpoint. A one-shot supported
`Client.DiscoPing` before ICE returns the relay result in milliseconds and does
not fix startup. Diagnostic replies and successful key admission therefore
cannot stand in for bidirectional transport preparation.

The producer/consumer review identifies a bootstrap contract mismatch:
[Tailcat's initial endpoint advertisement](https://github.com/tailscale/tailcat/blob/b4dc28e8aa8936f0a90a41ad8293a64e3d6b645f/tailcat.go#L1570)
uses CallMeMaybe without first sending direct UDP, while
[magicsock's receiver](https://github.com/tailscale/tailscale/blob/a0e471a35b8f/wgengine/magicsock/endpoint.go#L2146)
assumes that send has already opened the peer's stateful firewall. A dependency
candidate follows pings to newly learned endpoints with the existing endpoint
advertisement. Identical advertisements do not cause another reply, and no
timer, retry count or cryptographic check changes.

With that candidate, three fresh Pion starts deliver direct SRTP within
68–87 ms of their observation start; blocked-UDP and incoming-relay controls
still enforce the media policy. The real Windows VP8 encoder, Native receiver
and actual Chromium/Firefox bridge also retain fresh decoded pictures through
both local-address handoff directions and subsequent DERP closure, within the
unchanged observation bound. The Native fixture counts relayed data from before
bootstrap, not only after direct-path discovery. These are isolated, generated-
media checks; full App/room integration and physical networks remain open.

A separate TCP preparation control restored startup at about seven seconds of
extra cost but exceeded the spare time in the full handoff check. That extra
flow is not retained; the library bootstrap candidate supersedes it. Fixed-frame
or bare-Pion playback controls still expose the separate encoder and local-bridge
boundaries described below.

Authentication, key handling, retry timers and Pion budgets remain unchanged.
The experiment narrows the missing direct-media preparation contract; it is not
a supported upstream option, passing adoption gate or improvement to
direct NAT reachability. Product adoption must preserve site/share policy,
including P2P-only and SFU-only rooms, without silently adding another relay.

Replacing one gateway mapping without notifying endpoints separated recovery
from initial reachability. Neither established direct path delivered within
20 seconds with the relay closed. Fresh Pion discovery/exchange recovered in
about 0.6 seconds after it was started. Tailcat recovered delivery in about
6.5 seconds through its retained relay; closing it immediately lost delivery
again. Keeping traffic and discovery alive for 45 seconds allowed subsequent
direct delivery after relay closure. Both gateway directions were checked.
These timings have different detection/setup boundaries and are not a Piik
startup or playback benchmark.

The raw Bind adapter also has a composition cost: it consumes unwrapped STUN
payloads, and its discovery retry can outlive Pion's initial check budget.
Dropping the first discovery packet in each direction reproduced that failure;
increasing only the fixture's ICE budget recovered media. The ordinary Pion
loss control recovered without that override. Do not adopt packet prefixes,
diagnostic Ping polling or wider product deadlines as integration shortcuts.

Keep product integration conditional on a repeatable benefit on matched networks,
with direct coverage, relay coverage, recovery and first picture measured
separately. Go feasibility alone does not establish that benefit. The actual
Native-engine controls below cover gateway mapping, prediction and IPv6;
physical routers and the full mixed Piik topology remain outside the comparison.

### Isolated Connection-Layer Acceptance

The 2026-10-07 experiment through `f0ca8056` keeps Pion's ICE/DTLS/SRTP over
Tailcat. Each physical connection owns a virtual UDP tuple and mux; its one-shot
listener retires after admission. Connections to one authorized peer may share
the tunnel. Closing or aborting one flow preserves healthy siblings. Initial
revocation checks stopped outbound media and denied a fresh client; they did not
prove that the old client's inbound traffic was rejected. These checks do not
implement Piik room grants or endpoint exchange.

Repeated lifecycle and Linux race checks cover overlapping media preparation,
rollback, replacement, canceled preparation followed by retry, bounded datagrams
and blocked-reader retirement. A 350 ms interruption of one flow preserved its
sibling and recovered without replacing SDP. Piik's actual encoded source,
LiveKit forwarder and pacer also carried a small VP8/Opus fixture over ordinary
Pion and Tailcat, including TWCC and keyframe requests. Tailcat recovered an
injected missing video packet through existing NACK handling after DERP closed.
This is forwarding evidence, not throughput or room-controller acceptance.

A 2026-10-09 inbound-only control found that opening or closing an unrelated
Tailcat listener discards an accepted UDP flow's filter state. The unchanged
control passes; both listener changes stop delivery. Continuous outbound media
can recreate the reverse-flow entry, explaining why bidirectional checks alone
miss this boundary. The isolated repair passes the previous filter to Tailscale's
[existing shared-state API](https://github.com/tailscale/tailscale/blob/a0e471a35b8f/wgengine/filter/filter.go#L218).
Three race repetitions, the copied Tailcat listener suite and the combined
revocation/isolation controls pass. The patch remains experimental; it neither
changes Piik nor fixes the independent inner-ICE recovery failure below.

Real Browser controls forward generated H.264/Opus and VP8/Opus through Browser
WebRTC → Pion/Tailcat/Pion → Browser WebRTC without re-encoding. Both decode at
640×360 and, with the combined dependency candidate, 1920×1080. The larger input
requests 60 fps with a 6 Mbps ceiling and fixed dimensions; actual encoding
cadence varies, so it establishes neither 1080p60 delivery nor a throughput
advantage. Fresh picture/audio arrive in each two-second window across eight
seconds after DERP closure and stop after revocation. At about 3.6–4.3 Mbps,
reported RTP loss is zero and the largest Tailcat datagram is 1208 bytes, with
no size rejection. This does not bound all RTCP workloads or establish physical
capture, Browser-native Magicsock or complete Piik relay interoperability.

The 1200-byte Native packetization envelope with TWCC and short MID/RID headers
produced at most 1228-byte encrypted datagrams across Pion's three default SRTP
profiles. Only four bytes remain below Tailcat's 1232-byte ceiling; larger
headers and maximum compound RTCP remain integration checks. The small actual
forwarder fixture does not establish those limits.

A feedback control found a concrete mismatch: Pion's TWCC recorder generated
a 1244-byte encrypted report and a 1268-byte compound batch. Ordinary Pion
delivered both; the bounded adapter rejected them, and unwrapped Tailcat did
not deliver either within two seconds. A 1144-byte report arrived before and
after. Windows and Linux race checks repeated this result three times each.
Pion ICE treats non-close socket write errors as packet loss, so `WriteRTCP`
returning no error did not prove delivery. This does not establish how often
Piik would produce these batches. Tailcat's
[documented payload bound](https://github.com/tailscale/tailcat/blob/b4dc28e8aa8936f0a90a41ad8293a64e3d6b645f/tailcat.go#L574)
needs a supported feedback-size boundary before integration; reducing RTP
packetization alone does not bound RTCP. No product transport or custom packet
fragmentation was added for this check.
The related [Pion feedback-MTU report](https://github.com/pion/interceptor/issues/416)
remains open as of 2026-10-07. Its out-of-order packet evidence does not establish
the cause of any Piik field report; the pinned recorder has no byte-size option.

A 2026-10-08 reordering control flushed twelve 100-arrival reports, then supplied
one delayed packet. The recorder included already reported history and generated
a 1248-byte encrypted report from that one new arrival. Shortening the feedback
interval alone cannot bound its size. Windows and three Linux race repetitions
passed the reproduction. The latest tagged
[interceptor v0.1.49 recorder](https://github.com/pion/interceptor/blob/v0.1.49/pkg/twcc/twcc.go)
is byte-identical to the pinned recorder; Tailcat's
[October 7 revision](https://github.com/tailscale/tailcat/blob/52fbad323e9d352f1febb623e0975368e9a8cbdd/tailcat.go#L574) retains
the same payload limit and Tailscale dependency. A dependency bump does not
supply the missing per-report and compound-batch size boundary.

A local upstream-layer repair candidate now bounds TWCC reports through the
existing recorder split loop and sends them separately before encryption. Its
fixed 1200-byte plaintext budget is experimental, not a supported upstream
option. Unit checks preserve loss, reordered history, wrapped sequence numbers
and arrival times; restoring either old recorder or writer fails its regression
check. A real interceptor-to-Tailcat control delivered all 1500 statuses in two
reports after DERP closed, with a largest encrypted datagram of 1212 bytes.
Windows and three Linux race repetitions passed, as did the upstream TWCC suite
with the candidate. The isolated probe retains the opt-in patch and reproduction;
production dependencies are unchanged. This narrows one integration obstacle,
not the missing direct-reachability benefit or a supported upstream MTU contract.

The current Go feedback paths were also traced end to end. Pion's default NACK
generator retains a 512-packet window and writes one report per media SSRC;
a full-loss/wrapped-gap control with two SSRCs stays within 156 encrypted bytes.
Normal sender/receiver reports are written separately per stream. Piik's SFU
ingress callback forwards only PLI/FIR, and LiveKit's reachable XR response contains one
DLRR block. No additional oversized producer was found in these paths; this
does not bound arbitrary caller-created RTCP batches or future configurations.

Kernel queue controls compare established Pion and Tailcat SRTP under delay,
jitter, 5% loss and reordering with DERP closed. Both retained their session and
resumed after a 350 ms blackout in three race repetitions, and after a separate
nine-second blackout. Fresh tags and unique sequences exclude queued/duplicate
success. These are bounded recovery checks, not decoded quality or field coverage.

Kernel gateway rebinding retained full WebRTC: DERP restored fresh media in about
6.4–6.5 seconds and ICE `connected` in 7.1–8.1 seconds, without new SDP. Its recorded
disconnected interval was about two seconds, inside Piik's three-second grace;
the nine-second blackout reached about four seconds disconnected. Actual Native
Viewer-owner replays cancel grace or request one restart, clear recovery on
connection and retain the receiver. They mock App events, so do not exercise the
restart exchange over Tailcat or prove full integration. With DERP closed, neither
gateway direction recovered within 20 seconds. Fresh media, ICE state and a
unilateral direct address are separate facts. Underlay setup must fit the existing
operation deadline. Local cold setup of about 3.3 seconds for Tailcat versus 0.2
seconds for Pion disabled STUN/gateway mapping; it is not a WAN startup comparison.

Actual ICE-restart controls on 2026-10-08 exposed a composition failure.
After a nine-second kernel blackout, ordinary Pion resumed media, but default
Tailcat sometimes exhausted eight inner Binding requests before outer discovery
recovered about 2.4 seconds after restoration. Pion's
[candidate-pair check budget](https://github.com/pion/ice/blob/v4.4.0/agent.go#L790)
and Magicsock's
[rate-limited discovery](https://github.com/tailscale/tailscale/blob/a0e471a35b8f/wgengine/magicsock/endpoint.go#L1421)
are independent: outer recovery does not restart exhausted inner checks.
Keeping the accepted listener open did not help; a new ICE generation after
underlay recovery delivered three fresh packets in about 63 ms. This distinguishes
check scheduling from permanently retired resources. The isolated authorization
and feedback patches retain this failure.

The following counterfactuals preserve sockets, keys and NAT mappings. Unless
noted, recovery starts after network restoration; none runs Piik's complete
disconnect-grace, restart and rebuild schedule.

| Tailcat recovery control | Observation |
| --- | --- |
| Increase only the fixture's Binding request budget to 64 | Media recovered in about 1.9 seconds inside the fixture's eight-second window. This does not accept a product timeout change. |
| 16 Binding requests, three-second recovery window | Nine-second blackout recovered in about 1.9 seconds across three default-library repetitions; eleven seconds did not recover in budget. Other checked phases reached about 2.9 seconds. The authorization/feedback candidate reproduced both outcomes. |
| One client-side `DiscoPing` before default-Pion restart | Failures remained even after a diagnostic reply; that reply does not prove bidirectional encrypted media readiness. |
| One probe on each side before default-Pion restart | Nine- and eleven-second blackouts recovered in three race-detector repetitions, including both probes and SDP exchange inside three seconds. This requires an isolated, unsupported Server hook. |
| Same bilateral probe begins while the network is still down | After eight seconds of blackout, restoration one or two seconds into the probe still left it waiting until its three-second deadline in repeated race checks. Post-restoration controls continued to pass. |
| Lost bilateral probes, retain the existing media connection | In six race checks, both probes expired while WebRTC was already connected; a subsequent observation received fresh SRTP without new SDP, sockets or credentials. The separate three-second observation is not a product recovery extension. |
| New flow confirms encrypted UDP in both directions before inner ICE | With the listener-state repair and actual Viewer owner, one of four nine-/eleven-second controls recovered; three timed out in the existing three-second preparation, before SDP. The bounded fixture echo changes where waiting occurs, not the underlying recovery limit. |

These controls limit the bilateral proposal: a
[`DiscoPing` call](https://github.com/tailscale/tailcat/blob/b4dc28e8aa8936f0a90a41ad8293a64e3d6b645f/tailcat.go#L2258)
waits for its own diagnostic reply, not an ongoing connection-readiness event.
Later network restoration cannot guarantee that a lost probe completes.
The earlier passing phase therefore does not establish a universal recovery
barrier, and probe expiry does not establish media failure or justify replacing
healthy media. These controls use fixture SDP exchange; they do not diagnose the
product's Trickle ICE or an existing user's failure.

Manually phased replacement controls give ICE restart and inner-flow replacement
three seconds each, retaining the tunnel, outer mappings and default Pion checks.
Post-restoration controls pass after eight-, nine- and eleven-second blackouts;
two Tailcat controls starting before restoration also pass two further race
repetitions. These windows are stricter than a replacement receiver's actual
15-second initial-connection deadline, not a reproduction of the Viewer schedule.
A bounded repeated fixture preface prevents a lost first UDP packet from blocking
listener acceptance before ICE. It is not product signaling or media-health proof.

A separate fixture feeds kernel connection states into the actual
`NativeCapableViewerPeer`. Each rebuild gets a new connection ID, as in the
product, while preserving the parent's recovery budget. Renewing that budget
on replacement hid the nine-second outage: three repetitions recovered only
after a third automatic request, outside the two-request contract. The corrected
owner and fixture retain the count across Native and Browser backend replacement.

The actual-owner fixture now supports incremental SDP/candidate exchange,
matching Piik's [Trickle ICE generation boundary](https://www.rfc-editor.org/rfc/rfc8838.html#section-13).
With this enabled, ordinary Pion recovers two-, nine- and eleven-second outages
in three runs each. Without it, the same eleven-second control still fails at
the fixture's three-second gathering barrier while the network is unavailable.
That negative control is a fixture limitation, not a product defect.

In the matched Trickle run with the isolated listener-state repair, Tailcat
recovers two- and seven-second interruptions. Nine- and eleven-second outages
exhaust recovery: the replacement sends eight inner Binding checks, receives
none, and delivers no fresh SRTP during its initial deadline or a separate
three-second observation after exhaustion. Both 16-check cases pass; one
64-check replacement instead fails before SDP while awaiting its inner flow.
Permanent loss exhausts the existing budget and disposal cancels recovery.
No observation grants another attempt or extends a deadline. Native control
and local decoding remain stubs, and events are sampled within 100 ms. These
limits prevent claiming full App integration or diagnosing a field failure;
the composition gap remains an adoption concern.

Bounded anonymous traces further localize two Tailcat encrypted-echo failures.
The replacement flow is accepted and its client preface read at the server,
but the reverse read expires after three seconds before SDP. The server selects
its direct path near the end of that window; the client has selected its path
about two seconds earlier. No filter-drop event was observed, which is not
packet-delivery proof. Other timing phases recover. This supports a directional
underlay scheduling limit; it does not establish a new authorization defect,
a safe readiness barrier, or a reason to widen product deadlines.

Varying the existing [Pion Binding-request setting](https://github.com/pion/webrtc/blob/v4.2.19/settingengine.go#L506)
can bridge a discovery delay, but repeated controls also fail before SDP during
new-flow setup. Paired counters separately show the server receiving inner STUN
while the client receives none. More checks cannot repair every setup failure;
neither a new readiness owner nor a longer product deadline is accepted.

A retained-flow counterfactual reuses Pion's existing
[UDP mux](https://github.com/pion/ice/blob/v4.4.0/udp_mux.go) after closing the old
PeerConnection. It keeps the accepted Tailcat flow and replaces ICE/DTLS/SRTP,
without another listener or preparation exchange. Setup falls from about 913 ms
to 11–20 ms. Nine-/eleven-second recovery passes three of six default-check
cases, four of six with 16 checks and six of six with 64. Removing flow creation
alone therefore does not resolve recovery. Combined listener/revocation/TWCC
patches pass Linux race checks for 64-check recovery, bounded exhaustion,
retirement and sibling audio/video through serial replacements and rollback.
Overlapping connections still use separate flows, and revocation stops both.
This counterfactual does not accept retained flow as a product owner; the fresh
flow alternative below avoids that extra lifetime.

A preface-free alternative uses Tailcat's existing
[UDP listener](https://github.com/tailscale/tailcat/blob/b4dc28e8aa8936f0a90a41ad8293a64e3d6b645f/listen.go)
to reserve the address before SDP, allowing ICE to supply the first authenticated
datagram. Each replacement owns a fresh flow; no old mux survives it. An
unaccepted write returns a socket error instead of blocking ICE's event loop.
In the combined dependency candidate, 64-check nine-/eleven-second controls
each pass two Linux race repetitions under the actual Viewer owner. Setup takes
12–15 ms; fresh media returns at about 14.2 seconds from blackout onset, within
the unchanged two-request and initial-connection budgets. Permanent loss still
exhausts recovery, and retirement closes pending work. Local race controls cover
mutable deadlines, closing during ICE, peer rejection and continuous sibling
audio/video. Default inner checks still fail in these restart-then-rebuild controls.
This removes the fixture-preface and retained-flow lifetime requirements; it
does not accept a product Binding limit, implement room grants or establish
full App recovery acceptance of this alternative.

The sender's [restart capability](../standards/routing-transport.md#reconciliation)
changes that schedule. Modeling the current Native sender's first-request
replacement under the same Viewer owner on 2026-10-10, default checks recover both
nine- and eleven-second outages at about 23.3 seconds after two replacements. Their first
replacement still exhausts eight checks; the second starts after its existing
15-second initial deadline. With 64 checks, these controls recover after one
replacement at about 12.2 and 15.3 seconds respectively. Permanent loss exhausts
two replacements at about 38.3 seconds, and disposal cancels pending recovery.
This narrows the earlier failure claim to its tested sender behavior; it is not a universal Native failure
or an accepted product tuning. Native control and decoding remain stubbed in
this owner fixture, distinct from the decoded handoff checks below.

Separate checks preserve continuous sibling audio/video through a local ICE
restart, failed-flow retirement, both callers' pending cancellation/deadline,
revocation during a Server probe and unknown-peer rejection. Canceling a probe
ends the caller's wait, not upstream packets: existing five-second discovery and
ten-second TSMP timers bound callback retention. These local checks do not prove
impaired-network recovery.

The opt-in experiment retains the failing single-restart and blocking-probe
assertions. It is not an all-green acceptance gate or a supported adapter. Do not
widen product timeouts or add diagnostic Ping polling to hide these failures.
Room-authorized integration and the complete recovery lifecycle remain unverified.

A discovery-retained control on 2026-10-08 addresses a limit of closing DERP:
closure also removes its endpoint exchange. The upstream relay's packet-class
counters distinguish discovery from WireGuard traffic. A 500 ms window with
connected WebRTC, at least three fresh tagged SRTP packets and no non-discovery
relay packets proves direct media while keeping endpoint exchange available.
Ordinary NAT passes that proof; blocked UDP correctly remains relay-only. Both
orientations of the hard-NAT pair deliver through DERP without a proved direct
window in 20 seconds. After either gateway mapping changes, media returns in
about six seconds. Default-library repetitions do not prove direct recovery in
20 seconds. The combined isolated candidate proves it once per direction at
about 17 seconds, but neither of two further repetitions per direction does.
This variation does not establish a repeatable candidate advantage or an extra
reachable class. The control makes no explicit rediscovery call; its passing
result validates the measurement and available-media baseline, not universal
direct recovery. It does not run Piik's complete reconnect schedule.

An actual local-address-change control on 2026-10-09 replaces one endpoint's
IPv4 address, default route and public UDP mapping, allowing upstream network
monitoring to react. Discovery stays available, without an explicit endpoint
update or diagnostic Ping. With Piik's unchanged Viewer recovery owner and
Trickle exchange, three repetitions per direction preserve Tailcat's same media
session: direct delivery returns in 1.25–6.40 seconds with no owner restart.
Both default inner checks and the isolated 64-check candidate pass this control.
The ordinary Pion comparison requests one ICE restart and returns direct media
in 9.14–9.24 seconds. Relay accounting separates first available media from
direct delivery; another two seconds of fresh SRTP after DERP closes confirms it.

The actual Native Engine's wildcard UDP socket is a separate baseline: both
directions stop delivering after the address change without new SDP, and fresh
Native discovery restores local playback on that same changed network. This
avoids attributing only Pion's default per-interface socket behavior to Piik.
These controls establish a bounded address-handoff benefit, not an additional
initial NAT-reachability class, physical Wi-Fi roaming or complete App/decoder
acceptance. They do not resolve the gateway-only or prolonged-outage controls
above. Supported dependencies, room grants and representative network evidence
remain prerequisites for product adoption.

The remote-socket overlay extends that comparison through the actual Native
encoded source, sender, receiver and local playback. It leaves product files
untouched and binds the supplied socket to each connection-creation request.
Its fixed 8×8 input exposes forwarding pauses but cannot establish live encoder
recovery; declaring those fixed bytes rate-controlled is only an ablation.
The fixed-frame Viewer-address handoff pauses with both the former and current
socket adapters, including a matched control with isolated loopback playback.
Under that same playback isolation, the real Windows VP8/FFmpeg control passes
with the current adapter in all three checked cases: ordinary unchanged, source
address change and Viewer address change. These controls separate the adapter
change from the fixed-input recovery failure; they do not establish its complete
cause or justify relaxing media acceptance.

The live control instead uses the Windows VP8 helper, Native output-plan owner
and final FFmpeg decode. The top quarter of the input changes from red to blue
after DERP closure, so buffered pictures cannot satisfy fresh-content acceptance.
About one second of ordinary UDP loss can leave the former pacer sending old
video from a queue of hundreds of packets. DownTrack frame counts precede actual
paced writes and cannot prove delivery. The shared media assessment owns the
[pacing comparison](./node-local-media-design.md#send-queue-recovery);
it must pass constrained-bandwidth recovery as well as this short-loss control.

Viewer address changes expose a separate confound: same-machine playback can
select a LAN address that the experiment then removes. Restricting only the
fixture receiver to loopback separates that leg from the remote underlay.
With this control and the upstream default send queue, all six cases pass:
unchanged ordinary/Tailcat paths, both address-change directions, and short
ordinary/Tailcat loss. Each retains decoded fresh pictures in every post-DERP
sample. These passes do not accept the default local-playback path or the
complete App. Verify its Browser bridge
and existing recovery owner before adopting a local-address policy.
No additional NAT-reachability class, physical capture result or product
Magicsock integration follows from these controls.

A same-machine Windows Browser control rejects forcing the product bridge to
loopback. Chrome 154 decodes from a Native sender bound to `127.0.0.1`, but
Firefox 155 fails that connection; the same Firefox fixture decodes with the
current wildcard bind and a non-loopback selected pair. Mozilla also keeps
[ICE loopback disabled by default](https://searchfox.org/firefox-main/source/modules/libpref/init/all.js).
These controls establish a compatibility limit, not its complete Browser cause
or public-Site permission behavior. Keep the current address policy. A terminal
local-bridge failure ends the Host share or delegates Viewer recovery to its
existing connection owner.

Before local-bridge recovery, complete App UI controls on 2026-10-10 confirmed
this distinction in a disposable Linux network namespace, with automatic
topology optimization disabled and no
product source changes. Chromium 152 retains its loopback playback connection
when the namespace's LAN address changes. Firefox 151 selects that LAN address:
the Viewer resumes decoded pictures through the existing Browser fallback after
the local connection fails, roughly 30 seconds later. A Firefox Host instead
ends sharing on that preview failure, including a still-delivering downstream
connection; the Chromium Host control continues. The Host source is generated
VP8 delivered through the real capture-process interface, not physical capture.
Acceptance checks fresh rendered frames at the end, not accumulated frames from
before the interruption. All controls retire their App, Browsers and interfaces.
These are ordinary-transport controls, not integrated Magicsock or physical
roaming evidence. A faster remote tunnel alone cannot establish complete App
handoff; both the network and Browser playback legs must recover.

The local restart control exposed a separate address-cache defect: Pion ICE
v4.4.0's [wildcard UDP mux](https://github.com/pion/ice/blob/v4.4.0/udp_mux.go)
retains its own `stdnet.Net` interface snapshot across
gatherings. After an interface address changes, both ICE restart and a new SFU
connection sharing that mux can advertise the removed address. The shared mux
adapter now takes a private current snapshot when gathering; it changes neither
socket identity nor Pion's candidate filters and adds no monitor or timer.
The isolated regression covers restart and a new connection; restoring the
former constructor fails on the stale candidate. Firefox also resumes fresh
rendered frames on the same track after a standard ICE restart, including from
the failed state, while a separately bound loopback sibling keeps receiving.
Replacing only the Native PeerConnection while retaining the Browser connection
instead reported connected without fresh decoded pictures in the same fixture;
it is not the accepted recovery mechanism.

The 2.0 candidate now uses the existing bridge owner for one standard ICE restart
after a three-second disconnect grace, or immediately after failure. Initial and
restart negotiations use complete local SDP with the request ID fencing the answer;
there is no separate local trickle queue. The negotiation has an eight-second
deadline, including a five-second Native gathering bound. Retirement cancels it;
failure retains the existing Host/Viewer terminal owners. Paused sources need not
produce new frames to prove a transport connection.

Matched complete App controls retain the same Firefox Host and Viewer media track
through the namespace address change. The Host keeps sharing and decoding, its
downstream Viewer keeps rendering, and the Native Viewer resumes fresh rendered
frames without replacing its route or falling back to Browser reception.
Chromium Host/Viewer controls retain their working loopback leg without a restart.
These controls use ordinary Pion and generated media. They close the reproduced local
bridge gap, not the remaining Magicsock composition, physical roaming or platform
acceptance boundaries.

The aligned candidate also combines the real Native encoder/forwarder/receiver
with the actual Browser bridge over the experimental Tailcat socket. The fresh
flow adapter now replaces its synthetic preface: SDP starts before peer admission,
and ICE supplies the first datagram. All six FFmpeg-decoded controls pass Linux
race checks. Chromium 152 and Firefox 151 each pass an unchanged ordinary-Pion
control and both Tailcat address-change directions. After DERP closes, new blue
content keeps rendering on the same track. Firefox renegotiates its local leg
once when that endpoint moves; Chromium retains its working loopback leg. Local
HTTP replaces Native control only in this fixture; App authorization, room routing
and prolonged-outage replacement are not exercised. No product timeout, address
policy or inner Binding setting changes for these handoff checks.

A separate Linux race check now passes those experimental flows through real
Native control commands and the Viewer session's existing receiver owner.
Closing a receiver releases its physical flow; replacement and a healthy sibling
keep receiving fresh RTP after DERP closes, including after late cleanup for the
old connection ID. Stopping reception or closing the control session releases
both remaining flows. Omitting receiver retirement in the test overlay is
detected. Keys are still pre-granted locally: this establishes resource cleanup,
not room authorization, automatic App recovery or Browser decoding in this check.

The request-scoped adapter removes the former Engine-wide next-socket slot and
temporary bootstrap receiver. A lazy factory reaches the existing physical
socket owner only after input/capacity admission; reuse does not allocate again.
Unsupported-codec failure, independent receiver retirement, control close and
cancellation of a still-opening socket pass under the race detector. The Native
engine, Host, Viewer and control package suites also pass with the overlay.
The complete loopback WebSocket check exposes one additional integration gap:
delayed socket preparation waits for its media owner, while deferred session
close waits for that synchronous command. Client disconnect and server shutdown
both leave it waiting in the unmodified owner. The isolated correction runs
session close on control-context cancellation and joins it before releasing the
capacity slot. Both cases, the direct-owner checks and loopback/control package
suites pass under the race detector. This is an experimental slow-transport
requirement, not an established published failure. Viewer-page startup and
transport consumption remain open; no new recovery loop or room resource
registry is added.

The earlier FFmpeg matrix had one decoded-content failure. Matched synthetic
bitstream/RTP replay identifies a receiver-fixture mismatch: its separate SDK
assembler emits a truncated startup frame and can resume dependent frames after
a sequence gap without their reference. Increasing that builder's window instead
stalls recovery. On identical unchanged and source-handoff recordings, the
product relay-input owner's independent-keyframe boundary produces only
byte-matched source frames, with no decoder errors or corrupted colours.
The fixture now reuses that owner. All six unchanged, address-change and loss
controls pass with actual encoding/decoding and Linux race detection, without
decoder errors or changes to product timeout, adaptation or recovery policy.
The original failed run has no packet recording, so its exact cause remains
unassigned; this correction does not establish universal media continuity.

Dual-stack namespace controls enabled STUN and alternately blocked IPv4 UDP or
IPv6 forwarding. Both stacks used the working family; Tailcat's direct proof
required fresh bidirectional delivery after DERP closed. One side reporting a
direct address did not establish that both directions were direct. IPv4 TCP
still supplied bootstrap, so this is not an IPv6-only or physical ISP check.
These controls add no demonstrated direct-reachability advantage for Magicsock.

The actual Native `mediaedge.Engine` Host/Viewer now runs through the same kernel
gateways, including local playback and the unchanged TypeScript survey predictor.
Three Linux race repetitions received ten distinct RTP packets containing the
generated VP8 frame, excluding padding/duplicates. With no gateway service,
mapping enabled did not hold ordinary media behind discovery: delivery took
about 0.8 seconds. Either usable IP family also carried media. Sequential-port
NAT failed without prediction and delivered through a predicted candidate when
enabled, with the changing-port gateway on either endpoint; random-port NAT
remained unreachable in the bounded checks. A real
MiniUPnPd gateway made a hard/hard pair reachable when mapping was enabled.
These are encoded-media checks, not capture, Browser decode or room admission.

Tailcat's matched controls explicitly link its [optional portmapper feature](https://github.com/tailscale/tailscale/blob/a0e471a35b8f/feature/portmapper/portmapper.go);
clearing its disable flag alone does not register that optional feature. Gateway
mapping then passed three race repetitions after DERP closure. The 20-second
comparison distinguishes fresh direct SRTP from relay delivery and retains the
same gateway filtering. Its relay bootstrap and Piik's local playback differ,
so startup timings are not a first-picture benchmark.

A 2026-10-08 fairness control found that Tailcat's single bootstrap region leaves
`MappingVariesByDestIP` unknown even with three STUN addresses: upstream
[netcheck](https://github.com/tailscale/tailscale/blob/a0e471a35b8f/net/netcheck/netcheck.go)
cancels the region's other probes after its first reply. A lab-only map projection
gives those real addresses independent probe regions and pins the original relay;
it is not a supported Tailcat option. Twelve Linux race cases verify classification
on the actual media socket, keep media flowing until relay closure at 12 seconds,
and require a fresh payload before the 20-second bound. Random/sequential pairs
remain relay-only in both directions, with or without an absent-gateway mapping
probe; an available gateway still establishes direct media. No extra direct path
over Piik was found. Physical routers and field success rates remain unmeasured.
Product dependencies and routing are unchanged.

The experiment's README owns commands and fixture boundaries; raw output remains
ignored. Further product work needs a measurable network benefit and accepted
room authorization, resource and relay-operation owners, not more loopback
successes.

### Peer Authorization Boundary

The 2026-10-08 three-peer control found that Tailcat forgets a revoked key but
leaves its WireGuard session alive: fresh inbound UDP still arrives after
`DisconnectClient` returns and `PeerKey` no longer recognizes it. A separate
controlled race lets a late positive `AllowClient` result re-admit a revoked
key. Both defects were independently reproduced; Tailcat's checked
[October 7 source](https://github.com/tailscale/tailcat/blob/52fbad323e9d352f1febb623e0975368e9a8cbdd/tailcat.go)
retains both mechanisms. Piik's current transport does not use this dependency.

An opt-in Tailcat patch syncs the existing engine after releasing the backend
lock and invalidates late results in its pending-hook map. Three Windows
repetitions and three Linux race runs reject both traffic directions and new
admission, preserve two healthy peers' media and permit a later explicit grant.
Removing either correction fails its regression; upstream admission/disconnect
checks pass. This repairs the Tailcat layer only.

A deeper unit reproduction pauses WireGuard's lazy peer-config lookup, withdraws
authority and calls `RemovePeer`, then releases the old result. `LookupPeer`
still installs an active peer. Both the pinned `0a83b87f7908` and
[October 2 revision](https://github.com/tailscale/wireguard-go/blob/18e99eba5393b8c9ea513ab7a1db1a12625422ca/device/device.go)
reproduce it. An isolated patch on the newer version tracks in-flight config
lookups at the peer table and starts lazy peers under that same lock. Removing
a key retires only its pending calls; lookup replacement and close retire all.
Tokens are reclaimed on completion without accumulating historical keys.
An unrelated-key control rejects a global generation fence: it cancels valid
concurrent admission. Scoped tokens preserve that admission, overlapping grants
and cleanup; removing the retirement check reproduces stale installation.
The full device suite and lock-order analyzer pass, including three Linux race
runs. Combined media and TWCC checks pass on Windows and Linux; the Linux kernel
NAT, dual-stack, rebinding and weak-network controls also pass. Supported dependency
contracts and demonstrated network benefit remain open. The probe retains the
isolated patches; Piik's production transport is unchanged.

Admission ordering is also an integration constraint. Upstream
[`Client.DialUDPPort`](https://github.com/tailscale/tailcat/blob/52fbad323e9d352f1febb623e0975368e9a8cbdd/tailcat.go)
waits for the server to admit the client's key before returning a socket.
Piik creates the receiver and its socket before returning a media answer.
Authorizing that key only after receiving the answer would therefore introduce
a circular wait. An isolated `PrepareUDPPort` patch reserves the local address
without waiting for admission. Through real Native control, it can return the
answer first and receive fresh RTP if the fixture holds remote ICE candidates
until the grant completes. Both receiver/control retirement paths retain their
cleanup checks; the pre-granted control uses the same client/server orientation.
Without that experimental candidate gate, Native sends five ICE checks before
the roughly one-second grant acknowledgment, reaches eight and receives no RTP
within the unchanged bound. Complete-SDP and early-trickle controls both fail.
The early-trickle counterfactual is opt-in and intentionally fails its media check.

The simpler pre-ICE control uses supported `DialUDPPort` in both Native
listener/dialer orientations. With keys already admitted, the real Native control
session receives fresh RTP, replaces a flow without interrupting its sibling and
retires all flows on stop or control close. All four Linux race cases and vet
pass with `PrepareUDPPort` removed from the copied dependency, without an explicit
diagnostic ping or an admission-dependent candidate gate. The other isolated
dependency corrections remain. This removes the need for that extra startup API
when key admission precedes media negotiation; it does not implement room-scoped
key exchange or demonstrate higher direct reachability.

The isolated signaling extension carries bounded listener metadata on the
assigned parent's ordinary SDP offer. SDP/ICE remain the signal variants;
there is no extra key-exchange message or router authorization branch. Actual
room WebSocket checks reject unrelated peers/rooms, retired candidates and
listener metadata on answers or ICE candidates. Ordinary invitation revocation
still closes the authenticated Viewer session. Protocol/signaling race suites
pass. The generated extension adds no server key registry or product wire change.

A separate Native control check derives admission from its actual owned inbound
flows. Closing one flow retains the shared peer's authorization while another
flow remains; closing the last disconnects that peer. Final revocation and a new
grant serialize without holding the flow-map lock through Tailcat callbacks.
Stop and control-close cases pass under the race detector, including fresh
sibling RTP before preparing a replacement. Counterfactuals that disconnect on
every close or never disconnect fail those checks. This composes physical-flow
cleanup with the Native session; keys in that control remain local fixture inputs.
The pending-flow adapter also rejects a different admitted peer without consuming
the assigned listener. The two-peer control reproduced the former premature
close; the repair permits the expected peer or cancels through the same owner.

The composed room/Native control receives the child's authenticated key through
its assigned-parent projection. The parent prepares a listener before its offer;
the child dials from that offer before creating its ICE agent. RTP delivery,
same-parent replacement after DERP closure, late old-receiver cleanup and
invitation-driven final retirement pass under the race detector. The ordinary
offer adopts a replacement ID; the parent's updated assignment retires its
listener while the Viewer stops receiving. Listener metadata carries the node and discovery keys,
a nonzero shared key and a bounded port; it carries no relay URLs or region IDs.
The dialer constructs the upstream address from received fields and a trusted
local relay configuration. Strict shape checks and the existing route diagnostic
owner keep connection material out of its output; complete protocol/signaling
race suites and the direct-media composition pass.
Trusted relay configuration and room-event dispatch to Native control remain
fixture inputs. Complete Browser/App authorization and transport selection remain
open: the product Native-capable Viewer chooses its backend on the SDP offer.
This check establishes packet reception and resource retirement, not decoded
playback or field benefit.

An isolated session-capability candidate addresses that timing boundary without
a second exchange or room-wide key registry. Viewer authentication supplies its
public Native receiver key; the existing preparing and committed assignments
project it only to assigned parents. Public presence and unrelated participants
receive none. The existing restart request can replace or clear the key only
for the current physical connection; a retired request cannot change it.
Invitation revocation removes it with the authenticated session. Browser-only
and Native cases pass through real room WebSockets under the race detector.
The isolated Native control now generates the private key in its existing
session and supplies only the public half in the ordinary `ready` handshake.
There is no persisted device identity or additional query. A Node-driven real
Browser `NativeClient` connects through loopback HTTP/WebSocket: independent
sessions have different keys, ordinary commands retain them, and retirement
clears the advertised identity without affecting its sibling. Diagnostic export
and console output exclude those keys; loopback/control race suites and the App
composition build pass. This does not cover Browser local-network permission.
The isolated Browser overlay now preflights the existing Viewer connection
promise before authentication only for App-launched pages. Missing App discovery
retains Browser fallback. The existing signaling identity supplies the current
key on authentication, restart and reconnect; control loss or disabled Native
reception clears it without initiating another recovery operation. Owner checks
cover stale cleanup, completion after unmount and disabling Native during
discovery. They exercise extracted page logic and the real signaling serializer,
not rendered UI or Browser permissions. Full overlaid frontend and lifecycle-test
type checking now pass with the single offer field. Native command binding
and sender/receiver transport consumption remain unimplemented;
the scoped startup checks do not establish complete Browser integration.
The key is availability metadata, not media-readiness authority.

`room-browser.mjs` bundles the real Browser schemas and diagnostics with matching
experimental fields. It accepts the Go fixture's twelve route/restart messages,
rejects malformed capability/listener fields and removes scoped keys from both
console events and exported reports while retaining connection and keyframe
evidence. The Go and Browser optional-map null checks agree. This is a Node-run
producer/consumer check, not Browser UI or complete App transport acceptance.
The product wire and diagnostic implementation remain unchanged.

These checks establish startup-order and ownership constraints, not a product
integration or a Piik field defect. The earlier candidate gate and unsupported
dependency method are not accepted product mechanisms.
The existing assigned-connection owner must resolve key exchange and admission
before ICE starts. Accepting arbitrary keys, passing room credentials into Native
control or enlarging its timeout is not an equivalent solution.

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
