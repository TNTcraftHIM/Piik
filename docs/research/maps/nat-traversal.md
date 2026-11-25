# NAT traversal map: how two participants obtain a direct connection

Mapping pass, read-only, at `a0dd6ea6` on `refactor/claude-review`. Labels:
**[code]** read in source (path:line), **[doc]** a document claims it (named),
**[measured]** a recorded measurement (named), **[ext]** an external primary
source (URL in the sources section), **[arith]** arithmetic the reviewer can
redo. Paths are relative to the repository root unless stated otherwise.

## Summary

The channel authority (Rust core, `prototype/channel-core`) chooses which
endpoint pairs to try and owns one attempt record per pair in `TransportBook`
[code: transport.rs:117-125]. An attempt is "confirmed" only when both
endpoints report `LinkState::Connected` from their current signaling sockets
[code: transport.rs:723-751]. Native reports Connected on str0m's ICE+DTLS
`Connected`; a Browser reports it on `RTCPeerConnection.connectionState ==
"connected"` [code: peer/transport.rs:2200-2212; media.ts:206-209, transport.ts:154-162].

Every pair first runs **ordinary ICE** through the platform stack (str0m on
Native, the browser's WebRTC on Browser) with the channel's configured ICE
servers. By default those are three public STUN servers and no TURN
[code: channel-server/src/lib.rs:126-144]. Two additions exist, and both are
Native-only:

1. **Linear hypotheses.** A Native on a pair that cannot be prepared (its peer
   is a Browser, the Server, or STUN is under-configured) looks at the first
   three STUN results from one IPv4 base. If the three ports form an arithmetic
   sequence with step 1..16 in either direction, it trickles up to 16 guessed
   srflx candidates for its *own* next mappings: 8 steps below the first port
   and 8 above the last. Only Browsers use them; Native receivers drop them.
   Both sides stop after 5 s [code: peer/linear.rs:46-94; peer/transport.rs:1421-1429, 1855-1860;
   linear-ice-candidate.ts:5-16].
2. **Coordinated UDP preparation.** This runs only between two Natives, and
   only *after* their ordinary attempt has failed. A Native-Native pair marked
   `Available` gets a fixed 5 s ordinary ICE deadline [code: peer.rs:2139-2148].
   On `Failed`, the book replaces the attempt with a `Prepared` one (new UUID,
   new 20 s book deadline) [code: channel.rs:365-367, transport.rs:782-796].
   Both Natives then run a separate 5 s preparation [code: preparation.rs:76]:
   each surveys three STUN destinations from one fresh socket and classifies
   itself `Stable | Sequential | Irregular`. They exchange the observation and
   a shared secret through the channel, then probe with authenticated STUN
   Binding requests:
   - stable or sequential pairs use bounded predicted targets;
   - a Stable/Irregular pair uses a birthday search: the irregular side opens
     **256 sockets** toward the stable tuple, and the stable side probes
     **512 distinct random ports** at ≥2 ms spacing.
   If both sides complete, the winning socket and peer tuple go to the ordinary
   RTC as a remote host candidate. Otherwise ordinary ICE runs again without
   them [code: preparation.rs:148-630; peer.rs:2224-2283].

The core learns nothing about NATs. Classification exists only inside one
preparation, from three sequential Binding transactions. It uses no RFC 5780
tests, measures no filtering, and keeps nothing between attempts
[code: preparation.rs:321-374].

On failure the book records the edge as rejected with a **5 s cooldown**
[code: transport.rs:798-835]. A failed edge is tried again only while some
delivery is still *waiting* for it (a "required retry"). Standby and room
interest never retry while the same signaling socket generations persist
[code: transport.rs:260-267; discovery.rs:446-619]. When direct fails, the
fallback is a relay. That can be a participant chosen by the room planner, a
Server offering transit, or TURN if an operator configured it.

What was measured is controlled Linux kernel-NAT namespaces with small counts:
2 of 5, 2 of 3, and 1 natural trial at the current 512-target setting. There is
no field rate, no Windows/macOS timing, and nothing on CGNAT or hairpin
(sources in "What was measured").

---

## 1. Which pair the channel tries, and when (channel core)

**Where.** `prototype/channel-core/src/channel/discovery.rs:657-784` builds a
`DiscoveryPlan`, then `TransportBook::reconcile_with_fallback`
(`transport.rs:216-416`) admits attempts. Graph helpers are in
`prototype/channel-core/src/connectivity.rs`.

**Trigger.** `Channel::reconcile()` runs after any broadcast-worthy command:
join, link state, signal-driven changes, room syncs. It also runs from
`expire_discovery` [code: channel.rs:399-401, 454-460]. The Server calls
`expire` once per second [code: channel-server/src/domain.rs:852-857].

**Steps [code].**

```
interests = {}
standby(online peers, confirmed graph)        -> Interest::Channel   (connectivity.rs:6-44: DFS tree/back edges + ring neighbours,
                                                                       a rejected ring neighbour unlocks the next one in that direction)
for each room with an online host and projection:
    standby(room scope, room graph)           -> Interest::Room
    confirmed requested pairs                 -> Activity / Delivery (waiting)
    repair(): for each requested (source, viewer) pair       (discovery.rs:434-628)
        if waiting and a previously confirmed edge failed -> retry_candidate -> required_retries
        if direct not rejected and not confirmed          -> keep direct (Activity), completion
        else if waiting: relay suggestion on confirmed paths, else repair_candidate
                         (one missing link across the gap), else retry_candidate over failures
                         (oldest cooldown first); rejected trial -> required_retries
    ordinary(): connectivity::candidate (one missing link restoring a demanded path;
                 after a failed primary also one alternative)   (discovery.rs:630-654)
retain_failures(relevant)                                       (discovery.rs:726-728)
TransportBook.reconcile_with_fallback(...)
```

**Admission limits [code].** These are `PAIR_DEGREE_LIMIT = 64` pending or
established pairs per ordinary endpoint (`transport.rs:17`; a registered service
gets `MAX_SESSIONS − 1`, `discovery.rs:748-754`), `CHANNEL_ATTEMPT_LIMIT = 4`
concurrent attempts per channel (`transport.rs:19`) and
`ENDPOINT_ATTEMPT_LIMIT = 2` per endpoint (`transport.rs:20`). Only one
standby (Room/Channel) attempt may be pending at a time (`transport.rs:295-307`).

**Rank order [code: transport.rs:356-373].** Candidates are ranked
`Restoration` (a required retry of a previously confirmed edge), then
`Completion` (completes a path), then `Activity`, `Room`, `Channel`. Ties go to
the earlier retry time, then pair order. Admission may evict lower-interest
unleased attempts (`admit`, `transport.rs:535-653`).

**What a "pair" is.** A pair is keyed by the two endpoint session IDs. A
`DiscoveryEdge` adds the two current *signaling connection* IDs
(`transport.rs:80-102`). A failure is therefore remembered per signaling
generation, and a reconnect makes a fresh edge.

**Doc.** The forwarding plan describes the same limits ("four simultaneous
attempts per channel and two per endpoint. Standby discovery remains serial")
[doc: channel-forwarding-plan.md:101-117] and the 64-pair degree
[doc: channel-forwarding-plan.md:152].

## 2. Attempt lifecycle in `TransportBook` (deadlines, confirmation, prepare, cooldown)

**Where.** `prototype/channel-core/src/transport.rs`. Commands are handled in
`prototype/channel-core/src/channel.rs:273-384`.

| Event | Code | Effect |
|---|---|---|
| Admission | `start_discovery`, transport.rs:418-430 | `Pending.deadline = now + DISCOVERY_TIMEOUT_MS (20_000)`. A previously confirmed edge is marked `restoring`. |
| Snapshot to endpoints | `snapshot`, transport.rs:843-878 | `udp_preparation = Required` if the attempt is `Prepared`. It is `Available` if `Ordinary`, no side has confirmed yet, and `can_prepare_udp(both)`. Otherwise `None`. |
| `can_prepare_udp` | channel.rs:169-177 | `udp::stun_servers(ice_servers).is_some()` (at least 3 distinct `stun:host[:port]` authorities, udp.rs:13-34), and both sessions joined with `can_prepare_udp: true` and are online. |
| Who claims capability | session.rs:867 | Native: `can_prepare_udp = config.server_udp.is_none()`, i.e. every Native except the Server. Browser: never sent, defaults to `false` (wire.rs:28-29). |
| `LinkState::Connected` | channel.rs:345-364 → `connected`, transport.rs:723-751 | Records `confirmed_by[side] = signaling connection`. When both match the current connections, the attempt is confirmed and `discovery` is removed (no deadline). |
| `LinkState::Disconnected` | channel.rs:335-344 | Recorded per side. Does not end the pair. |
| `LinkState::Failed` | channel.rs:365-383 | If `can_prepare_udp(both)` and `prepare(pair_id)` succeeds, the pair becomes **Prepared**. Otherwise **retire**. |
| `prepare` | transport.rs:782-796 | Only if `attempt == Ordinary` and `confirmed_by == [None, None]`. Sets a new pair UUID, `attempt = Prepared` and `deadline = now + 20_000`. |
| `retire` | transport.rs:818-835 | Removes the pair. Inserts `rejected[edge] = {retry_after: now + REQUIRED_RETRY_MS (5_000)}`. Room sync for affected rooms (channel.rs:370-381). |
| Deadline expiry | `expire_discovery`, transport.rs:798-816 | Removes the pair and inserts `rejected` with `retry_after = now + 5_000`. |
| Retry eligibility | transport.rs:260-267 | A rejected edge is requested again only if `retry_after <= now` **and** it is in `required_retries`. |
| Forgetting a failure | `retain_failures`, discovery.rs:726-728 | A rejection is dropped once it is no longer in any interest or relevant failure set. A new signaling connection gives a new `DiscoveryEdge`. |

**Required retries [code: discovery.rs:471-506, 582-589; connectivity.rs:66-96].**
A failed edge becomes a required retry when a requested `(source, viewer)` pair
is **waiting**. Waiting means no `selected` flow exists for that
publication/receiver yet [code: host.rs:451-481]. The retried edge is either a
previously confirmed edge that failed, or the trial picked for the gap
(`retry_candidate`: the direct pair, or a failed edge joining the
source/receiver components, oldest cooldown first). Once any path serves the
viewer, waiting is false and the failed direct pair is not retried
[code: discovery.rs:526-528].

**Doc.**
- "With unchanged endpoint signaling generations, a failed required physical
  pair becomes eligible again after the channel's five-second cooldown."
- "Optional and idle failures do not schedule retries. A prepared replacement
  has its own physical ID and twenty-second deadline."

[doc: channel-network-design.md:683-699]. These match the code.

**Test.** `prepared_attempt_gets_its_own_timeout_and_only_required_delivery_retries`
[code: transport.rs:1331-1379].

## 3. Ordinary Native transport (sockets, candidates, STUN, gateway, TURN, IPv6)

**Where.** `prototype/channel-native/src/peer.rs` (pair driver) and
`peer/transport.rs` (socket owner and str0m engine). Discovery is in
`peer/discovery.rs`, gateway mapping in `peer/mapping.rs`, TURN in
`peer/turn.rs`, NAT64 in `peer/nat64.rs`.

**Trigger.** A projection carries a new `PairInfo`. When `udp_preparation !=
Required`, the driver calls `create_pair` [code: peer.rs:2023-2066]. There is
one acquisition per pair UUID [code: peer.rs:2025-2032].

**Sockets [code: peer/transport.rs:784-837].**
- `udp_preparation == Available`: IPv4 is the **runtime-shared** `0.0.0.0:0`
  socket, created once and then reused by every Available pair of that runtime
  (814-831). IPv6 is a per-pair `[::]:0`.
- `None`, or `Required` without a prepared socket: per-pair exclusive
  `0.0.0.0:0` and `[::]:0`.
- `Required` with a prepared socket: the prepared IPv4 socket plus a per-pair
  `[::]:0` (802-805).
- Server: its fixed listeners only (796-801), and never prepared.
- `linear` is enabled only when `preparation.is_none()`, the transport is not
  the Server's and there is no prepared socket (784-785).

**Host candidates [code: peer/transport.rs:74-97, 914-947].** For a wildcard
socket, every *up* interface address of the socket's family becomes a
candidate. Excluded: unspecified, loopback, IPv6 link-local, and IPv6
tentative/duplicated. VPN and virtual-LAN adapters are therefore included.
There are at most `MAX_ICE_CANDIDATES = 128` bases [code: peer.rs:125]. On
desktop, while ICE has not yet selected a path, new interface addresses on the
wildcard IPv6 socket are added from the netwatch monitor
[code: transport.rs:1136-1174, 1839-1854].

**STUN discovery [code: peer/discovery.rs:171-213, 255-382].**
- Every configured `stun:` URL (TURN excluded) is resolved with a 5 s DNS
  timeout, keeping at most one IPv4 and one IPv6 address per URL.
- One Binding transaction runs per (base, server) pair of matching family, with
  at most 128 attempted pairs and 128 routes.
- Transactions use the `rtc-stun 0.21.1` client: `DEFAULT_RTO = 300 ms`,
  retransmission at `(attempt+1)·RTO` (so 0, 0.3, 0.9, 1.8 s, …),
  `DEFAULT_MAX_ATTEMPTS = 7` [code: ~/.cargo/registry/.../rtc-stun-0.21.1/src/client.rs:18-20, 50-52].
- Each success becomes an srflx candidate and is signaled.

**Gateway mapping (UPnP / NAT-PMP / PCP) [code: peer/mapping.rs:24-152;
peer/transport.rs:536-554, 563-573; peer.rs:2964-2970].**
- `portmapper 0.20.0`, a fork pinned at `d13e8336` [doc: channel-native/README.md:229-246],
  does the probe, protocol choice and renewal.
- Eligible base: a UDP IPv4 host candidate whose IP equals
  `HomeRouter.my_ip` (the default gateway's local address) (`select_base`,
  112-131).
- Shared Available socket: one runtime-level mapping, published to every
  engine that shares it. Exclusive sockets: one mapping per pair, started on
  the first eligible host-candidate event.
- Each external-address update becomes an srflx candidate (`forward`,
  134-152). No public-address validation was found.
- Never on the Server (`server_udp.is_none()` check). Best-effort
  `deactivate()` on close.

**TURN.** Configured `turn:`/`turns:` URLs (UDP/TCP/TLS) are allocated per pair
via `rtc-turn` [code: peer/turn.rs:18-80]. None are configured by default.

**IPv6 / NAT64.** IPv6 ordinary ICE runs on the per-pair `[::]:0`. NAT64
aliases come from one `ipv4only.arpa` lookup (5 s timeout) and are added for
IPv4 remote candidates while ICE has not connected
[code: peer/discovery.rs:216-253; peer/nat64.rs:9, 56; transport.rs:983-984, 1861-1869].

**ICE timing (SDK) [code: str0m checkout `2d0d6ea`, crates/is].**
- Pacing `timing_advance = 50 ms` (agent.rs:366).
- Check RTO starts at 250 ms and doubles to a 3000 ms cap, with
  `DEFAULT_MAX_RETRANSMITS = 9` (stun.rs:12, 63-71). The successful-pair
  timeout is 21.5 s (stun.rs:21-29).
- Consent `EXPIRY = 30 s` (consent.rs:11).
- *Caveat:* the pinned revision is `5f1f6346`
  [code: channel-native/Cargo.toml:62]. Only `2d0d6ea` is checked out locally,
  so these values are not verified at the pin. The NAT doc reports the same
  ~21.5 s [doc: nat-traversal.md:61-63].

**Deadlines and reporting [code].**
- `Deadline::Connecting = now + 5 s` if `udp_preparation == Available`, else
  `now + 20 s` [peer.rs:2139-2148].
- The deadlines are checked on a 1 s interval tick [peer.rs:865, 889, 1061,
  2742-2769]. An expired deadline before establishment calls `fail` →
  `LinkState::Failed` [peer.rs:2733-2741].
- str0m `Connected` (or ICE connected with `rtc.is_connected()`) →
  `PeerState::Connected` → `LinkState::Connected` [transport.rs:2200-2212;
  peer.rs:2995-3001].
- ICE disconnected without send consent → `fail` → Failed. With consent →
  Disconnected [transport.rs:2189-2199].
- After establishment, a 20 s `Control` deadline governs room DataChannels and
  fails only room data [peer.rs:2665-2669].
- No ICE restart is issued anywhere in `src/client` or
  `prototype/channel-native/src` (grep for `restartIce|iceRestart|ice_restart`
  found nothing).

**Doc.** Network design: "Ordinary Native pairs marked `Available` share an
IPv4 socket … Coordinated preparation and linear probes retain their exclusive
sockets" and "Native maps its actual default-gateway IPv4 socket using the
portmapper client" [doc: channel-network-design.md:774-787]. These match. The
**5 s Connecting deadline for Available pairs is not stated in any of the four
network documents** (grep for "five-second/5 seconds" found only the cooldown,
the repair wake, the linear window and the preparation lifetime).

## 4. Linear hypotheses (Native → Browser)

**Where.** `peer/linear.rs`, `peer/discovery.rs:282-316`, `peer.rs:2948-2985`.
On the Browser: `src/client/webrtc/linear-ice-candidate.ts`, used at
`transport.ts:946-950`.

**Trigger [code].** The Engine is created with `linear = true` (section 3). The
*linear base* is the IPv4 host candidate on the default-route interface, or
else the first IPv4 host candidate (`transport.rs:933-938`, default route from
the netwatch snapshot at 905-913).

**Steps [code: linear.rs:33-94].**
1. Record the first three distinct STUN servers *in the order the first UDP
   send succeeded* from that base. Responses do not reorder them.
2. If any of the three fails, give up for this Engine.
3. When all three map, require: same IP, IP valid public
   (`UdpObservation::valid`, wire.rs:705-726), `step = p2 − p1 ≠ 0`,
   `|step| ≤ 16`, and `p3 − p2 == step`.
4. Targets: `p1 − n·step` and `p3 + n·step` for `n = 1..8`, dropping ports
   below 1024. That gives at most **16**.
5. Each target becomes a copy of the real srflx candidate with the port
   replaced and `raddr 0.0.0.0 rport 0` (99-110), signaled with
   `origin: "linear"`.

**Gates.** Native emits only while `linear_enabled`, within 5 s of Engine
creation (`stats_origin`), before ICE connected, and with matching ufrag
[code: transport.rs:1855-1860; peer.rs:2950-2957]. The Browser admits a
candidate only if:
- it is within 5 s of `ChannelTransport` construction;
- the PC is not connected/failed/closed;
- it is UDP component 1, type srflx, numeric IPv4, port 1024–65535;
- its ufrag equals the current remote generation;
- it is not a duplicate;
- it is among the first 16

[code: linear-ice-candidate.ts:5-41]. Native receivers ignore every candidate
with an origin [code: peer/transport.rs:1425-1429]. No socket or probe is
added. The Browser's own ICE checks the targets.

**What it assumes.** The Native's NAT allocates mappings sequentially. The
Native's ICE check toward the Browser's srflx creates mapping
`p3 + k·step` with `k ≤ 8` (or `p1 − k·step`). The Browser's NAT then lets the
Native's checks in after the Browser has sent to that target.

**Doc vs code.**
- [doc: channel-network-design.md:726-733] says the Native "may send *Browser
  peers* one batch of at most 16 typed linear candidate hypotheses".
- [code] Emission depends only on `udp_preparation == None` and the gates
  above, not on the peer's kind. Native and Server peers in that state also
  receive the batch and drop it.
- ADR-0009 (2.x) describes "at most eight bounded candidates … four above …
  four below" [doc: adr/0009:43-46]. That is the 2.x rule. 3.0 uses 8 + 8.

## 5. Coordinated UDP preparation (Native ↔ Native)

**Where.** `prototype/channel-native/src/peer/preparation.rs` (all of it). The
driver hooks are in `peer.rs:2033-2058, 2224-2283`. Core gating is in
`channel.rs:169-177, 273-294, 365-367` and `transport.rs:782-796`.

### 5.1 Eligibility (what decides whether it is attempted)

[code] All of the following must hold:
1. Both sessions are Native, not the Server (session.rs:867).
2. The channel's `ice_servers` contain at least 3 distinct `stun:` authorities
   (udp.rs:13-34). IPv6 literals, `stuns:` and `turn:` do not count.
3. The ordinary attempt reported `Failed` before either side reported
   `Connected` (transport.rs:786).
4. The attempt is still the `Ordinary` one. There is one preparation per
   ordinary attempt, and a Prepared attempt is never prepared again.

There is **no NAT classification input** to this decision. Classification
happens inside the preparation, and only decides which probe plan to use
(5.4). The App's Local mode configures exactly one STUN URL (its own LAN
listener), so preparation and linear are never possible there
[code: channel-server/src/app_domain.rs:278-297].

Lab note [code]: the `network_lab` example sets `can_prepare_udp` from the
presence of an IPv4 default gateway (`examples/network_lab.rs:108-112`),
whereas production uses `server_udp.is_none()`.

### 5.2 Signaling sequence (through the channel)

The relay validates [code: channel.rs:280-294]:
- a `udp` signal is accepted only if the pair is `Prepared` and both sides are
  still capable;
- `Offer` only from the lower session UUID, `Answer` only from the higher.

`Ready`, `Unavailable` and `Complete` may come from either side. Observations
must pass `UdpObservation::valid()`: public IPv4, port ≥ 1024, and for
Sequential `step ∈ [−16, 16] \ {0}` with `port + 4·step ∈ [1024, 65535]`
(wire.rs:705-726).

```
both:  receive PairInfo{udp_preparation: Required}; Pending::start; deadline_i = receipt_i + 5 s
both:  local_ipv4 = OS default-route IPv4 (netdev get_local_ipaddr)      preparation.rs:46-55,162-164
both:  resolve first 3 distinct IPv4 SocketAddrs among configured stun authorities (completion order) 252-287
initiator (lower UUID):  survey -> send Offer{secret[32], observation}  -> wait Answer        175-200
responder:               wait Offer -> survey -> send Answer{observation}                    201-227
both:  check(remote observation)                                                               228, 447-474
  random Pool side:   prime 256 sockets -> send Ready{}                                        544-552
  random Search side: wait Ready{} before any probe                                            553-555
both:  on own winner (authenticated response to own transaction) -> send Complete             618-621
both:  finish only when own winner exists AND peer Complete received                           566-567, 590-593
any error/timeout inside the 5 s -> try_send Unavailable{} (never waits)                       92-95
receiving Unavailable -> abort own task (marked refused), no echo                              109-114
```

The responder does not start its survey until the Offer arrives. The two
surveys are therefore serial, separated by one signaling hop
[code: preparation.rs:201-217].

### 5.3 Survey and classification (what the implementation "knows" about a NAT)

[code: preparation.rs:321-374]
- Bind **one** UDP socket on `(local_ipv4, 0)`.
- Run three Binding transactions **sequentially** (each waits for its answer)
  to the three destinations. The whole survey is bounded by
  `min(expires, now + 1500 ms)`. Requests carry no integrity, and the
  retransmission schedule is the rtc-stun default above, so within 1.5 s a
  transaction can send at most at 0, 0.3 and 0.9 s.
- The three mapped IPs must be equal, otherwise error "mapping addresses
  differ" → Unavailable.
- `a == b == c` gives `Stable{ip, port}`. The survey socket is **retained**.
- `step = c − b`, `b − a == step`, `step ≠ 0`, `|step| ≤ 16` gives
  `Sequential{ip, port: c, step}`. The socket is dropped.
- Anything else gives `Irregular{ip}`. The socket is dropped.

In RFC 4787/5780 terms [arith]:
- "Stable" means the same external port toward three destination
  `SocketAddr`s. That is EIM *or* port-preserving endpoint-dependent mapping;
  the two cannot be told apart.
- "Sequential" and "Irregular" both mean the mapping varies per destination.
  With three different destination IPs (the default providers), address-
  dependent and address-and-port-dependent mapping are indistinguishable. If
  two configured authorities resolve to one IP, address-dependent mapping can
  look Stable [doc: nat-traversal.md:143, 160-162].
- Not measured at all: **filtering** behaviour, **hairpinning**, binding
  lifetime, port parity, and IP pooling beyond "the three IPs are equal". The
  observation is per preparation and not stored [code: none persisted;
  doc: nat-traversal.md:365-371].

### 5.4 Probe plans

[code: `ProbePlan::new`, preparation.rs:387-422; sockets and budgets 525-562]

| local \ remote | Stable | Sequential | Irregular |
|---|---|---|---|
| **Stable** | retained socket; 1 target = remote tuple | retained socket; targets `c+4s`, `c+8s` (alternate dropped if < 1024 or > 65535) | **Search**: retained socket; 512 distinct random ports on remote IP |
| **Sequential** | 8 new sockets; 1 target = remote tuple | 8 new sockets; 1 target = remote `c+4s` | refused ("unsupported mapping observations") |
| **Irregular** | **Pool**: 256 new sockets; 1 target = remote stable tuple | refused | refused |

A refusal is an error, so Unavailable is sent and both fall back to ordinary
ICE. All requests are STUN Binding with a fresh transaction ID per socket,
`MESSAGE-INTEGRITY` keyed by hex(secret), the shared 32-byte secret from the
Offer, and `FINGERPRINT`. They carry no USERNAME (533-541). A packet counts
only if:
- its source is a target, or once a target is selected, exactly the selected
  tuple;
- it decodes and the integrity check passes;
- a response matches *that socket's* transaction ID (594-606).

**Non-random rounds [code: 571-589].**
- 7 rounds at `t = 0, 100, …, 600 ms` from check start. Each round queues one
  request per socket to `targets[round % len]`, or to the selected target once
  one exists. Sends are back-to-back.
- Budgets: requests ≤ `CHECK_PACKET_BUDGET = 64`, replies ≤ 64, triggered
  ≤ 64. Triggered requests share the request budget (607-617).
- Stable side: 7 requests, rounds 0/2/4/6 to `c+4s` and 1/3/5 to `c+8s` when
  two targets exist. Sequential side: 8 sockets × 7 = 56 requests, leaving at
  most 8 for triggered.

**Tolerance to intervening allocations [arith].** Assume a sequential side
whose `k` other new mappings were allocated after its survey, and whose 8
sockets are allocated in socket order. Socket `i` (0..7) then maps to
`c + (1+k+i)·s`.
- Target `c+4s` is covered for `k ≤ 3`.
- Target `c+8s` is covered for `k ≤ 7`.
- So Stable/Sequential tolerates `k ≤ 7`, and Sequential/Sequential tolerates
  `k ≤ 3` on *each* side.

The doc records "Four intervening allocations defeated the single predicted
target; the bounded alternative connected" [measured: nat-traversal.md:54-55].

**Random ("birthday") method [code: 34-44, 425-444, 525-622].**
- Process-wide permit: `static RANDOM_PREPARATIONS: Semaphore = 2`. It uses
  `try_acquire`, so when busy the side errors, sends Unavailable and both fall
  back. There is no queueing (525-526).
- **Pool (irregular side)**:
  - Binds `RANDOM_PORTS = 256` sockets on `(local_ipv4, 0)`.
  - Sends one request from each socket to the stable tuple, one every
    `RANDOM_PACKET_INTERVAL = 2 ms`. The interval is measured from after each
    send (`next_send = now + 2 ms`). That gives 256 NAT mappings toward one
    tuple.
  - Then sends `Ready{}` (544-552).
  - Then a second pass of 256 requests to the same tuple, one per socket in
    order at ≥ 2 ms, until a winner exists (`probe_limit = 256`, 560, 568-569).
  - Requests: 256 + 256 = 512, plus ≤ 8 triggered (`RANDOM_REQUEST_BUDGET =
    RANDOM_TARGETS + 8 = 520`).
- **Search (stable side)**:
  - Targets: `RANDOM_TARGETS = 512` **distinct** ports drawn uniformly by
    rejection sampling from 1024..65535 with `getrandom` (425-444).
  - Waits for `Ready{}`, then sends 512 requests from the single retained
    socket, one per target in order, ≥ 2 ms apart (553-555, 579-589). All 512
    carry the same transaction ID.
  - Stops probing once a target answers or sends an authenticated request
    (`selected`).
- Replies ≤ `RANDOM_REPLY_BUDGET = 16`. Triggered requests ≤ 8 (561-562).
- Success path: a search probe reaches pool socket *i* through its mapping.
  The pool's APDF lets it in because socket *i* sent to the stable tuple. Pool
  *i* replies and sends a triggered request. The stable NAT passes these
  because it has just sent to that port. The search side gets a valid response
  → `Complete`. The pool gets a response → `Complete`. The pool keeps socket
  *i* and drops 255 (625-628).
- **Synchronisation.** Only the `Ready` signal: mappings exist before the first
  probe. There is no RTT measurement and no timed simultaneous open.
- **Duration** [arith]:
  - priming ≥ 256 × 2 ms = **0.512 s**;
  - search ≥ 512 × 2 ms = **1.024 s** (≈ 500 packets/s per side);
  - both inside the same 5 s preparation that also holds DNS, two serial
    surveys (≤ 1.5 s each) and three signaling hops (Offer, Answer, Ready).
- **Packet cost** [arith]: a Binding request with MESSAGE-INTEGRITY (24 B) and
  FINGERPRINT (8 B) is 52 B of STUN, or 80 B on the wire over IPv4/UDP.
  - Failed run: 512 + 512 = **1,024 requests per pair**, about 82 kB, plus the
    survey.
  - Worst case: 2 × (520 requests + 16 replies) = 1,072 datagrams.
  - The doc's WAN capture matches 512 + 512 [measured: nat-traversal.md:123-130].

**Doc vs code.**
- Network design: "the irregular side opens 256 sockets toward the stable
  side's retained tuple; the stable side checks 512 distinct ports on the
  authorized peer address, each once. Each endpoint permits at most 520
  requests and 16 replies, with at least 2 ms between sends … At most two
  random preparations run per process" [doc: channel-network-design.md:743-749].
  This matches.
- [doc: nat-traversal.md:95-102] uses `M = N = 256` (63.2%) as its worked
  example. Since `a66d49e1` the code uses N = 512 (commit message: "63% at
  N = 256 and 87% at N = 512").
- ADR-0009 (2.x): "at most eight temporary sockets … 64 requests and 64
  authenticated replies … The page waits at most 3.5 seconds; the App expires
  unconsumed work after five seconds" [doc: adr/0009:83-90]. That still
  describes 3.0's non-random path (8 sockets, 64/64). The 3.5 s page wait is
  2.x only.

### 5.5 Completion, adoption, fallback

[code: peer.rs:2224-2283; preparation.rs:635-641]
- `prepared()` runs `commit(current_pair)`, which requires the pair ID
  unchanged and `now < expires`.
- `create_pair(plan, Some((socket, remote)))`: the prepared socket becomes the
  Engine's IPv4 socket. The remote tuple is queued as a remote **host**
  candidate and added once a remote description exists (3703-3706,
  2510-2517).
- Signals queued during preparation (≤ 128) are replayed.
- The PC has a **20 s** Connecting deadline (Required ≠ Available).
- STUN discovery, TURN and a per-pair gateway mapping also run on the prepared
  socket (exclusive, not shared).
- On any failure (refusal, timeout, error, commit failure), the PC is created
  *without* a prepared socket. It is still `Required`, so exclusive sockets, no
  linear and a 20 s deadline. The outcome is logged to the local diagnostics
  recorder (`rtc_pair` events: `PreparationFinished{outcome}`,
  `OrdinaryFallback`, `Mappings{local, remote}`, `Hypotheses{count, random}`)
  [code: preparation.rs:458-472; diagnostics.rs:127-129]. Nothing is reported
  to the channel except the eventual `LinkState`.

### 5.6 Tests that pin the behaviour [code]

`preparation.rs` tests:
- 718 DNS fallback;
- 817 ICMP after first probe;
- 896 late neighbour / triggered completion;
- 1039 cancellation releases socket;
- 1086 and 1220 ordinary fallback after completion/refusal;
- 1359 random pool on loopback: 256 sockets, distinct targets, the
  2-per-process permit, socket release;
- 1592 classification of increasing, decreasing, irregular and stable.

All are loopback. None emulates NAT behaviour.

## 6. Browser transport

**Where.** `src/client/channel/transport.ts`, `src/client/channel/media.ts`,
`src/client/webrtc/linear-ice-candidate.ts`, `remote-ice-candidate.ts`.

[code]
- **Configuration.** `new RTCPeerConnection({ iceServers: state.iceServers,
  bundlePolicy: "max-bundle" })` (transport.ts:135; media.ts:188). It sets no
  `iceTransportPolicy` and no `iceCandidatePoolSize`. `iceServers` comes from
  the channel snapshot (protocol.ts:130).
- **Role.** `polite = sessionId.localeCompare(peerId) > 0`. The impolite side
  creates a DataChannel (an input "probe" if the pair carries nothing) and
  offers (media.ts:187; transport.ts:192-200).
- **Candidates.** Every non-null local candidate is trickled. End-of-candidates
  (null) is not sent (transport.ts:146-148). Remote candidates arriving before
  the remote description are queued (≤ 128, transport.ts:939-942). Linear
  candidates pass the admission gate (section 4).
- **Deadline.** `TRANSPORT_PREPARE_MS = 20_000` from construction. Expiry
  before `connected` calls `fail()` → `link_state failed` (transport.ts:16, 145,
  365-370; media.ts:215-220).
- **Failure.** `connectionState == "failed"` also fails immediately
  (transport.ts:163). `disconnected` reports `link_state disconnected` only
  (164-166).
- **What a Browser cannot do here.** It never claims `canPrepareUdp`
  (wire.rs:28-29). It opens no extra sockets, runs no survey, generates no
  hypotheses for its own NAT, and has no ICE restart. Native ignores Browser
  candidates it cannot parse (e.g. mDNS `.local` hosts). No mDNS resolver
  exists in `channel-native` (grep), and the todo holds it
  [doc: todo.md:335-339].
- **Doc.** Browser socket limits are as stated in [doc: nat-traversal.md:22-23,
  233-234].

## 7. What the Server contributes

[code]
1. **ICE server list.** `PIIK_CHANNEL_ICE_SERVERS` JSON, or else the default
   `stun:stun.cloudflare.com:3478`, `stun:stun.miwifi.com:3478`,
   `stun:stun.chat.bilibili.com:3478` (channel-server/src/lib.rs:126-144). This
   list alone decides `can_prepare_udp` (≥ 3) and feeds every Browser and
   Native.
2. **App Local mode.** A Binding-only STUN responder on the selected LAN
   address (`app_stun.rs:9-35`). It answers any Binding request with
   XOR-MAPPED-ADDRESS + FINGERPRINT. It has no OTHER-ADDRESS, CHANGE-REQUEST
   or integrity, so it is not an RFC 5780 server. It is the *only* ICE server
   in that mode (app_domain.rs:293-297).
3. **Signaling relay** for SDP, candidates and UDP-preparation messages, with
   the role/state validation in 5.2. It does not inspect or store observations
   (channel.rs:304-311).
4. **The Server as a peer.**
   - Fixed UDP listeners are shared by all its pairs (server_udp.rs). It may
     emit an srflx for an operator-configured public mapping (83-96).
   - It runs ordinary STUN discovery but no gateway mapping and no linear.
   - It never prepares (`can_prepare_udp = false`).
   - It is a relay candidate for transit kinds the operator offers. It ranks
     after every participant path [doc: channel-forwarding-plan.md:342-356].
5. **Nothing else.**
   - No address observation from the WebSocket.
   - No STUN on the Server's media port. The todo holds "optional Server-port
     STUN exposure" [doc: todo.md:338-339].
   - No TURN service.
   - No rendezvous timing.

## 8. Timelines by pair kind

Times are from book admission `T0`. δ is the signaling one-way delay through
the Server. Values come from section 2–6 code.

### Native ↔ Native (≥ 3 STUN configured)

| t | Channel | Each Native | Network |
|---|---|---|---|
| T0 | admit, book deadline T0+20 s, PairInfo `Available` | — | — |
| T0+δ | — | create PC, shared IPv4 + own IPv6 sockets, Connecting deadline +5 s | host candidates; STUN Binding per (base, server); gateway probe; impolite side offers; str0m checks at 50 ms pacing |
| ≤ T0+δ+5..6 s | — | if not ICE+DTLS connected: retire PC, send `Failed` | — |
| T1 (Failed arrives) | `prepare`: new UUID, `Prepared`, deadline T1+20 s, PairInfo `Required` | — | — |
| T1+δ | — | Pending, 5 s budget; DNS for 3 STUN | — |
| +≤1.5 s | — | initiator survey (1 socket) | 3 sequential STUN transactions |
| +δ | relay Offer | responder survey (≤ 1.5 s) | 3 sequential STUN transactions |
| +δ | relay Answer | check plan | non-random: ≤ 7 rounds over 600 ms. Random: pool 256 × 2 ms, `Ready` (+δ), then search 512 × 2 ms |
| ≤ T1+δ+5 s | relay `Complete` both ways | commit, create PC (prepared socket + IPv6), Connecting +20 s; or fallback PC without it | ICE on prepared tuple (host candidate) plus ordinary candidates |
| T1+20 s | if not confirmed: expire, rejected, retry ≥ T1+25 s | projection removes pair → retire (no Failed) | — |

The Native deadline (≤ T1+δ+5+20 s) is later than the book's (T1+20 s), so for
a prepared attempt the book always ends first [arith]. Worst case before the
cooldown is about 25–26 s from T0. The measured successes were 8.51 s and
8.11 s admission-to-DataChannel [measured: nat-traversal.md:112-114].

### Native ↔ Browser

| t | Channel | Native | Browser |
|---|---|---|---|
| T0 | admit, deadline T0+20 s, PairInfo `None` | exclusive IPv4/IPv6, linear on, per-pair gateway mapping, Connecting +20 s | PC, 20 s timer |
| ≤ +5 s | relay | ≤ 16 linear srflx hypotheses if the 3 first STUN results on the linear base are arithmetic | admits ≤ 16 within its 5 s; ICE checks them |
| ≤ T0+20 s | expire → rejected (+5 s) | Failed at 20–21 s or on ICE failure | Failed at `connectionState failed` or 20 s |

### Browser ↔ Browser

Ordinary ICE only: host/mDNS, srflx from the configured STUN, relay if TURN is
configured. Each side has a 20 s timer, and the book has 20 s. Failure leads to
retire and a 5 s cooldown. The lab saw Chrome report `failed` at 15.176 s with
UDP silently dropped [measured: network-lab.md:322-331].

### Anything ↔ Server

`udp_preparation = None`. The Server uses fixed listeners and a 20 s deadline.
A Native peer emits linear hypotheses, which the Server's Native drops.

## 9. IPv6, multiple interfaces, VPN, CGNAT, hairpin

- **IPv6.** Ordinary ICE only. Native uses a per-pair `[::]:0` (both cases in
  section 3). NAT64 aliases are added for IPv4 remote candidates [code].
  Preparation, linear, gateway mapping and `stun_servers` are IPv4-only
  [code: wire.rs:683-696, udp.rs:36-37, mapping.rs:101-110]. Nothing specific
  to IPv6 firewall hole punching beyond ICE's simultaneous checks.
- **Multiple interfaces / VPN / virtual LAN.**
  - Every up interface address becomes a host candidate on Native wildcard
    sockets, including VPN adapters. STUN discovery is sent from each base with
    `src_ip` set, bounded at 128 (section 3).
  - Preparation uses only the OS default-route IPv4 (`get_local_ipaddr`). The
    gateway mapping uses only the base equal to `HomeRouter.my_ip`. The linear
    base prefers the default-route IPv4 [code].
  - A virtual-LAN trial worked through numeric srflx after mDNS host
    candidates stalled [measured, 2.x: nat-traversal.md:582-597].
- **CGNAT.** Nothing specific [code: no handling found].
  - Under a CGN, the survey sees the CGN's public address.
  - A gateway mapping on the home router yields that router's WAN address,
    which may be in 100.64/10 or private. It is emitted as srflx without a
    public check (mapping.rs:145-150). `UdpObservation::valid` uses
    `is_private()`, which does not cover 100.64/10.
  - The 256-socket pool counts against any per-subscriber port quota (see the
    RFC 6888 arithmetic below).
- **Two peers behind the same NAT (hairpin).** Nothing specific [code].
  - On one LAN, host candidates normally connect.
  - Across a shared CGN or with client isolation, both surveys show the same
    public IP. Preparation would target the same public IP, which needs
    hairpinning.
  - Recorded: "A same-egress run received STUN replies without peer datagrams.
    Its cause … remain[s] open" [doc: verification-status.md:143-145].

## 10. After failure: retries and relay takeover

- **Ordinary Native-Native:**
  - 5 s deadline, then one preparation (≤ 5 s), then prepared or fallback ICE
    until the book's 20 s from `prepare`;
  - then `rejected` with a 5 s cooldown [code: transport.rs:798-816].
- **Every other pair:** 20 s (Browser and Native deadlines, and the book), then
  retire or expiry, then a 5 s cooldown.
- **A retry** is a brand-new pair: new UUID, new PC, new sockets, and for
  Native-Native again Ordinary → (Failed) → Prepared. It happens only for
  required retries while a delivery is waiting (section 2). The order is
  oldest cooldown first, possibly alternating with a relay trial edge
  [code: connectivity.rs:66-96].
- **Relay takeover.** For a waiting viewer whose direct pair is rejected, the
  room repair chooses, in order [code: discovery.rs:529-619]:
  1. a suggestion over confirmed edges (zero new pairs);
  2. else one missing link across the gap (`repair_candidate`);
  3. else a failed edge's retry.

  The Server is a relay candidate under the same rules and ranks last
  [doc: channel-forwarding-plan.md:342-356]. TURN, if configured, is just
  another ICE candidate.
- **Once served.** After a relay serves the viewer, the direct pair is not
  retried. The present runtime "does not probe periodically. This describes
  current behaviour and not the intent" [doc: channel-network-design.md:580-586;
  ADR-0018 undecided].

---

## Constants

| Name | Value | Where | Meaning |
|---|---|---|---|
| `PAIR_DEGREE_LIMIT` | 64 | channel-core/src/transport.rs:17 | pending+established pairs per ordinary endpoint |
| `CHANNEL_ATTEMPT_LIMIT` | 4 | transport.rs:19 | concurrent attempts per channel |
| `ENDPOINT_ATTEMPT_LIMIT` | 2 | transport.rs:20 | concurrent attempts per endpoint |
| `DISCOVERY_TIMEOUT_MS` | 20 000 | transport.rs:32 | book deadline per attempt; reset by `prepare` |
| `REQUIRED_RETRY_MS` | 5 000 | transport.rs:33 | cooldown after failure or expiry |
| server expiry tick | 1 s | channel-server/src/domain.rs:853 | book deadline resolution |
| `stun_servers` minimum | 3 | channel-core/src/udp.rs:33 | distinct `stun:` authorities needed for preparation |
| default STUN | 3 public URLs | channel-server/src/lib.rs:137-139 | when the env var is unset |
| Native Connecting (Available) | 5 s | channel-native/src/peer.rs:2142-2143 | ordinary Native-Native attempt |
| Native Connecting (other) | 20 s | peer.rs:2145 | None / Required / prepared |
| Native Control deadline | 20 s | peer.rs:2668 | room DataChannels after connect |
| Native deadline tick | 1 s | peer.rs:865 | deadline resolution |
| `MAX_ICE_CANDIDATES` | 128 | peer.rs:125 | bases, STUN routes, queued remote candidates, NAT64 and TURN bounds |
| STUN discovery DNS timeout | 5 s | peer/discovery.rs:178-181 | per URL |
| rtc-stun `DEFAULT_RTO` / `MAX_ATTEMPTS` | 300 ms / 7, linear `(n+1)·RTO` | rtc-stun-0.21.1/src/client.rs:18-20, 50-52 | survey and discovery transactions |
| linear window | 5 s | peer/transport.rs:1857; linear-ice-candidate.ts:5 | emission and admission |
| linear samples / targets / step | 3 / ≤ 16 (8 + 8) / \|step\| ≤ 16 | peer/linear.rs:35, 83, 88-90 | hypotheses |
| linear Browser cap | 16 | linear-ice-candidate.ts:13 | admitted tuples |
| preparation lifetime | 5 s from receipt | peer/preparation.rs:76 | whole negotiate |
| survey bound | 1 500 ms | preparation.rs:334 | 3 sequential transactions |
| `CHECK_PACKET_BUDGET` | 64 | preparation.rs:34 | non-random requests (and replies, triggered) |
| non-random sockets | 8 (sequential side) / 1 retained (stable side) | preparation.rs:531 | — |
| non-random rounds | 7 at 100 ms | preparation.rs:571 | 0..600 ms |
| sequential target / alternate | `c + 4·step` / `c + 8·step` | wire.rs:722, 733; preparation.rs:402-415 | — |
| sequential step bound | \|step\| ≤ 16, ≠ 0 | preparation.rs:354-357; wire.rs:721 | — |
| `RANDOM_PORTS` | 256 | preparation.rs:35 | pool sockets (M) |
| `RANDOM_TARGETS` | 512 | preparation.rs:38 | distinct search ports (N) |
| `RANDOM_REQUEST_BUDGET` | 520 | preparation.rs:39 | requests per side, including triggered |
| `RANDOM_REPLY_BUDGET` | 16 | preparation.rs:40 | replies per side |
| random triggered cap | 8 | preparation.rs:562 | — |
| `RANDOM_PACKET_INTERVAL` | 2 ms | preparation.rs:41 | spacing after each send |
| `RANDOM_PREPARATIONS` | 2 | preparation.rs:44 | process-wide random permits, no queue |
| random port range | 1024..65535 (R = 64 512) | preparation.rs:435 | — |
| preparation signal queue | 128 | preparation.rs:125 | non-UDP signals held |
| Browser `TRANSPORT_PREPARE_MS` | 20 000 | src/client/channel/transport.ts:16 | Browser attempt / room data |
| str0m Ta / RTO / retransmits / consent | 50 ms / 250 ms doubling to 3 s / 9 / 30 s | str0m `2d0d6ea` crates/is agent.rs:366, stun.rs:12, 63-71, consent.rs:11 | not verified at pin `5f1f6346` |
| NAT64 prefixes | ≤ 8; lengths 32/40/48/56/64/96 | peer/nat64.rs:9, 56 | — |

## What was measured, and what was not

**Measured (all controlled; none is a population rate).**
- **Random pool, early version (M = 256, N = 256 pre-frozen targets,
  2026-11-14)** [measured: nat-traversal.md:106-114]:
  - calibrated Linux kernel NAT;
  - 5 ordinary controls with no DataChannel in 30 s;
  - 5 experiments: 3 empty intersections, 2 natural matches, 1 with decoded
    640×360 video and audio;
  - failed runs sent 1,024 datagrams per pair; successes stopped at 582 and
    308;
  - admission-to-DataChannel 8.51 s and 8.11 s.
  - [arith] The idealised prediction for N = 256 is 63.9% (exact), so 2/5 is
    within small-sample noise.
- **Production generator (N = 256 at that time), Core22**: 3 trials, 2
  DataChannels, 1 no-match. Resource controls: 255 losers released, all
  released on withdrawal [measured: nat-traversal.md:116-121].
- **Current generator (N = 512) at `6f98d93c`**: one natural trial, which
  connected after the stable peer had sent 186 requests to 186 ports. A forced
  blackhole capture showed 512 requests to 512 ports versus 512 requests to one
  port [measured: nat-traversal.md:123-130]. [arith] P(first hit within 186
  probes) ≈ 52%.
- **Stable/sequential**: 1 s signaling skew plus a lost triggered request
  completed within 5 s. Four intervening allocations defeated `c+4s`, and
  `c+8s` connected [measured: nat-traversal.md:49-55].
- **Four-endpoint control**: both Native routers sequential mapping with
  destination-dependent filtering, Browser routers full-cone. Preparation was
  required. 30 frames over 3.009 s, 5,279 media packets
  [measured: network-lab.md:157-165]. There is also a decreasing-map control
  and a prepared two-Native 50 s outage recovery in 9.8 s
  [measured: network-lab.md:185-189, 250-256].
- **Lab NAT model**: nftables number-generator sequential map over ports
  40000..44095 with destination-dependent filtering. Calibration observes three
  consecutive mappings first [measured setup: network-lab.md:782-791].
- **Linear (Native → Browser)** [measured: nat-traversal.md:136-145]:
  - linear model: 16 targets delivered SCTP in 1.49 s;
  - production one-base Core24: suppression stayed disconnected, acceptance
    gave media;
  - address-dependent mapping with three IPs: DataChannel in about 1.5 s;
  - random destination-dependent mapping with one or eight sockets: no
    connection.
- **Public control**: an Android App had a direct path between two distinct
  public egresses. NAT types unknown [measured: network-lab.md:243-248]. A
  same-egress run failed, cause unknown [doc: verification-status.md:143-145].
- **Historical 2.x (Go/Pion), not this code**:
  - 14/15 sequential-to-restricted prediction runs [doc: adr/0009:127-128];
  - the October 12 seven-pair outcome (cone/cone, restricted/restricted and
    cone/hard connected; restricted/hard and hard/hard did not)
    [doc: nat-traversal.md:436-445];
  - the sequential comparison delivered at ~23.6 s
    [measured, 2.x: network-lab.md:740-749];
  - MiniUPnPd made hard/hard reachable [doc: nat-traversal.md:540-541].

**Not measured / asserted without measurement.**
- Any field or population success rate [doc: todo.md:335-339;
  verification-status.md:143-148].
- Random preparation with N = 512 beyond one trial.
- Sequential/Sequential pairs in 3.0.
- Behaviour on Windows/macOS/Android. In particular the 2 ms pacing (see
  Questions).
- CGNAT, carrier port quotas, hairpinning, IPv6-only hole punching between two
  stateful firewalls.
- Real UPnP / NAT-PMP / PCP gateways in 3.0. Only a controlled
  "PCP-to-NAT-PMP fallback" workload is noted
  [doc: verification-status.md:146-147].
- Interfaces changing during preparation.
- Intervening allocations caused by Piik's own concurrent attempts.
- Non-uniform random allocators (port-block allocation).
- Browser-side hard NATs (there is no mechanism to measure).

## Primary sources and what they predict for these parameters

Each line gives the source, what it establishes, and the arithmetic for Piik's
constants. No verdict.

1. **RFC 4787** (https://www.rfc-editor.org/rfc/rfc4787.html):
   - REQ-1: a NAT MUST have Endpoint-Independent Mapping.
   - REQ-2: "Paired" IP pooling RECOMMENDED.
   - REQ-3: no port overloading.
   - REQ-5: UDP mapping timer MUST NOT expire in under 2 min; 5 min
     RECOMMENDED.
   - REQ-8: EIF recommended for transparency, ADF for stricter filtering.
   - REQ-9: hairpinning MUST, with external source address and port.
   - REQ-11: deterministic behaviour.

   Prediction for Piik:
   - Two compliant NATs map EIM, so both surveys show Stable and ordinary ICE
     should already work by simultaneous checks.
   - Preparation's sequential and random plans target only *non-compliant*
     (EDM) NATs.
   - Pool mappings are used within ≤ 5 s and the prepared tuple within the
     next ≤ 20 s, both well under 2 min.
   - Paired pooling makes the survey's same-IP requirement hold.
2. **RFC 5780** (https://www.rfc-editor.org/rfc/rfc5780.html):
   - Mapping is classified with OTHER-ADDRESS from a server with two IPs
     (tests I–III, §4.3). Filtering is classified with CHANGE-REQUEST (§4.4).
     Hairpinning is tested by sending to one's own mapped address (§3.4).
     Lifetime is found by binary search (§4.6).
   - "does not allow … an absolute determination"; "NAT devices do not behave
     consistently enough to predict future behavior"; results are "upper
     bounds"; usage "requires … a fallback" (§1, §2, §4).

   Piik uses none of these attributes. Three different-IP servers can show
   endpoint-dependence but not ADM versus APDM, nor any filtering.
3. **RFC 8445** (https://www.rfc-editor.org/rfc/rfc8445.html):
   - Ta default 50 ms (§14.2). Check RTO = max(500 ms, Ta·N·(waiting+in
     progress)) and never below 500 ms (§14.3).
   - Checklist limit 100 pairs (§6.1.2.5).
   - A timed-out check marks the pair Failed (§7.2.5.2.3).
   - Peer-reflexive learning and triggered checks (§7.3.1.3-4).
   - ICE "will work without the need for a TURN server" with behave-compliant
     NATs (§17.1).

   [arith] Piik's random search sends at 500 pps from one socket, 25× ICE's
   Ta rate. That is outside ICE, so §14 does not bind it, but it is the
   comparison a reviewer may draw. The 16 linear candidates stay within a
   100-pair checklist only if local candidates × 16 ≤ 100.
4. **RFC 8838 Trickle ICE** (https://www.rfc-editor.org/rfc/rfc8838.html):
   - Candidates are tied to the ICE session (ufrag), and stale ones are
     ignored (§9).
   - New pairs enter Frozen or Waiting (§12).
   - A checklist may not go Failed before the peer's end-of-candidates (§8).
   - Default 100-pair limit, discarding Failed pairs first (§§10-11).

   Piik filters linear candidates by ufrag on both sides [code] and never
   sends end-of-candidates [code: transport.ts:146-148]. Its own 20 s timers,
   not RFC 8838 §8, end Browser attempts.
5. **RFC 8489 STUN §6.2.1** (https://www.rfc-editor.org/rfc/rfc8489.html):
   - Initial RTO ≥ 500 ms, doubling, Rc = 7, Rm = 16.
   - Sends at 0, 0.5, 1.5, 3.5, 7.5, 15.5 and 31.5 s; timeout at 39.5 s.

   [arith] The rtc-stun client used here sends at 0, 0.3, 0.9 and 1.8 s, and
   the survey stops at 1.5 s. A survey transaction therefore gets at most 3
   sends, and three serial transactions share the 1.5 s.
6. **Tailscale, "How NAT traversal works"**
   (https://tailscale.com/blog/how-nat-traversal-works):
   - 256 ports on the hard side. Random probes from the easy side succeed with
     174 → 50%, 256 → 64%, 1,024 → 98% and 2,048 → 99.9%. "Half the time"
     under 2 s at 100 ports/s.
   - Both sides hard: "0.01%" and 170,000 probes for 99.9%.
   - Port-mapping protocols cannot be relied on. "a great many otherwise
     well-behaved NAT devices don't support hairpinning", which becomes "vital"
     under CGNAT.

   [arith] Piik has M = 256, N = 512 distinct, R = 64 512:
   - `1 − exp(−M·N/R)` = 86.9%; without replacement 87.05%.
   - N = 256 gives 63.9%.
   - Per-probe hit ≈ M/R = 0.397%. Median first hit ≈ 174 probes, about
     0.35 s at 2 ms.
   - 90% of eventual successes by ≈ 383 probes, about 0.77 s at 2 ms.
   - With independent one-way loss p on probes only:
     N_eff = 512·(1−p), giving 85.5% (p = 0.05), 83.9% (0.1) and 75.9% (0.3).
   - The uniform-target result is independent of the hard NAT's actual
     allocation range, provided it lies within 1024..65535.
   - Irregular/Irregular is not attempted.
7. **Trautwein et al., DCUtR in IPFS, IMC 2026**
   (https://arxiv.org/abs/2604.12484):
   - 4.4 M attempts from more than 85,000 networks.
   - 70% ± 7.1% hole-punch success *conditional* on relay reservation and
     address discovery. Those prerequisites fail about 29% of the time.
   - 97.6% of successes on the first of up to 3 attempts.
   - Sync: the initiator waits RTT/2 after SYNC.
   - TCP ≈ QUIC.
   - No per-NAT-type breakdown.
   - §7.1: birthday search as future work. Using Halkes' 11% EDM it expects
     19.6% mixed EDM/EIM pairs and 1.2% EDM/EDM, and estimates +12.5%.

   [arith] Under the same assumptions with Piik's 86.9%: 0.196 × 0.869 =
   **17.0%** of Native-Native pairs. If only EIM-APDF partners (52%, Halkes)
   fail ordinary ICE: 2 × 0.11 × 0.52 × 0.869 = **9.9%**. Both figures apply
   only to Native-Native pairs whose EDM side is "Irregular".
8. **Halkes & Pouwelse, "UDP NAT and Firewall Puncturing in the Wild",
   Networking 2011**
   (https://opendl.ifip-tc6.org/db/conf/networking/networking2011-2/HalkesP11.pdf;
   DOI 10.1007/978-3-642-20798-3_1):
   - About 64% of peers are behind NAT or firewall types that allow punching,
     and over 80% of attempts between them succeed.
   - Of 646 classified peers (trial of 907): EIM-APDF 52%, A(P)DM 11%.
   - Many devices time out unreplied holes in ≤ 60 s. Linux uses 180 s after a
     two-way exchange.
   - Trials of 907 and 1,531 peers. Success rates come from 15,545
     connections between 841 peers.
9. **Ford, Srisuresh, Kegel, "Peer-to-Peer Communication Across NATs", USENIX
   ATC 2005** (https://bford.info/pub/net/p2pnat/):
   - UDP hole-punching-compatible (consistent translation) 310/380 = 82%.
   - UDP hairpin 80/335 = 24%.
   - Port prediction on symmetric NATs "fragile": a predicted port can be
     taken by another session.
10. **Guha & Francis, IMC 2005 (TCP)**
    (https://www.usenix.org/legacy/event/imc05/tech/full_papers/guha/guha_html/):
    - 87–93 home NATs, market-weighted: independent 70.1%;
      address-and-port-dependent with delta 1 23.5%; per-connection sequential
      3.9%; per-port 2.1%; random 0.5%.
    - More than ¾ of port predictions correct in 94.0% of cases, all correct in
      81.9%. Failures came from interleaved connections.
    - P2PNAT with prediction 84.3% versus 44.6% without.

    [arith] If the delta-1 classes map to Piik's "Sequential", that would be
    about 30% of NATs in 2005 and random about 0.5%. TCP, 2005; validity for
    today's UDP NATs is not established.
11. **draft-takeda-symmetric-nat-traversal-00**
    (https://datatracker.ietf.org/doc/html/draft-takeda-symmetric-nat-traversal-00):
    - Learn Δp from STUN tests that use CHANGED-ADDRESS, repeated from a second
      local port.
    - Predict `mapped + Δp` and also try `+2Δp, +3Δp, …` (its examples show
      four).
    - Fails when other hosts allocate in between, at the range end, under high
      load, or with random allocation: "no practical solution for (d)".

    Piik uses `c+4s` and `c+8s` (stable side), 8 sockets on the sequential
    side, and ±8 steps for linear.
12. **RFC 6888, CGN requirements** (https://www.rfc-editor.org/rfc/rfc6888.html):
    - REQ-1: a CGN MUST meet RFC 4787 (so EIM, and via 4787 REQ-9
      hairpinning).
    - REQ-2: Paired pooling MUST.
    - REQ-4: MUST support per-subscriber port limits.
    - REQ-7: EIF recommended.
    - REQ-9: subscriber mapping control, SHOULD be PCP.
    - REQ-11: on quota exhaustion, drop and do not delete existing mappings.
    - REQ-15: ports hard to guess (RFC 6056).

    [arith] If the subscriber quota Q < 256 + current use, part of the pool's
    first pass is dropped. Usable M = min(256, Q − used), so for example
    M = 128 gives 63.8%. A port-randomizing CGN classifies as Irregular, which
    falls to the random plan only if the peer is Stable.
13. **Tokio timer granularity**: tokio issue #5021,
    https://github.com/tokio-rs/tokio/issues/5021. A 1 ms tokio timer is "late
    by an average of 15ms" on Windows and 1.13 ms on Linux. Tokio documents
    coarser Windows resolution (https://docs.rs/tokio/latest/tokio/time/fn.sleep.html).

    [arith] If each 2 ms sleep becomes about 15.6 ms: priming 256 × 15.6 ms ≈
    4.0 s, search 512 × 15.6 ms ≈ 8.0 s, and 90% of eventual hits ≈ 6.0 s.
    The preparation budget is 5 s in total. Not measured.
14. **W3C WebRTC `RTCConfiguration`**
    (https://www.w3.org/TR/webrtc/#rtcconfiguration-dictionary): exposes
    `iceServers`, `iceTransportPolicy`, `bundlePolicy`, `iceCandidatePoolSize`
    and certificates, but nothing about ports. A page cannot open sockets or
    choose source ports, which is consistent with section 6.

## Questions for the reviewer

1. **Serial ordinary-then-prepare gate.**
   - Evidence: Native-Native pairs first spend a fixed 5 s on ordinary ICE
     (peer.rs:2142, checked on a 1 s tick). Preparation starts only after
     `Failed` crosses the channel and comes back as a new PairInfo
     (channel.rs:365-367). That 5 s value is not in the network docs.
   - Scenario: an EDM/EIM pair always pays ≥ 5–6 s before its first survey
     packet. The two measured successes took 8.51 s and 8.11 s. The survey uses
     its own socket and could run beside ordinary ICE.
   - Is "ordinary first, then prepare" the shape one would choose today?
2. **Serialized surveys.**
   - Evidence: the responder starts its survey only after receiving the
     initiator's Offer (preparation.rs:201-217).
   - This adds up to 1.5 s plus one signaling hop to every preparation. It
     also widens the window in which the initiator's NAT can make intervening
     allocations before its `c+4s`/`c+8s` is used.
   - Scenario: δ = 300 ms and STUN RTT = 150 ms, with the initiator being the
     sequential side. Its 8 prediction sockets open δ + 0.45 s (responder
     survey) + δ ≈ 1.05 s after its last survey mapping. That is the window for
     intervening allocations on its NAT. Concurrent surveys would shorten it to
     about δ.
3. **2 ms pacing on Windows.**
   - Evidence: `RANDOM_PACKET_INTERVAL` is implemented with tokio
     `sleep_until`, and the code never calls `timeBeginPeriod`. Tokio #5021
     reports about 15 ms lateness on Windows.
   - Every random-preparation measurement is Linux namespaces.
   - Scenario: a Windows pool side needs about 4.0 s to prime, and the search
     side about 8.0 s for 512 probes. Both exceed the 5 s preparation budget,
     which also holds DNS, two surveys and three signaling hops. Unmeasured.
4. **Coverage by pair kind.**
   - Browser↔anything and anything↔Server get ordinary ICE only. Linear covers
     only a *Native's* sequential NAT toward a Browser.
   - A Browser behind a hard NAT, Irregular/Irregular, Irregular/Sequential,
     STUN lists with fewer than 3 entries (including App Local mode) and
     same-egress peers have no mechanism (sections 4–7, 9).
   - Given "A link and a browser", what share of real pairs does the enhanced
     path reach?
5. **Classification strength.**
   - "Stable" merges EIM with port-preserving EDM. Filtering is never
     measured. Three sequential transactions in ≤ 1.5 s are the whole sample.
   - A Stable/Stable preparation repeats a srflx↔srflx exchange (7 requests
     over 600 ms) that ordinary ICE had 5 s to try.
   - What failure does Stable/Stable preparation fix that ordinary ICE did
     not? Is it only the 5 s cut-off?
6. **Retry policy versus "direct paths are worth real effort".**
   - Evidence: a failed edge retries only while a delivery is still waiting
     (transport.rs:260-267; discovery.rs:526-528). Standby and room interest
     never retry under unchanged signaling generations. Once a relay serves
     the viewer, the direct pair is never tried again.
   - Scenario: B→A→C works through a relay. B–C failed once at join, perhaps
     on transient loss during the 5 s window. B–C is not retried for the life
     of both signaling connections.
7. **Three deadline owners that disagree.**
   - Book: 20 s from admission, *reset* to 20 s at `prepare`, which includes
     preparation time.
   - Native: 5 s or 20 s from PC creation, which comes *after* preparation (up
     to 25 s).
   - Browser: 20 s from construction.
   - For a prepared attempt the book always expires first, and the Native
     learns of it by projection removal with no `Failed` (peer.rs:2021). The
     todo "Connection attempt deadlines" is open [doc: todo.md:277-279].
8. **Piik's own intervening allocations.**
   - Sequential prediction tolerates k ≤ 7 (Stable/Sequential) or k ≤ 3 per
     side (Sequential/Sequential) intervening mappings.
   - Nothing serialises Piik's own allocations against one NAT. Up to 2
     attempts per endpoint and 4 per channel run at once. Each creates STUN,
     TURN and ICE mappings, and the second random permit can open another 256
     sockets.
   - Scenario: one endpoint with two concurrent Native-Native attempts behind
     the same sequential NAT. Their surveys and 8-socket sets interleave.
9. **Random search accepts only its 512 target ports.**
   - Evidence: `selected.map_or_else(|| !plan.targets.contains(&peer), …)`
     (preparation.rs:598). Authenticated pool requests from other mappings
     that pass the stable side's NAT are discarded, as under EIF or ADF.
   - Is this ever the losing case? For example when the ordinary attempt was
     cut at 5 s by time rather than by filtering. The design text says
     accepting arbitrary ports "would duplicate winner/nomination ownership"
     [doc: nat-traversal.md:209].
10. **CGNAT quotas and hairpin.**
    - Nothing handles a per-subscriber port quota (RFC 6888 REQ-4/11). 256
      sockets per pool, and up to 2 pools per process, can exhaust it silently.
    - Same-egress peers rely on hairpinning. Ford et al. measured 24% UDP
      hairpin support (2005). Piik already recorded a same-egress failure with
      unknown cause (verification-status.md:143-145).
11. **Gateway mapping output is unvalidated and single-base.**
    - Only the base equal to `HomeRouter.my_ip` is mapped.
    - The external address is emitted as srflx even when it is a CGN or
      private address (mapping.rs:145-150).
    - There is no 3.0 measurement against a real UPnP, NAT-PMP or PCP gateway
      (2.x MiniUPnPd only).
12. **Infrastructure dependence of the enhanced path.**
    - Preparation needs at least 3 distinct `stun:` authorities. The default
      configuration uses three third-party public STUN services
      (channel-server/src/lib.rs:137-139).
    - The canon says nothing depends "on a service the project runs or on
      rented infrastructure". An operator who configures one or two STUN URLs,
      or uses App Local mode, silently loses preparation and linear. The Server
      itself offers no STUN on its media port (todo.md:338-339).
13. **Evidence size.**
    - The current constants (N = 512) have one natural trial. The earlier
      N = 256 had 2/5 and 2/3.
    - The random model in the lab is Linux uniform SNAT. Real allocators
      (port-block CGN, per-destination counters) may not be uniform.
    - Is the idealised 86.9% the right figure to reason with until field data
      exists?

## Not read

- `peer/bandwidth.rs`, `external.rs`, `input.rs`, `turn_stream.rs`,
  `udp_diagnostics.rs`, `metrics.rs`, `local_input_udp.rs`. These are only
  touched where they meet the path. TURN was read only at setup level
  (turn.rs:1-80).
- `peer/preparation.rs` tests 817-1358 were read by name, not body.
- `peer/tests/*`, `peer/tests.rs`, channel-core `tests/*`, `channel_tests.rs`.
- Most of `channel/discovery.rs` tests (787-1552) and `transport.rs` tests
  other than 1331-1379.
- `routes.rs`, `host.rs` beyond `requested_pairs`, and `remote.rs`. Room path
  search is cited only through `discovery.rs`.
- The Browser WASM core (`prototype/channel-browser`) and `session.ts`,
  `remote-ice-candidate.ts`.
- str0m at the pinned revision `5f1f6346`. Only the cached `2d0d6ea` was read.
  The `portmapper` and `netwatch` sources were not read (behaviour taken from
  call sites and the README).
- `docs/status.md`, `docs/project-memory.md`, ADR-0016/0017/0018, and
  `docs/research/channel-storage-and-identity.md`, except where quoted.
- network-lab.md sections unrelated to traversal (quality, NACK, file, idle
  cost except one line).
- The 2.x historical runner and the archived Go code.
- Web: Wei et al. (2008) and the 2510.27500 preprint were found but not read.
  Iroh and Tailscale success-rate pages were taken from nat-traversal.md
  citations only.
