# Browser And Native NAT Traversal

Last reviewed: 2026-11-16

This document owns evidence and its limits. Current 3.0 behavior belongs to the
[network model](./channel-network-design.md#reachability-and-repair), execution
methods to the [laboratory](./network-lab.md), and dependency pins to
[Native provenance](../../prototype/channel-native/README.md#rtc-dependency).
Current Rust results come first; the later Go/Pion/LiveKit sections are explicitly
historical 2.x evidence. An isolated candidate is not a delivered product feature.

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

Controlled results establish three separate improvements:

- A one-second signaling skew plus a lost first triggered request completed
  within the existing five-second preparation lifetime.
- Four intervening allocations defeated the single predicted target; the bounded
  alternative connected and carried advancing picture and sound with fewer
  requests. This covers one stable/sequential allocation-drift model.
- TCP-header controls isolated approximately 0.94 seconds of additional
  Ping/ACK skew. Disabling Nagle through existing Native/App/Domain socket APIs
  removed that component without removing the injected network delay.

The adapter also translates the selected ICE implementation's terminal boundary.
The reviewed [is 0.11.1 source](https://docs.rs/crate/is/0.11.1/source/src/agent.rs)
emits `Disconnected` when no nominated or viable candidate remains, with no later
`Failed` event; its default unanswered-check budget was about 21.5 seconds.
Native sends exhaustion to the existing pair failure/replacement owner. Browser
disconnection retains Browser semantics, and short interruptions remain SDK-owned.

### Native NAT64 Assessment

Native adds IPv6 aliases for numeric IPv4 UDP candidates through the SDK's public
API. One connection-scoped lookup of `ipv4only.arpa` discovers the prefix under
[RFC 7050](https://www.rfc-editor.org/rfc/rfc7050.html#section-3); synthesis follows
the six [RFC 6052 layouts](https://www.rfc-editor.org/rfc/rfc6052.html#section-2.2).
Initial ICE starts discovery once it has both a non-loopback IPv6 base and an
IPv4 peer candidate. Desktop interface refresh can supply the first usable IPv6
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
send all of them. Parallel survey remains a separate comparison.

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

The remaining sections preserve the measured reasons for published Go/Pion
repairs and rejected experiments. Their timeouts, policies, environment variables
and library details are not instructions for the 3.0 runtime. Git and PRs own
implementation history; [ADR-0009](../adr/0009-optional-nat-prediction.md) owns the
2.x optional-prediction decision.

### Public-Link Discovery Redundancy

A v1.9.2 report had working chat but failed media and only MiWiFi STUN responding;
it lacked paired ICE traces and prediction settings. The confirmed 2.x bug was
narrower: disabling prediction removed two ordinary fallback destinations. The
repair retained the same three services for ordinary discovery, without adding
providers, rankings or polling; LAN discovery stayed separate.

October 11, 2026 controls found each service usable independently. `701` events
could coexist with useful candidates. A healthy destination completed after
55 ms beside two failing DNS targets, or 4 ms beside a silent UDP target while
gathering remained unfinished at 15 seconds. Closed ports were not equivalent
to silent drops. Chromium's [candidate path](https://webrtc.googlesource.com/src/+/refs/heads/main/p2p/base/stun_port.cc)
and the [candidate-error specification](https://www.w3.org/TR/webrtc/#rtcicecandidateerrorevent)
explain why neither error events nor gathering completion alone diagnose failure.

Extra-destination regressions also required keeping destination identity until
filtering against the attempt's survey set: an ordinary duplicate or fourth
response must not supply prediction evidence. These repairs do not establish
the original report's cause, whose configuration had three destinations.

### SFU Behind Server NAT

The October 9, 2026 kernel-NAT control used real 2.x SFU owners, `SFU_ONLY`,
same-port UDP forwarding and `SFU_PUBLIC_IP`, with private shortcuts blocked.
Browser VP8/Opus and Windows Native H264/Opus passed startup, 720p→480p changes,
subscription recovery and retirement. The Native control decoded 300 720p frames;
the hash-matched v1.9.2 artifacts also passed startup/recovery, but excluded the
separately repaired reauthentication-after-local-loss case.

Viewer-only UDP blocking preserved Host ingress and downtrack binding but no
Viewer RTP/decode; failure occurred around 15 seconds. Allowing STUN/DTLS while
discarding Viewer RTP/RTCP connected both endpoints but reached the existing
20-second operation deadline without frames. A bound track or connected PC is
not Viewer readiness. These desktop controls did not establish phone/carrier
coverage or change product deadlines.

## Browser Prediction Preflight

September 2026 Chrome 151 controls reached self-hosted and Cloudflare STUN
independently, while all six combined runs exposed one deduplicated srflx
endpoint. This remained `unknown`, not evidence of EIM. ICE restart changed one
mapping; acceptance of a documentation-address candidate proved syntax only.
Neither guaranteed a new socket or an authenticated predicted path.

Browser events report completed observations, not send/allocation order. A
controlled four-by-four namespace baseline then found bounded prediction useful
for sequential-to-restricted pairs in 14/15 runs. Sequential-to-sequential pairs
remained sensitive to ordering and intervening allocations. This supported the
bounded experiment, not a participant-wide classifier or field percentage.

## Current Decision

**Historical 2.x decision:** ordinary STUN remained discovery. Public-link App
mode kept three ordinary public services and reused them for prediction; optional
Site listeners used same-host ports 3479/3480. LAN used its local endpoint.
Pages requested the P2P-first capability, while the accepted share policy aligned
Host/Viewer/relay behavior and retained older per-share preferences.

Three eligible arithmetic srflx observations yielded a small two-sided window.
Ordinary candidates trickled immediately; Browser evidence used STUN URL and
Native evidence used marked same-media-socket survey results, excluding gateway
mappings. Prediction changed neither NAT labels nor route/SFU preference.
Current 3.0 behavior is instead owned by the [network model](./channel-network-design.md#reachability-and-repair).

### Native Shared-Socket Preflight

September 5, 2026 disproved the assumption that ordinary Pion STUN gathering
already shared the media socket: three destinations used three temporary ports.
UniversalUDPMux supplied same-socket observations, verified by candidate related
port and 35 H264 RTP packets delivered to an independent Linux Pion Viewer. The
TUN network exposed one mapping, so no predicted-path gain was claimed. The
[later cache repair](#native-mapping-cache-and-retry-lifetimes) separately addressed
freshness across retries.

The 2.x dual-stack mux retained IPv4 when IPv6 was absent and supplied usable
IPv6 candidates without proving firewall reachability. Optional gateway mapping
ran alongside ordinary gathering on that socket; a synthetic forwarding control
connected ICE/DTLS through its mapped candidate in 1.26 seconds. This established
composition, not physical NAT rescue.

### Gateway And Survey Limits

The 2.x [scoped go-nat repairs](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/thirdparty/README.md)
retained gateway-assigned ports, propagated cancellation and attempted
[NAT-PMP lifetime-zero deletion](https://www.rfc-editor.org/rfc/rfc6886.html#section-3.4).
PCPv6 work had a two-second sub-bound inside the three-second mapping call so
silent IPv6 could not discard successful IPv4 work. Retirement canceled and
joined mapping creation before bounded cleanup; unreachable gateways could
still leave leases to expire. Failed mapping was not relaunched on the same
connection. These caller/cleanup/lease lifetimes were independent of ICE.

Listener startup and self-probes did not prove external reachability. Debug
could report provenance/selection without retaining private endpoint details;
packet logs stayed disabled. Zero predicted selections alone was not evidence
of a broken predictor or a success rate.

### Independent Observation And Attribution Preflight

September 1, 2026 Chrome controls found self-hosted, Xiaomi, Bilibili and
Cloudflare individually reachable; QQ produced no srflx in that run. A loopback
connection selected a test-marked `sp1` foundation, proving attribution mechanics,
not reachability benefit. Historical field observations emitted six hypotheses
in one generation and selected none; later generations lacked an arithmetic
shape. Ordinary ICE/SFU remained independent. Provider configuration and this
dated reachability sample are different owners.

### Rejected Product Inference

RFC 5780 observations vary with source port, destination and time; mapping and
filtering differ. Deduplicated Browser srflx output cannot distinguish equal
mappings from unanswered probes. Therefore samples cannot skip a P2P candidate,
change the committed graph or become a persistent `eim | edm` capability.
The 2.x experiment added no such routing state. Current 3.x typed observations
likewise describe one preparation, not permanent participants.

### Coordinated Native Punching Assessment

The October 2026 Go/Pion experiment is historical. Public comparison came from
[frp's strategy table](https://github.com/fatedier/frp/blob/2542d11a6201c0f2bbe3b1d93031fc1e83201056/pkg/nathole/analysis.go)
and [EasyTier's Native implementation](https://github.com/EasyTier/EasyTier/blob/1649ec00135e12103e05bf543e0ed313d7e190f8/easytier-core/src/connectivity/hole_punch/udp/client.rs).
Their socket/random-search budgets establish mechanisms, not Piik defaults.

The isolated comparison separated ordinary ICE, eight predicted candidates,
ordered first-tuple coordination, eight-socket coordination, and ordinary ICE
over eight preallocated sockets. In sequential endpoint-dependent NAT, three
intervening mappings defeated the first guess while the coordinated pool could
connect; favorable ICE scheduling could also make prediction succeed. Six
intervening allocations or blocked UDP defeated the pool. Merely allocating
sockets was not the same mechanism.

The isolated prototype used eight sockets, ≤64 requests plus 64 replies and a
four-second overall deadline. A 100 ms peer skew passed; 350 ms exceeded its
200 ms overlap. The later 2.x
integration adopted the winner only on a server-issued retry, before creating
Pion, and passed SRTP/SRTCP with 250 ms skew inside its 800 ms send/1.1s hard bound.
The stable/sequential repair retained the exact survey socket; mixed, stable and
sequential controls passed. Browser peers declined Native preparation. These
predate the 3.x random-port collision implementation.

Dropped-first-request and 250 ms delayed-response survey controls recovered;
a silent destination exhausted the existing 1.5s survey budget and fell back.
The archived [Browser fanout control](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/scripts/app-browser-fanout-gate.ts)
kept two Viewers near 30 fps through quality/pause/audio/App-exit changes using
loopback STUN. The [process laboratory](./network-lab.md#running-the-process-layer)
adds real kernel-NAT/media evidence; neither proves physical-network prevalence.

### Stable Pion Interoperability

The historical WebRTC v4.2.24 / ICE v4.4.8 candidate included
[retransmission, generation and mux/mDNS fixes](https://github.com/pion/ice/compare/v4.4.0...v4.4.8).
[PR #1026](https://github.com/pion/ice/pull/1026) corrected Binding PRIORITY to
peer-reflexive preference, avoiding a possible acceptance wait. DTLS v3.1.13
included [buffer/handshake repairs](https://github.com/pion/dtls/compare/v3.1.10...v3.1.13).
These improve setup correctness, not reachable NAT classes.

A Chrome 152 control reproduced the [mDNS query incompatibility](https://github.com/pion/mdns/commit/5b0a717e4ff6e81300d54ce2fef53e635b95fe3c):
fresh v2.1.0 timed out at four seconds, v2.2.2 resolved the same name in about
12 ms, and another old resolver timed out. Chrome/Firefox ordinary restart
controls retained VP8, reverse RTCP and data after path loss. The upgrade did not
remove Piik's fresh-interface and STUN-cache repairs or enable renomination.

### Pion Renomination Preflight

Automatic renomination remained disabled. The historical two-path control
recovered Chromium 152 video/feedback without new SDP after about 5.6s. Firefox
151.0.3 resumed video at about 5.7s but kept the failed outbound path: reverse
RTCP and echoed data stayed absent for the 20s observation. Explicit ICE restart
restored both. Both Browsers advertised only `trickle` while Pion sent an older
nomination attribute; steady Binding requests rose from 3 to 27–75 per five
seconds. Fresh video alone did not establish interoperable migration. Reopening
requires negotiated Browser support and bounded costs, not UA exceptions.

### Integration Cost And Recovery Controls

**Magicsock integration is not planned.** The removed Go experiment required
Native transport at both ends and showed no additional direct NAT class worth
its composition cost. It is not a maintained module or an implementation checklist.

#### October 12 Direct-Transport Control

The [Tailscale v1.104.1](https://github.com/tailscale/tailscale/releases/tag/v1.104.1)
raw-Bind comparison and Pion v4.2.23/ICE v4.4.7 had the same seven-pair outcome at
4s and 20s: cone/cone, restricted/restricted and cone/hard in either direction
connected; restricted/hard and hard/hard did not. Warmed Magicsock carried media
through two address changes, but cold loss of the first discovery packets
exhausted nested ICE near 1.7s. Equivalent stock Pion connected near 0.6s;
extending only the fixture budget allowed nested startup near 5.3s. Raw Bind also
needed framing for inner STUN and did not itself preserve peer authorization.

#### Reachability And Cost

October 5–10 controls used [Tailcat](https://github.com/tailscale/tailcat/blob/b4dc28e8aa8936f0a90a41ad8293a64e3d6b645f/README.md),
whose pinned Browser path was relay-only; the [Browser P2P proposal](https://github.com/tailscale/tailscale/issues/21027)
uses WebRTC. DERP reached otherwise blocked cases, establishing relay coverage
rather than added P2P classes. Some local-address changes recovered without SDP,
but rebinding/long interruptions had separate failures. Optional multi-mux reuse
worked locally with patched dependencies, not as a supported plug-in.

Matched stripped Windows builds grew 44.1→59.8 MiB; a four-Viewer comparison
peaked at 81.8/93.2 MiB RSS for ordinary/optional transport, excluding codec and
Browser processes. Final goroutines returned to baseline. These are bounded
composition measurements, not sustained or per-room budgets.

#### Integration Boundaries

The removed composition needed separate handling for direct-only policy while
retaining discovery, cold-start timing, late authorization/revocation, listener
filter lifetime and optional candidate admission. None justified a product owner.
Its 1232-byte payload ceiling also lost observed 1244-byte encrypted TWCC reports
and larger compound batches; reducing RTP size did not fix feedback. The
[upstream feedback-MTU issue](https://github.com/pion/interceptor/issues/416)
records that boundary. Relay traffic had to be counted separately: selected
direct addresses and diagnostic Pong responses did not prove direct media.

#### Scope Of The Historical Evidence

Pion/LiveKit overlays carried H264/VP8 and Opus with Browser decoding,
authorization and retirement when ordinary remote candidates were withheld.
This proved local composition only, not physical capture, harder-network gain,
broad mobile support or sustained reliability. The removed overlay is not an
acceptance entrypoint; independent ordinary-media findings follow.

## Ordinary ICE And Media Recovery

These 2.x repairs apply without Magicsock. Current Rust recovery belongs to
[Rust integration](#rust-integration) and the network owner.

### Interface Refresh And Local Browser Bridge

Pion v4.4.0's [wildcard mux](https://github.com/pion/ice/blob/v4.4.0/udp_mux.go)
kept a stale interface snapshot across gatherings. Restart and new connections
could advertise a removed address; taking a current private snapshot fixed both
while retaining the socket. Newer Pion still required that adapter.

Loopback was not a portable Browser bridge: Chrome 154 decoded through 127.0.0.1,
Firefox 155 did not, and Firefox decoded through a non-loopback pair. Mozilla
[disables ICE loopback by default](https://searchfox.org/firefox-main/source/modules/libpref/init/all.js).
Complete App controls after LAN-address change showed Firefox Host termination
and Viewer fallback. Standard ICE restart with the existing disconnect grace,
complete SDP and request-ID fencing retained the same tracks and fresh pictures;
replacing only the Native PC instead appeared connected without fresh media.
This supports shared negotiation ownership, not physical roaming coverage.

### Candidate Generations Across App Control

The October 24, 2026 restart control lost new survey candidates when an old App
WebSocket gathering completion arrived after the room's new SDP offer. A writer
check cannot recall a delivered event. The 2.x repair retained the emitter across
SDP exchanges, used each candidate's actual ufrag and scoped completion, following
[RFC 8838](https://www.rfc-editor.org/rfc/rfc8838.html#section-13) and
[WebRTC candidate processing](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addicecandidate).
Pion's own queued events also needed source-generation filtering; only the merged
collector completed supplemental discovery. Candidate `OperationError` was
isolated so later candidates and SDP answers could proceed, consistent with
[addIceCandidate](https://www.w3.org/TR/webrtc/#dom-peerconnection-addicecandidate).

### Recovery Ownership And Forwarding

Three distinct 2.x failures retained separate owners:

- A late Pion `connecting` callback could disable an already-recovered input
  bridge. Reading current PC state at consumption restored readiness; prior loss
  still revoked permission and required a fresh handshake.
- Backend replacement renewed the Viewer's recovery count. The existing
  [parent opportunity](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/routing-transport.md#reconciliation) now owns
  that budget. Trickle controls recovered after 2/9/11-second interruptions;
  failed full-gathering while offline did not justify longer product deadlines.
- A throttled encoded queue retained stale pictures after short UDP loss.
  Forwarder counts preceded actual writes. The
  [send-queue assessment](./node-local-media-design.md#send-queue-recovery) owns
  the correction and constrained-bandwidth comparison; six local controls then
  retained fresh decoding. This does not explain every blur/stall report.

The [Viewer control-retirement repair](https://github.com/TNTcraftHIM/Piik/blob/main/docs/research/native-client-lifecycle.md#viewer-control-retirement)
separately fixed a denied Viewer retaining its App slot across invitations.

### Gateway And Address-Family Controls

Kernel controls with actual 2.x Native Engine Host/Viewer media showed ordinary
discovery survived absent gateway service and either usable IP family could
carry media when the other was blocked. Sequential NAT used prediction with the
changing gateway on either endpoint; random-port controls stayed unreachable.
A real MiniUPnPd gateway made hard/hard reachable through explicit mapping.
Matched Tailcat controls required its optional portmapper and fair STUN inputs
but added no direct path. These were encoded-media controls, not physical capture,
complete room admission, Browser decode or field rates.

## Native Mapping Cache And Retry Lifetimes

The 2.x Pion/shared-mux repair addressed its 25-second completed STUN cache,
which outlived replacement edges and ICE restart. A retained-Engine control
re-emitted an old mapping after the fixture changed; replacing the Engine hid
the defect. In vnet, four quick fresh agents failed before cache expiry, while
fresh gathering afterward connected; an independent-filtering peer could recover
through peer-reflexive discovery. The injected one-second NAT lease was a test
input, not a router-prevalence claim or four product operation timeouts.

The fix retained the socket and used Pion STUN transactions afresh, sharing only
concurrent requests within the current survey. Delayed valid old responses and
unmatched responses could no longer satisfy a successor. Gateway refresh likewise
belonged to an actual gathering rather than half-lease reuse; ordinary SDP
renegotiation did neither. No periodic probe/retry owner was added.

A Chrome 152 control independently observed fresh Binding requests/current
mappings across four restarts and four replacement PCs, including retransmission
after loss. This did not prove Firefox/Safari behavior, connected media or a
physical NAT change. The general lesson is to retain production-owned resources
while varying the external condition; recreating everything masks stale caches.

## Native Connection Socket Ownership

In 2.x Native overlap, the replacement connected and then the incumbent stopped
receiving RTP: both used one local/remote tuple, while Pion's non-STUN mux keyed
the peer by address/port. New ICE credentials did not separate DTLS/SRTP sessions,
an [upstream-documented limitation](https://github.com/pion/webrtc/discussions/2598).
The fix gave each physical send/receive/SFU publication its own socket; STUN,
gateway and media still shared that socket, and ICE restart retained it.

Real SRTP controls preserved sibling media through commit/rollback against an
unchanged listener. Failed admission released its socket; gateway work canceled
and cleanup preceded socket release to avoid deleting a recycled port. This
changed neither fixed service ports nor route policy, and did not identify an
unmatched field report's cause.

## Routed Virtual LAN Discovery

A two-Windows-device UU trial on October 20, 2026 had working HTTP/WebSocket but
stalled on remote Browser `.local` ICE candidates. Substituting the verified
virtual IP restored pictures; removing it reproduced the stall. A subsequent
control used ordinary local STUN instead of substitution, advertised the virtual
srflx address and decoded 1920×1080 near 20 fps, about 32 ms RTT and no sampled loss.
This matches [mDNS candidate guidance](https://rtcweb-wg.github.io/mdns-ice-candidates/draft-ietf-mmusic-mdns-ice-candidates.html):
numeric reflexive candidates remain available while [mDNS is local-link](https://www.rfc-editor.org/rfc/rfc6762).

The direct packaged-App invitation initially failed before reaching Piik because
Windows treated the virtual adapter as Public and lacked an executable-specific
inbound rule. With owner-approved rules limited to that App/adapter/subnet, page
and picture worked without proxy, candidate substitution or Browser privacy
changes. This was one controlled virtual-LAN result, not campus-network coverage
or permission to change a user's current firewall/network.

### Startup Resource Transfer

Title-only loading occurs before ICE/STUN. In the historical startup control,
compression reduced a script from about 674 KB to 194 KB and a 64 KiB/s load from
11.0 to 3.2 seconds. A separate hidden-1280-MTU/no-ICMP TCP control delivered the
712-byte HTML but no script bytes in 18 seconds; setting only its isolated SYN
MSS to 1240 delivered the script in about 8 ms. This reproduces
[path-MTU black holes](https://www.rfc-editor.org/rfc/rfc2923), not the cause of an
unmatched field loading report. Compression and endpoint MTU below 1500 alone
do not exclude that failure.

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
