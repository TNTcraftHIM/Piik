# Browser And Native NAT Traversal

Last reviewed: 2026-11-26

This document owns evidence and its limits. Current 3.0 behavior belongs to the
[network model](./channel-network-design.md#reachability-and-repair), execution
methods to the [laboratory](./network-lab.md), and dependency pins to
[Native provenance](../../prototype/channel-native/README.md#rtc-dependency).
The historical section links to the released Go/Pion/LiveKit evidence. An isolated
candidate is not a delivered product feature.

## Confirmed Boundaries

- STUN exposes a socket's mapped address to ICE. It carries no media; its operator
  sees source address/port, request timing and protocol metadata.
- Reachable STUN destinations, accepted candidate syntax, authenticated checks,
  nomination and decoded media are different observations. None substitutes for
  the next. Browser gathering can deduplicate equal mappings or finish after a
  useful candidate has already arrived.
- Mapping samples do not establish filtering behavior or a persistent NAT type.
  Source ports, destination IPs, interfaces and network changes affect the result.
- Ordinary Browser WebRTC owns its sockets. A page cannot open an arbitrary UDP
  pool or replace ICE with a Native QUIC/WireGuard hole-punching socket.
- Direct reachability, relay coverage, setup latency and recovery are separate
  outcomes. Controlled success counts are not public-network success rates.

### ICE Recovery Boundaries

Piik owns current-pair authorization, negotiation and candidate generations;
the RTC framework owns checks, nomination and media adaptation. Stale signaling
must not mutate a replacement, and a failure already handled by the current
operation must not create a second restart. Increasing retry counts does not
repair those ownership defects. Current Rust behavior is described below;
[ordinary recovery](#ordinary-ice-and-media-recovery) retains the distinct 2.x
findings. Names of libraries or packaged classes do not prove active relay use.

## Rust Integration

The [network model](./channel-network-design.md#reachability-and-repair) defines
Native UDP preparation, its socket and request budgets, and ordinary ICE fallback.

For stable/sequential observations, the stable side retains its survey socket.
The bounded targets are `last + 4*step` and `last + 8*step`; authentication fixes
one peer tuple. Matching transaction responses and mutual completion precede
socket transfer. The [ICE triggered-check principle](https://www.rfc-editor.org/rfc/rfc8445.html#section-7.3.1.4)
lets an authenticated incoming request trigger the local check while that owner
continues answering. Initial and triggered requests share the finite budget.

Controlled results establish these separate improvements:

- A one-second signaling skew plus a lost first triggered request completed
  within the existing five-second preparation lifetime.
- Four intervening allocations defeated the single predicted target; the bounded
  alternative connected and carried advancing picture and sound with fewer
  requests. This covers one stable/sequential allocation-drift model.
- TCP-header controls isolated approximately 0.94 seconds of additional
  Ping/ACK skew. Disabling Nagle through existing Native/App/Domain socket APIs
  removed that component without removing the injected network delay.
- Concurrent observations reduced the local survey/Offer/Answer control from
  561 ms to 250 ms with an 80 ms delay at each STUN destination. Each side still
  sent three ordered requests. An unanswered Offer released its socket at the
  existing five-second limit; this measurement begins after address resolution.
- A matched sequential-mapping/APDF media control connected the retained Native
  pair in 0.334 s, versus 6.104 s for the former replacement sequence. Both arms
  delivered changing H.264 pictures, Opus sound and a file with the expected hash.
  First observed viewer playback was 12.553 s versus 15.133 s, including Browser
  startup and joining, so these are observation bounds, not exact decode-onset
  latency. Each arm ran once. They establish this controlled path, not public
  success rates.
- An established TURN-to-direct transport control retained the original RTC,
  ICE credentials, DTLS certificates and bidirectional DataChannel while adopting
  an authenticated socket. With coturn still available, the late video window
  moved from TURN to the exact prepared tuple; withholding that socket kept the
  control on TURN. All 72 VP8 frames decoded with source-matching hashes and
  continuous RTP sequence numbers. This used two Native transports in an
  isolated Linux namespace, not full App signaling, physical capture or public networks.

The adapter also translates the selected ICE implementation's terminal boundary.
The reviewed [is 0.11.1 source](https://docs.rs/crate/is/0.11.1/source/src/agent.rs)
emits `Disconnected` when no nominated or viable candidate remains, with no later
`Failed` event; its default unanswered-check budget was about 21.5 seconds.
Native sends exhaustion to the existing pair failure/replacement owner. Browser
disconnection retains Browser semantics, and short interruptions remain SDK-owned.

### Allocator Prediction Controls

On 2026-11-26, six isolated Linux namespace arms compared two sequential
targets and a stable/sequential search. Each arm ran twice with matching results.
The routers used the existing laboratory allocator and filtering rules;
identifiable synthetic UDP established both peer directions.

| Allocation sequence | Existing search | Candidate search |
| --- | --- | --- |
| Four foreign allocations before each side's eight mappings | Target `+4` missed | Target `+8` reached both peers |
| Four foreign allocations between each side's fourth and fifth mappings | Target `+4` reached both peers | Target `+8` missed |
| Stable/sequential, twelve foreign allocations before the sequential side | Eight sockets and two targets missed | One socket and 64 targets reached both peers |

The stable side retained one source port, but its peer-directed connection
tracking entries rose from two to 64. The production 64-request limit also
covers triggered checks, so an initial scan must reserve part of that budget.
Production authentication, pacing, ICE transfer and media remain the next
acceptance boundary. The current runtime targets are unchanged.

A separate STUN census held two sockets and queried three observer IPs plus
a second port on the first IP. Three programmed routers distinguished port
preservation, address-dependent mapping and sequential per-flow mapping.
The sequential router's eight observed ports were `40000–40007`; independent
peer requests used `40008` and `40009`. Two deliberately withheld replies
remained missing observations, with their actual tuples retained for scoring.
Prediction comparisons need held-out target mappings and unknown outcomes;
the observed minimum and maximum cannot define the allocator's support.
Mapping and filtering remain separate observations under
[RFC 4787](https://www.rfc-editor.org/rfc/rfc4787.html#section-4.1).

The isolated allocator was also exercised through local STUN under programmed
kernel routers. At `6a3b858a`, two single trials paired one stable peer with
sequential or four-counter tuple-hashed mapping. Histories and ten candidate
ports were frozen before touching the peer. Both trials delivered synthetic
UDP in both directions, using 53 datagrams including observations and replies
within a 64-datagram total budget. Advertised-port-only controls did not deliver.
The tool's round-robin sampling was truncated to ten additional observations
to preserve that budget. Replaying the earlier frozen observations reproduced
the candidate order. This establishes the controlled UDP path; authenticated
preparation, ICE nomination, media and public-network coverage remain separate.
Production preparation is unchanged.

### Native NAT64 Assessment

Native adds IPv6 aliases for numeric IPv4 UDP candidates through the SDK's public
API. One connection-scoped lookup of `ipv4only.arpa` discovers the prefix under
[RFC 7050](https://www.rfc-editor.org/rfc/rfc7050.html#section-3); synthesis follows
the six [RFC 6052 layouts](https://www.rfc-editor.org/rfc/rfc6052.html#section-2.2).
Initial ICE starts discovery once it has both a non-loopback IPv6 base and an
IPv4 peer candidate. Desktop interface refresh watches both bound address
families until ICE nomination. Newly available IPv4 bases also reach the shared
gateway publisher. A monitor-injection control published a late IPv4 candidate
and admitted one injected gateway mapping to both connections sharing its socket.
Interface refresh can supply the first usable IPv6
base after gathering starts. First ICE nomination or pair retirement releases
bootstrap work. Failed discovery or exhausted aliases preserve
ordinary candidates. There is no persistent prefix cache or SDK fork. Well-known
prefix synthesis is limited to global IPv4; network-specific prefixes retain
private-address support.

An isolated network-specific `/64` control delayed DNS64 and used real NAT64
translation. Ordinary ICE nominated the path; room/file/input DataChannels opened,
and picture and sound advanced through an IPv6-only Native relay. Other prefix
lengths have RFC-vector coverage. Physical networks, multiple translators and
interface changes remain outside this evidence; [status](../status.md) owns the
delivered-package snapshot.

### Random-Mapping Collision Control

Current Native stable/irregular preparation constructs two intersecting sets:
independent hard-side mappings toward one stable peer tuple, and distinct ports
searched from that peer's retained socket. Repeating a single prediction does
not construct this search space. Both-irregular observations retain ordinary ICE.

For `M` independent uniform mapping draws and `N` distinct targets in an effective
port pool `R`, the idealized hit probability is
`1 - (1 - N/R)^M ≈ 1 - exp(-M*N/R)`. If both sets are sampled without replacement,
the exact hit probability is `1 - ∏(1 - N/(R-i))` for `i=0..M-1`.
With `M=N=256` and `R=65535`, the exponential approximation
is about 63.2%, not near certainty. Piik's target range 1024–65535 has 64,512 ports;
real NAT allocation, occupied mappings, filtering and packet timing need not be
independent or uniform. Request/reply counts are not distinct-target counts.
The [original traversal analysis](https://tailscale.com/blog/how-nat-traversal-works)
distinguishes this one-hard-peer model from two independently random mappings.

On 2026-11-14, the isolated research implementation used 256 hard-side sockets
and 256 pre-frozen targets in calibrated Linux kernel NAT; neither Native had a
full-cone exception. Five fresh ordinary controls established no DataChannel
within 30 seconds. Five matching experiments had three empty intersections and
two natural authenticated matches. One carried decoded 640×360 video and audio
through the original winner. Failed attempts sent 1,024 preparation datagrams
per pair; successful attempts stopped at 582 and 308. The five-second preparation
deadline stayed fixed; successful admission-to-DataChannel times were 8.51 and
8.11 seconds including the preceding ordinary attempt.

The production generator and matched Core22 then ran three fresh kernel-NAT
trials: two DataChannels, one no-match deadline. The first success carried decoded
media with SDK-selected tuple evidence. Separate deterministic resource controls
observed 255 losing sockets released, the original winner retained, and all owned
sockets released on pair withdrawal while the participant/signaling stayed alive.
These establish mechanism and ownership, not a population success rate.

At `6f98d93c`, the stable peer searched up to 512 distinct ports within the
520-request budget. In one natural Linux kernel NAT trial, it sent 186 requests
to 186 ports before the original pair completed preparation and connected.
With both routers dropping incoming peer traffic, the WAN capture recorded
512 requests to 512 distinct ports from the stable peer and 512 requests to
one port from the pool peer. In a separate withdrawal at pool readiness, the
reader stayed alive as its namespace UDP socket count fell from 256 to zero.
One natural trial cannot estimate a field success rate.

A 2026-11-25 control compared 512 and 1,024 targets against 64 identical seeded
kernel SNAT/APDF mappings, with 256 pool sockets, a 2 ms absolute schedule and
one five-second lifetime. The larger search added eight mutual checks (55 to 63)
without losing a previous hit. Mean IPv4/UDP traffic rose from 54.3 to 56.5 kB;
the no-hit pair totals were 80 and 120 KiB. These are controlled mapping results,
not a public-network success estimate.

The actual Rust preparation and ICE path then ran eight prespecified attempts
with fresh, unpaired random mappings. An actual hit at target 586 completed ICE
and a DataChannel. Two controls per budget delivered changing decoded video and
advancing audio on the retained prepared connection. Forced no-hit controls sent
exactly 512 or 1,024 distinct search checks, kept the pool at 256 sockets, and
ended at about 5,002 ms. The existing concurrency, winning-socket and withdrawal
checks passed. The first four browser attempts retained their failed fixture
dependency outcomes; they are not counted as decoded-media successes.

This supports the 1,024-target budget without extending preparation time or
adding sockets. A survey that has already consumed three seconds can leave room
for only about 745 checks, so the target budget is a ceiling, not a promise to
send all of them.

The search divides ports 1,024–65,535 into 1,024 strata of 63 ports. It visits
strata in bit-reversed order with a random rotation and draws an independent,
uniform port within each stratum. Rejection sampling avoids modulo bias. This
combines early range coverage with independent offsets, following
[stratified sampling](https://artowen.su.domains/mc/Ch-var-basic.pdf). A single
rotation of bit-reversed ports instead leaves the first 1,024 targets in one
residue class modulo 32: fixed pools at strides 2, 4 and 8 are then missed for
half, three quarters and seven eighths of rotations. Contiguous-pool tests alone
do not reveal that blind spot.

The first 512 stratified targets leave at most 187 consecutive ports untested,
so they reach any fixed contiguous 256-port pool. For any fixed pool of 256
ports, the full-budget miss probability is at most `(62/63)^256`, about 1.664%,
under independent uniform draws. Uniform distinct targets miss about 1.650%.
These are static pool bounds, not unconditional dominance or field success rates.

A 2026-11-27 Windows loopback control used four fixed 256-port pools at strides
1, 2, 4 and 8. First hits occurred at targets 215, 384, 38 and 35. All four
completed mutual authentication, adopted the winner into the original RTC and
exchanged SCTP messages in both directions; losing sockets and preparation
permits were released. The fixture counted all attempted targets at the existing
2 ms cadence, dropping unmapped attempts before sending. Actual packets stayed
on owned loopback sockets. The 1,024-target, 256-socket and five-second limits
and the separate eight-socket sequential path remain unchanged. Physical NAT
allocation, filtering and competing traffic require independent-network trials.

Default observations use three documented services on different destination
ports: [Cloudflare](https://developers.cloudflare.com/realtime/turn/faq/),
[Google](https://webrtc.org/getting-started/peer-connections) and
[Nextcloud](https://github.com/nextcloud/spreed/blob/main/docs/settings.md).
Different ports reduce the chance that a per-destination counter appears to be
one shared sequence. On 2026-11-27, two same-socket serial controls using the
Native STUN decoder received three valid IPv4 XOR mappings in 931 and 870 ms,
within the existing 1.5-second observation budget. Campus and carrier-network
reachability still need the paired private-beta control.

A search window bounded by two counter observations remains experimental.
The bounds imply containment only when the peer mappings use the same counter
and public exit. Even with containment, interleaved allocation can leave gaps:
in a 128-position window, eight mappings at even offsets 2 through 16 were all
missed by 64 bit-reversed probes starting at offset 1, while the current
sequential strategy's first target hit offset 4. Window selection and probe
ordering need a matched two-sided comparison before replacing that strategy.

The frozen source archive had SHA-256
`4371aafbe865676fe30d5cee7d21af781720a3ce664129c3d4c6cc4204ebdda2`
and pinned str0m at `2d0d6eaaf4d19d7530588f695cd631eedf42acf5`.

Native-to-Browser controls distinguish extra sockets from useful hypotheses:

| Controlled model | Observation and limit |
| --- | --- |
| Random destination-dependent mapping, stable/APDF Browser; one versus eight Native sockets, ordinary ICE | Neither connected at 5 or 10 seconds. Browser checked all eight observed srflx endpoints, but peer mappings differed. A socket pool alone did not repair that model. |
| Linear mapping; eight sockets in both arms | Ordinary ICE failed; 16 experimental targets from ordered STUN observations delivered SCTP after 1.49 seconds. Native released seven losers at 5 seconds; Browser ICE continued to the 10-second observation. This was not media or random-mapping evidence. |
| Production one-base linear extension, matched Core24 | Real Domain/Native/Browser admission: suppressing generated hypotheses left the target disconnected; accepting them delivered moving video, Opus and reverse RTCP on the original socket. Browser closure retired the target. |
| Address-dependent mapping, current one-base producer | Three ports on one IP appeared stable and emitted no hypotheses. Three IPs exposed the sequence; the same 16-target budget delivered bidirectional DataChannel in about 1.5 seconds with either SDP offerer. This tests SDP roles, not every media-sharing direction. |
| Domain45 media directions, sequential Native mapping and stable Browser mapping, both APDF | The original predicted socket carried decoded H.264, advancing Opus samples and reverse RTCP in both Native-to-Browser and Browser-to-Native directions. Suppressing hypotheses left both controls disconnected after 10 seconds. The Native-output positive/negative pair had the same initial SDP role; the reverse pair did not, so their timings are not a directional comparison. |

The production media runner retained two overbroad failures: demanding media in
the negative control without viewer demand, and treating an unselected source
convergence pair as a Native retry. Saved pair identities, decode counters and
packet capture independently establish the reported media result. They do not
establish every cancellation path.

The Domain45 direction control preserved a failed final assertion that expected
retirement within 10 seconds of abrupt Browser closure, shorter than the session
resume window. Its media result is supported by the same run's selected tuple,
packet capture and decoded frames. Explicit participant Leave retired the other
direction's target. These controls do not measure physical-network success rates.

Current App-to-Browser production uses one existing IPv4 base and its concurrent
STUN work. The later eight-socket pool and resource experiments remain isolated
candidates. Distinct STUN URLs or ports also
do not guarantee distinct destination IPs; same-IP observations can conceal
address-dependent mapping. [TODO](../todo.md) retains physical-network work.

### Field Survey And Search Order

On 2026-11-27 the owner's circle ran the standalone survey tool
(`prototype/nat` on `claude/nat-model`, versions 0.1 to 0.5.3) on thirteen
access networks in thirty-five runs: home lines, campus networks, phone
hotspots and mobile data. From 0.5.2 it also asks an observer of our own on
sixteen ports of one address
([runbook](../operations/website.md#nat-survey-observer)). Every run is
one-sided: no peer took part, and nothing here is a rate of connecting.

| What a network did | Networks |
| --- | --- |
| One mapping per socket whatever the destination, five of them keeping the local port | 8 |
| A counter for each destination, counting up by one | 2 (a campus, a carrier's hotspot) |
| One counter per public address for every destination, moving 300 to 550 ports a second | 1 (a hotspot with three addresses) |
| A few slow counters, or one block of some tens of ports, shared by all destinations | 3 |

Four of the thirteen left through more than one public address, chosen by
destination or by socket. One hotspot is counted in two rows: its two
addresses behaved differently.

Filtering was measured on nine of them by asking the observer to answer from
its next port on a socket that had sent only to the first: on all nine,
nothing came in. No network has yet let such an answer in, so the test still
lacks a positive control from a host without filtering.

Where each destination has its counter, the observer's sixteen ports showed
what the public servers could not. Each even port and the odd one above it
shared a counter, 14 of 14 pairs on the two networks. Of the mappings made
toward one pair, 100 of 106 took the port after the last, across sockets and
over twenty seconds, with no other traffic on those counters; the rest were
jumps of a few ports or of one fixed size per network. On the campus a second
run half an hour later continued most counters where the first had left them.
Where a counter starts cannot be read from other destinations' counters: the
held-out replay reached 1 to 4 of about 65. Counters of popular destinations
move in bursts, since every subscriber's traffic to them shares one.

Two results follow, both counted in memory with filtering by address and
port and no packet sent.

**The order of a search.** A counter shared by the pool can produce neighbouring
ports, making early range coverage useful. The first proposal used the 16-bit
count with its bits reversed from a random start. Its raw 1,024-port prefix
lies 64 apart before reserved ports are excluded, so a pool whose ports are an
even distance apart is missed by half of the starts or more. The
[product's search](#random-mapping-collision-control) keeps the comb and
draws one port inside each of its 1,024 steps. With 256 sockets and 1,024
packets, 4,000 trials a row:

| Pool's ports | Distinct ports drawn at random | Bit-reversed count | One draw in each step |
| --- | --- | --- | --- |
| Drawn at random | 97.9% | 98.3% | 98.4% |
| Neighbours on a quiet counter | 98.0% | 100% | 100% |
| One counter, 1 port in 10 taken by others | 98.5% | 100% | 100% |
| One counter, 1 port in 2 taken by others | 98.2% | 99.6% | 99.7% |
| Every second port | 98.3% | 50.4% | 99.8% |
| Every fourth port | 98.3% | 25.5% | 98.9% |
| 64 apart | 98.4% | 3.5% | 98.5% |

On neighbours either comb arrives at a median of 126 packets and a random
draw at 166. `piik_nat::search::order` on the research line mirrors the
product's order for the simulator.

**A pool between two observations.** Where one counter serves every
destination, an observation just before the pool is made and one just after
bound the pool's ports. With others taking 800 ports a second from the
counter, twice what the hotspot showed, a pool of eight sockets was reached
within 52 packets in 95 of 100 trials and within 123 in all; a pool of 64
within 28 in all.

Together they suggest one form in place of separate paths for sequential and
irregular mappings: the side that cannot name its port pools toward the
other's endpoint between two observations and publishes, for each public
address it has seen, the window they bound when there is one; the other side
sends to the windows first and then to the whole range. The order inside a
window belongs to the comparison recorded
[above](#random-mapping-collision-control). Two sides that both cannot name a
port remain out of reach.

None of this starts from nothing. Predicting a port from a counter is the
[2003 draft](https://datatracker.ietf.org/doc/html/draft-takeda-symmetric-nat-traversal-00)
this document already cites, a pool against random probes is the
[analysis](https://tailscale.com/blog/how-nat-traversal-works) the product's
pool follows, and a
[2016 measurement](https://arxiv.org/abs/1605.05606) of carrier NATs found
ports kept, counted and drawn in comparable shares, from one destination per
session. A search on 2026-11-27, read from abstracts only, found no
measurement of a counter per destination and no search order that serves a
run and a draw alike; that is an absence in one search, not a claim of
novelty.

Two readings of the product's observation rest on the same data. It ends its
enhancement when its servers answer through different addresses, and ordinary
discovery goes on. Cloudflare and Google did so in every run on the hotspot
with three addresses and on a network with two (four runs and three); on the
campus with three addresses the two answered through one address in all four
runs.

The other reading is of the default servers. Three on one port read three
neighbouring ports from one socket in two campus runs, which the survey
classifies as sequential while a peer's destination would take another
counter. Of the present three on three ports the survey asked two.
Cloudflare on 3478 answered in 34 of the 35 runs and Google on 19302 in all
35, and the two lay more than 500 ports apart in every run on the two
networks with a counter per destination. In the twelve latest runs they
answered a first request at a median of 216 and 219 ms, and needed a second
request in 3 of 11 and 1 of 9 measurable runs. The two former defaults nearer
to these networks answered at 39 and 36 ms, but one of them left both
requests unanswered in 9 of the 24 runs that ask twice, while another port
of the same host answered. The third present default, on port 443, was never
asked. The report does not measure all three services together.
Physical two-sided runs are what would settle either reading;
[TODO](../todo.md) retains them.

The product sends its observation transactions from one socket and waits for
their replies together. One receive owner
matches each source and transaction; classification uses send order rather
than arrival order. The existing STUN client owns retransmission and the
1.5-second observation deadline is unchanged. In an owned Windows loopback
control with response delays of 400, 600 and 400 ms and the middle request
dropped once, the serial baseline timed out at 1.51 seconds; concurrent
observation completed in 905 ms on Windows and 902 ms on Linux.
Wrong-source and wrong-transaction packets did
not supply samples, silent servers timed out and released the socket, and
stable, increasing, decreasing and irregular classifications retained their
meaning. This establishes the scheduling benefit in that control, not worldwide
service reachability.

If DNS resolution finishes with fewer than three destinations or a STUN
transaction does not answer, preparation still uses the valid observations.
One response or equal partial replies supply an unclassified measured endpoint.
Two differing mapped ports on one public IP qualify for the irregular/pool role;
its peer can search from a retained measured endpoint. Only three complete replies
can supply a sequential hypothesis. This role selection uses current observations as in
[RFC 5780 sections 1 and 4.3](https://www.rfc-editor.org/rfc/rfc5780.html#section-4.3),
not an unconditional property of the network. Public-address conflicts end the
survey. Single-datagram rejection does not discard other replies, and the
existing destination, packet, concurrency and time budgets stay in place.

In a matched two-endpoint kernel-NAT control, one side preserved its port and
the other allocated sequentially, both with destination filtering. The third
STUN service was silent only for the port-preserving side. The former all-three
requirement delivered no application data or frame within 20 seconds. The
partial-observation candidate twice selected its authenticated socket on the
original RTC, delivered bidirectional SCTP, and decoded the first synthetic VP8
frame in 2.076 and 1.654 seconds. Both versions retained ordinary ICE at about
0.35 seconds when both sides preserved ports. Both failed when both sides
allocated sequentially and both lacked the third reply. These controls used
isolated routing and STUN services; they do not estimate public-network success.
The private signal change requires matching updated authority and Native builds.

A second fixed control used port-preserving NAT against kernel random SNAT,
destination filtering on both sides, and a silent third STUN service for each.
Eight interleaved trials of the unclassified two-response baseline delivered no
frame within 20 seconds; all eight trials using the two-response roles completed
authentication, selected the prepared tuple on the original RTC, delivered SCTP
both ways and decoded the first synthetic VP8 frame in 2.228–3.088 seconds.
Each successful pool opened 256 sockets; search stopped after 24–316 requests.
These are repeatability results for that topology, not a public success rate.
Single companion controls retained ordinary ICE with two port-preserving ends
and the measured partial-observation/full-sequential path. Two sequential ends with
only two replies each did not start a random pool and remained unreachable.
Choosing the irregular role releases the measured survey socket. Against a
sequential peer it forgoes the former single-target attempt; an unclassified
peer's measured target can instead support the existing pool. If that peer's
mapping also varies, the bounded search can fail. Ordinary ICE keeps its
independently gathered candidates.

The final plan keeps equal partial replies unclassified and searches from the
measured tuple. Follow-up controls decoded a VP8 frame in 2.734 seconds with two
replies on that side, and 2.438 seconds with just one, while the random-mapping
peer had two differing replies. Each ran once. When the named endpoint's mapping
also varied, the search exhausted 1,024 targets and the pool used 256 sockets
without completing authentication; ordinary ICE also failed in that control.
Every used UDP port could be rebound after retirement. A separate authenticated
control retained the sequential peer's alternate target when its primary failed.

### External Forwarding And Participant Relays

The October 2026 [frp v0.71.1](https://github.com/fatedier/frp/releases/tag/v0.71.1)
review established fixed-UDP forwarding feasibility, not an integrated Piik
provider. A public HTTP/WebSocket entry does not forward dynamic media sockets.
Current Server binding/public-address ownership belongs to the
[3.0 network model](./channel-network-design.md#reachability-and-repair).

- Keep STUN directly reachable. frp's [UDP forwarder](https://github.com/fatedier/frp/blob/v0.71.1/pkg/proto/udp/udp.go)
  opens a local socket per remote endpoint, so backend STUN observes frpc rather
  than the participant. Piik's listener does not interpret Proxy Protocol.
- The [UDP proxy](https://github.com/fatedier/frp/blob/v0.71.1/client/proxy/udp.go)
  frames datagrams into a work connection. Choosing QUIC does not make that path
  QUIC DATAGRAM or prove immunity to ordered-stream blocking.
- [XTCP](https://gofrp.org/en/docs/examples/xtcp/) needs frpc on both endpoints.
  The reviewed [VirtualNet](https://gofrp.org/en/docs/examples/virtualnet/) was
  an Alpha TUN/client deployment, not an ordinary Browser invitation mechanism.
- [Tailscale Peer Relays](https://tailscale.com/docs/features/peer-relay) likewise
  need reachable, authorized participants. Bandwidth alone cannot qualify a relay;
  Piik accepts no second graph or App-hosted SFU from this comparison.

The historical 2.x direct/frp SFU control delivered at least 30 byte-identical VP8
frames and 30 Opus packets per subscriber, with reverse PLI and sibling retirement.
The frp arm used TCP and blocked direct backend traffic. A paired STUN control
confirmed the changed source mapping. This did not test Browser decode, audible
audio, public performance, loss recovery or QUIC. Its fixed SFU recipe required
matching external/local UDP ports; that is not the current Rust configuration.

Historical participant-relay controls also retained local voice mute isolation.
A Pion-vnet Native relay retired a silent direct candidate, selected a friend
and committed after 30 decoded VP8 frames with reverse PLI. Friend departure
retired its resources; a new friend session recovered. These prove composition,
not external reachability or a field success rate.

## Iroh And Tailscale Comparison

Iroh's [NAT guide](https://docs.iroh.computer/concepts/nat-traversal) estimates
roughly nine-in-ten direct reachability; Tailscale
[reports above 90% in typical conditions](https://tailscale.com/blog/nat-traversal-improvements-pt-1).
Neither is a matched before/after measurement against Piik. Keep these direct
figures separate from [relay fallback](https://docs.iroh.computer/concepts/relays).

| Primary implementation | Reusable lesson; integration boundary |
| --- | --- |
| Tailscale v1.104.1 [DISCO](https://github.com/tailscale/tailscale/blob/v1.104.1/disco/disco.go) and [endpoints](https://github.com/tailscale/tailscale/blob/v1.104.1/wgengine/magicsock/endpoint.go) | Coordinate outbound probes, authenticate transactions and expire endpoint observations. Piik already has current-pair signaling, ICE checks and connection-owned discovery; no parallel peer-address database is needed. |
| [ICE peer-reflexive processing](https://www.rfc-editor.org/rfc/rfc8445.html#section-7.2.5.3) | ICE can learn endpoints different from advertised candidates. Preparation fixes one authenticated bounded tuple; accepting arbitrary reply ports would duplicate winner/nomination ownership. |
| [libp2p DCUtR](https://github.com/libp2p/specs/blob/master/relay/DCUtR.md#the-protocol) | Relative timing can synchronize sends. Measure RTT after both surveys; survey duration is not network RTT. Full Swarm/relay integration would duplicate Piik owners. |
| [netwatch monitor](https://github.com/TNTcraftHIM/net-tools/blob/0a61bb64facc469d015f5ba537dda57c94cdcb17/netwatch/src/netmon.rs) | Reuse interface snapshots/change events through the existing pair owner, without a polling controller. |
| [iroh 1.4.1](https://github.com/n0-computer/iroh/blob/v1.4.1/iroh/src/endpoint.rs), [noq](https://github.com/n0-computer/noq/blob/main/noq/src/connection.rs), [Magicsock](https://github.com/tailscale/tailscale/blob/main/wgengine/magicsock/magicsock.go) | Their QUIC/WireGuard traversal is not a drop-in Browser WebRTC socket. Piik already reuses lower-level noq-udp. Iroh's reviewed [Browser path](https://docs.iroh.computer/languages/wasm-browser) used relay traffic. |

[Network-change work](https://tailscale.com/blog/nat-traversal-improvements-pt-1)
and Iroh's [asymmetric repair](https://www.iroh.computer/blog/iroh-1-0-0-rc-1)
justify checking freshness and both initiator roles. Comparisons must hold endpoint
pairs, mapping/filtering, IPv6 and relay policy constant. The removed
[Go composition](#integration-cost-and-recovery-controls) established cost and
local feasibility, not a Browser-compatible reachability advantage.

### Browser-Compatible Follow-Up

These are research boundaries, not accepted framework or protocol upgrades:

- The [2026 DCUtR paper](https://arxiv.org/abs/2604.12484) measured 4.4 million
  attempts across more than 85,000 networks in December 2022–January 2023. Its
  roughly 70% success is conditional on relay reservation/address discovery;
  97.6% of successful punches used the first attempt. Proposed role reversal and
  probabilistic search were future work, not measured improvements. Separate
  preparation failures from punch failures before copying retries.
- [QUIC punching/migration](https://arxiv.org/abs/2408.01791) reported latency
  benefits against its own TCP/re-punch controls. [WebTransport](https://www.w3.org/TR/webtransport/)
  is Browser-to-server, not arbitrary UDP; [Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets)
  requires an installed Isolated Web App.
- [ICE renomination](https://datatracker.ietf.org/doc/draft-thatcher-tsvwg-renomination/)
  concerns path changes after connection. The historical Pion experiment below
  did not establish bidirectional stock-Browser interoperability; keep selection
  inside the framework rather than add a Piik path-selection loop.
- [SPED](https://datatracker.ietf.org/doc/draft-hancke-webrtc-sped/) overlaps ICE
  and DTLS establishment; [WARP](https://datatracker.ietf.org/doc/html/draft-uberti-tsvwg-warp-00)
  combines it with SCTP negotiation and DTLS 1.3. The July 2026 WARP model reduced
  media/data setup from six RTTs to two, with media at four RTTs in its baseline.
  This is handshake latency, not a new reachable NAT class. The reviewed
  [Pion ICE v5 RC](https://github.com/pion/ice/releases/tag/v5.0.0-rc.6) contained
  related work; draft expiry alone does not prove abandonment. Adoption still
  needs stable framework and negotiated stock-Browser support, not field flags
  or changed ICE consent.

## Historical 2.x Evidence

The released v2.8.0 research record owns the Go/Pion/LiveKit measurements,
including failed trials and experimental limits. ADR-0009 records the 2.x
optional-prediction decision. [v2.8.0 NAT research](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md), [ADR-0009](../adr/0009-optional-nat-prediction.md)

- Discovery and delivery controls cover STUN destination redundancy, Browser
  candidate deduplication and missing Viewer media behind Server NAT.
  [Public-link discovery](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#public-link-discovery-redundancy),
  [Browser preflight](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#browser-prediction-preflight),
  [SFU behind NAT](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#sfu-behind-server-nat)
- Native preparation controls cover same-socket STUN, gateway mapping and
  cancellation, selection attribution, and the limits of coordinated Go punching.
  Current 3.0 observations apply to one preparation.
  [Shared-socket preflight](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#native-shared-socket-preflight),
  [Gateway and survey limits](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#gateway-and-survey-limits),
  [Observation and attribution](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#independent-observation-and-attribution-preflight),
  [Rejected participant-wide NAT inference](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#rejected-product-inference),
  [Coordinated Native punching](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#coordinated-native-punching-assessment)
- Browser interoperability controls cover mDNS, ordinary ICE restart and
  asymmetric recovery under experimental renomination.
  [Stable Pion interoperability](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#stable-pion-interoperability),
  [Renomination preflight](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#pion-renomination-preflight)

The current 3.0 process controls exercise prepared and ordinary media over
kernel NAT. [Rust process controls](./network-lab.md#rust-process-controls)

### Integration Cost And Recovery Controls

The Go Magicsock composition required Native at both ends. The matched
direct-transport comparison found the same reachability across the seven tested
pairs. The historical record retains cold-start failure, package and memory
cost, and feedback datagram limits.
[v2.8.0 Magicsock controls](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#integration-cost-and-recovery-controls)

## Ordinary ICE And Media Recovery

The 2.x record covers the Browser bridge, generation handling, gateway and
address-family controls, per-connection sockets and mapping cache lifetime.
[Ordinary ICE and media recovery](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#ordinary-ice-and-media-recovery),
[Mapping cache and retries](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#native-mapping-cache-and-retry-lifetimes),
[Connection sockets](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#native-connection-socket-ownership)

### Recovery Ownership And Forwarding

The 2.x controls distinguish input readiness, the parent recovery budget and
fresh decoded pictures. The send-queue comparison covers the constrained-link
and short-loss behavior. [v2.8.0 recovery controls](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#recovery-ownership-and-forwarding),
[Send-queue assessment](./node-local-media-design.md#send-queue-recovery)

### Routed Virtual LAN Discovery

The virtual-LAN trial covers local STUN and packaged-App firewall behavior. A
separate control reproduced a path-MTU stall during startup resource transfer.
[Virtual-LAN discovery](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#routed-virtual-lan-discovery),
[Startup resource transfer](https://github.com/TNTcraftHIM/Piik/blob/81b4f27eff2a1de1dfe6131c06b525b7ba3508a8/docs/research/nat-traversal.md#startup-resource-transfer)

## Native ICE Disconnection And Send Consent

An in-process control at pinned SDK revision
[`2d0d6eaa`](https://github.com/TNTcraftHIM/str0m/tree/2d0d6eaaf4d19d7530588f695cd631eedf42acf5)
used two RTCs, real DTLS/SRTP and SCTP, and the SDK's virtual-time deadlines.
Suppressing both STUN directions produced `Disconnected` about 21.5 seconds
after the last successful response while the selected path still had permission
to send. Restoring STUN recovered the same RTC and credentials; the following
observation delivered 200 authenticated RTP packets and 200 SCTP messages.

Send permission expired at 30 seconds. Late authenticated STUN and re-adding the
old candidates produced no application output or STUN reply on the retired path.
Fresh ICE credentials or another tuple restored delivery, retaining the
[RFC 7675 consent boundary](https://www.rfc-editor.org/rfc/rfc7675.html#section-5.1).
The control used a read-only SDK query of its existing output authorization gate.
Native now preserves that recovery window and retires an established path when
the SDK no longer permits sending, including while ICE is checking an alternate.
A real Native regression preserved valid consent through ICE restart, and
expired consent released the connection and held remote input. The existing
SDK wakeups own expiry; no application timer was added.

A matching G50 Browser → Native → Native → Browser control retained the middle
pair and input identities through short STUN loss while the final viewer kept
decoding. After prolonged loss, the middle pair retired 30.023 seconds after its
last observed valid response and a fresh path resumed video. Separate mixed
controls adopted an actually decoded candidate on an already confirmed spare,
ignored its late proof after the original recovered, and respected a spare's
zero forwarding limit. These local controls used synthetic capture and owned UDP
bridges; cold three-hop discovery, Native GUI and independent-network acceptance
remain separate. They do not identify a field incident's cause or a NAT success rate.

## Primary Sources

- [RFC 8445: ICE](https://datatracker.ietf.org/doc/html/rfc8445)
- [RFC 4787: UDP NAT behavior](https://datatracker.ietf.org/doc/html/rfc4787)
- [RFC 5780: STUN behavior discovery](https://datatracker.ietf.org/doc/html/rfc5780)
- [Symmetric NAT prediction draft](https://datatracker.ietf.org/doc/html/draft-takeda-symmetric-nat-traversal-00)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
- [Chromium shared-socket STUN tests](https://webrtc.googlesource.com/src/+/refs/heads/main/p2p/base/stun_port_unittest.cc)
- [Tailscale mapping observations](https://github.com/tailscale/tailscale/blob/main/net/netcheck/netcheck.go)
- [libp2p Browser/DCUtR boundary](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md)
- [coturn endpoints](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
- [Cloudflare STUN service](https://developers.cloudflare.com/realtime/turn/)
- [Pion Universal UDP mux](https://github.com/pion/ice/blob/main/udp_mux_universal.go)
- [Pion dual-stack enumeration](https://github.com/pion/ice/blob/v4.4.0/udp_mux.go)
- [Go wildcard socket family selection](https://go.dev/src/net/ipsock_posix.go)
- [Selected-candidate statistics](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatestats-foundation)
- [Pinned 2.x NAT-PMP adapter](https://github.com/netbirdio/go-nat/blob/6b2c8c5c74e8331ed41811cfd2fdc4c3dd8c3ff0/natpmp.go)
- [NAT-PMP client calls](https://github.com/jackpal/go-nat-pmp/blob/v1.0.2/natpmp.go)
