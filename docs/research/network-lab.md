# Controlled Network Laboratory

This document covers the shared laboratory method and current Rust process
controls. The Go/Pion runner instructions and older results are retained 2.x
evidence. The [current Rust source map](../standards/engineering.md#module-map)
owns the private 3.x implementation; retired runners are not current entrypoints.

This document owns the laboratory's method and evidence limits. Product routing
remains in the [network model](./channel-network-design.md); pending
work remains in [TODO](../todo.md). The laboratory does not authorize NAT or
adaptation changes.

## Browser Relay After Local Unwatch

A Chrome 152.0.7977.82 control used four independent Browser sessions and real
WebRTC, with synthetic capture, one source output and a relay feeding two
viewers. After the relay started and stopped its own screen, then stopped local
watching, received frames could continue while its decoded frames and
jitter-buffer output stopped. The downstream pictures also stopped, with the
pair identities and live sender tracks retained. The ordering is timing-sensitive;
an initial passing transition did not establish stable recovery.

A reduced four-document control using the actual media modules passed with a
plain visible player, then reproduced after registering one empty
`requestVideoFrameCallback` before player removal. The same source and sequence
passed three cycles on installed Chrome 156.0.8078.80. The complete G49 product
also passed three cycles there with both encoding pools enabled; each downstream
advanced 34–36 frames after the relay stopped local watching. The broader
five-Browser media check passed selective viewing, voice, non-listening relay,
signaling reconnection and relay-exit recovery on that runtime.

The first fixed browser version and its underlying engine change are unknown.
No application workaround was adopted. Bypassing encoding pools, isolating
sender frames, requesting new keyframes and resetting the video element did
not provide a reliable repair on 152. A metadata-only ring of 307 source outputs
had increasing RTP timestamps and stable producer identity. These observations
remain version-scoped; acceptance records must identify the actual runtime.

The same acceptance run exposed a different measurement error after deafen:
an unplayed audio track can receive RTP while decoded-sample counters stop.
A focused control retained two relay outputs and increasing downstream audio
samples while local listening was disabled. The fixture now checks received
bytes/packets at the deafened node and decoded samples at actual listeners.

## Design And References

Reviewed on 2026-10-13:

- [Tailscale NAT Lab](https://github.com/tailscale/tailscale/issues/13038)
  combines precise in-memory models with real systems attached to a virtual
  Internet. Keep both layers: a model regression cannot establish complete App
  or Browser behavior.
- [WebRTC Network Emulation Framework](https://webrtc.googlesource.com/src/+/HEAD/test/network/g3doc/index.md)
  separates endpoints, routes, traffic behavior and measurements. Preserve
  directional links and distinguish simulated time from real-process timing.
- [Mahimahi, ATC 2015](https://www.usenix.org/conference/atc15/technical-session/presentation/netravali)
  motivates isolated, reproducible network conditions around real applications.
- [CellReplay, NSDI 2025](https://www.usenix.org/conference/nsdi25/presentation/sentosa)
  shows that replay can be workload-sensitive. Synthetic delay/loss profiles are
  named impairments, not validated replicas of a carrier or Wi-Fi network.
- [MirrorNet, NSDI 2026](https://www.usenix.org/conference/nsdi26/presentation/miao)
  reinforces checking control, data and traffic together. Piik needs that
  consistency, not a large WAN orchestration platform.
- [RFC 4787](https://www.rfc-editor.org/rfc/rfc4787) separates UDP mapping from
  filtering. Describe both; a random-port Linux SNAT rule alone does not prove a
  named consumer-router NAT type.
- [Linux network namespaces](https://man7.org/linux/man-pages/man8/ip-netns.8.html),
  [nftables NAT](https://wiki.nftables.org/wiki-nftables/index.php/Performing_Network_Address_Translation_(NAT))
  and [netem](https://man7.org/linux/man-pages/man8/tc-netem.8.html)
  provide the real-process substrate without another product dependency.

## Acceptance Contract

The evidence rules apply to both lines. Pion, the four Browser/App pairings and
SFU cases below describe the archived 2.x matrix; the maintained Rust controls
have their own scope in [Rust process controls](#rust-process-controls).

The laboratory is complete only when the following are executable and verified:

1. Isolated Host, Viewer, routers and Site run real processes. Only laboratory
   namespaces, profiles and files are mutated; ordinary routes/firewall rules
   remain unchanged. Cancellation and failed setup clean up owned resources.
2. Existing Pion model tests retain precise mapping/filtering and socket-transfer
   coverage. Real-network calibration independently checks the configured NAT,
   reachability, delay, rate and loss before attributing an outcome to Piik.
3. Browser/Browser, App/Browser, Browser/App and App/App paths use the actual UI,
   signaling and media owners. A generated picture/tone replaces physical capture
   only; no route, SDP, candidate, timeout or readiness is synthesized.
4. Scenarios cover discovery failure, different NAT behavior, asymmetric paths,
   finite outage, address/mapping changes, constrained/recovered media, a healthy
   sibling, signaling-only interruption, SFU fallback and bounded total failure.
   IPv4/IPv6 are distinguished. Unsupported environments fail preflight rather
   than silently omitting required cases.
5. Success requires decoded, progressing media and feedback, not merely an ICE
   connection or route message. Record first-picture and recovery times, media
   dimensions/cadence, loss, selected path, UI state and cleanup. Unmatched
   measurements and timed-out cases remain failures, never zero-valued successes.
6. Repeatable scenario inputs, software/kernel identity, seeds, observed fault
   counters and bounded timelines accompany a structured report. Paired
   enhancement on/off comparisons use the same scenario and endpoints. Report
   counts and distributions without presenting a model pass rate as Internet
   success probability.
7. A documented command and opt-in Linux CI entry run the same checks. Exercise
   failed/cancelled runs as well as passing runs; verify that a deliberately
   missing fault or broken media path cannot produce a passing report.

## Boundaries

The recorded 2.x fast layer used Pion vnet in the
[Native media edge](https://github.com/TNTcraftHIM/Piik/tree/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/app/mediaedge)
and [forwarding core](https://github.com/TNTcraftHIM/Piik/tree/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/media/forwarding).
It exercised that transport with synthetic
media, not every Browser/OS behavior. The process layer uses Linux namespaces,
kernel NAT/firewall rules and traffic shaping. Neither layer establishes
Windows/macOS driver behavior, physical radio scheduling, mobile suspension or
the distribution of real-world NATs. That 2.x process matrix used desktop
Chrome and a Linux App with Browser-generated H264 ingress; it did not exercise
physical capture, other Browser engines, real gateway mapping or the public
invitation provider.

The archived 2.x `voice-browser-browser`, `voice-browser-app`, `voice-app-browser` and
`voice-app-app` cases additionally open room voice through the normal UI and
require progressing received audio in both directions. `voice-sfu-fallback`
blocks direct media, and `voice-media-outage` interrupts then restores UDP while
picture and voice are active. These cases use Browser microphone capture even
when picture media uses the App. They reuse the existing routers and cleanup;
their execution evidence is separate from the previously completed picture matrix.

Actual packets/counters must corroborate each impairment. DevTools accepting a
network-emulation request is insufficient: an earlier Piik check observed RTP
outside the requested limits. Keep negative controls, finite deadlines and
resource limits as part of the laboratory rather than changing product recovery
to make an experiment pass.

## Rust Process Controls

The four-node long-interruption controls keep the source running while
interrupting a transit node for 50 seconds. They inspect both connection and
decoded-media recovery through the current room and transport owners.

The current Rust transport also runs through the same calibrated namespaces,
NAT rules, packet observations and cleanup owner. Ordinary and prepared Native
connections, brief UDP interruption, lost-mapping replacement and delayed
signaling use the production domain, room core and str0m socket adapter. The
[NAT assessment](./nat-traversal.md#rust-integration) records the repaired
preparation and recovery boundaries.

At `3f52e4a8`, a Browser source and Browser receiver also delivered changing
pictures, voice and source sound through a Native room operator. Confirmed
history and a 1 MiB file with a matching digest traversed that ordinary path.
In one Linux NAT trial on `8c1c9026`, Chromium downloaded its first 1 MiB file
in 402.4 ms and verified its SHA-256 over the connection carrying live video,
with the same selected ICE pair and ICE credentials before and after transfer.
Median video frame interval was 100.0 ms across 30 intervals before download
and 116.7 ms across the five overlapping it (maxima 133.2 and 149.9 ms).
The browse-only control produced no standby connection during observation.
A separate four-endpoint control forced the picture through two Native nodes:
both Native routers used sequential mapping and destination-dependent filtering;
the Browser routers used calibrated full-cone, port-preserving mappings. Core
required preparation for the Native-to-Native edge. The receiver decoded 30 new
640×360 frames over 3.009 seconds while both audio streams advanced; the capture
recorded 5,279 media packets across that prepared edge. The second Native was a
transport/media probe; this control does not replace normal room-session history
and file acceptance. Every owned process, namespace and link retired, and host
network configuration stayed unchanged.

The maintained runner uses the Server's `network_lab` example and shared Browser
fixture. Build the matching source and WASM, then select a control on the
isolated Linux host:

```sh
cargo +1.91.0 build --locked --manifest-path prototype/channel-server/Cargo.toml --example network_lab -j2
node prototype/channel-browser/build.mjs
node --import tsx scripts/network-lab.ts --list
node --import tsx scripts/network-lab.ts --case ordinary --output build/network-lab/ordinary-current
```

`--mapping descending` selects decreasing sequential NAT allocation for
the Native pair in `prepared` and `media`. The default is `sequential`
(increasing). Each report records the configured `endpointMappings` in the
same order as its observed calibration results. The `ordinary` case uses
port-preserving mappings at all three endpoints. Calibration
checks the observed destination order, not just a sorted set of ports. Both
variants keep the same preparation socket and packet budgets.
The November 13 controlled comparison retained increasing-map playback, rejected
the decreasing map before the signed-step change, and decoded media on both
directions afterward. The maintained decreasing-map control also recovered
picture and source sound after its 50-second interruption. These are isolated
kernel-NAT results, not physical-network success rates.

`ordinary` covers the real Native room's history, file and Browser media path.
`prepared` requires completed UDP preparation and a connected physical pair to
the current Native room host. `recovery` keeps a screen and audio publication
active during 50 seconds of UDP loss and a transit-router UDP remap. The
receiver must resume decoding through a replacement Native pair to the same host.
`media` covers decoded media through a prepared Native transit probe, followed
by a 50-second outage and decoded recovery through that
transit while the original source stays active. `browser-relay` checks decoded
picture and source sound after a 50-second UDP outage around a Browser relay,
retaining the healthy source.
Each run requires a new output directory. The runner follows
`CARGO_TARGET_DIR`, or accepts `--executable` for the matching example binary.
Use root in the isolated host, the repository's Node/Rust toolchains, the normal
`agent-browser` and Chromium setup, and `iproute2`, `nftables`, `conntrack` and
`tcpdump`. `AGENT_BROWSER_BIN` and `CHROMIUM_BIN` select their installed executables.

The existing CI workflow can run one of those controls on a temporary Ubuntu
24.04 runner:

```sh
gh workflow run repository-hygiene.yml --ref feat/channel-prototype -f channel_network_lab=browser-relay
```

`channel_network_lab` defaults to `none`; choosing one case enables the dedicated
LAB job and skips normal validation, packaging and publication. LAB dispatches
share one serial queue per ref, separate from ordinary CI. The five kernel controls
build the same Native example and Browser WASM, then use the existing namespace, calibration
and cleanup owners. These five controls use NAT and UDP filtering, not seeded
netem delay/loss, so system `iproute2` is sufficient. Build identity, tool versions,
logs, bounded packet captures and the existing result are retained for seven days,
including failed runs. The media controls check decoded recovery in the lab.
Physical capture and Internet success rates require separate observations.

The separate `public-peer` control opens a normal Android App's temporary public
room from the runner's Chrome. Prepare an isolated App-hosted room and Native
H264 share using only test content. No pre-existing chat message is required.
Supply that trial's member invitation, expected identities and normal package
provenance through the temporary `CHANNEL_PUBLIC_LAB` repository secret; the
[runner](../../prototype/channel-server/browser-public-peer.mjs) owns its input contract.

```sh
gh workflow run repository-hygiene.yml --ref feat/channel-prototype -f channel_network_lab=public-peer
```

It checks the actual Native room path and signed history, which may initially be
empty. It sends a unique message, waits for its confirmed sequence, then uses the
normal latest-history action to verify that a fresh signed response returns that
message. Independent UDP egresses and advancing H264 picture remain required.
It loads the App's existing Web/WASM rather
than building another server or changing network settings. Only redacted results
and the test picture are retained. Remove the temporary secret after the trial.

The [normal-package public control](https://github.com/TNTcraftHIM/Piik/actions/runs/41735189331)
at runner revision `c94ed790` passes with Android package `5fe433e9`. One observed
Native peer carries signed history, a confirmed message and its fresh history
readback over UDP between distinct public egresses. H264 advances by 33 decoded
and presented frames at 960 × 540. The desktop control page uses loopback
forwarding; media travels directly between Android and the remote runner.

Initial picture and sound pass through ordinary and prepared Native paths.
After 50-second UDP outages, the [Browser-relay control](https://github.com/TNTcraftHIM/Piik/actions/runs/41362949305)
at `7e85df27` restores decoded picture and current source sound in 21.1 seconds;
the [prepared two-Native control](https://github.com/TNTcraftHIM/Piik/actions/runs/41366641152)
at `7e146910` does so in 9.8 seconds. Both then show three seconds of progressing
media and clean teardown. Exact source closures and failed controls remain in the
[Native evidence index](../../prototype/channel-native/README.md#rtc-dependency).
The older Go runners below require their matching snapshot.

### Joining and relay departure under measured loss

Protocol 31 review build `cfbffb86477c` ran two matched loopback comparisons
using separate Chromium processes and a synthetic moving screen. Each scenario
had one control and one conditioned run. The test registered the browser's P2P
network rule before opening peer sockets, then requested 12% loss and varied
latency between 40 and 95 ms during a 3.6-second window. Receiver RTP counters
confirmed that the condition reached the selected media stream.

| Observation | Control | Conditioned |
| --- | ---: | ---: |
| Two viewers join. First visible frame from subscription, direct viewer | 1.91 s | 2.44 s |
| First visible frame from subscription, viewer reached through the incumbent | 2.46 s | 3.72 s |
| Incumbent rendered frames during the join window | 61 → 97 | 39 → 76 |
| Incumbent RTP loss increase / peak sampled jitter | 0 / 7 ms | 2 / 50 ms |
| Relay departs. Last rendered relay sample to sustained direct playback | 951 ms | 952 ms |

In the join trial the incumbent kept its original direct pair. In the departure
trial both ends kept the same preverified direct pair and the viewer subscribed
once. Its conditioned loss counter rose by three packets on the retiring stream
and two on the new stream. These samples establish delivery under the measured
conditions. Choosing production thresholds requires repeated trials on independent
networks. [Chromium P2P network interceptor](https://chromium.googlesource.com/chromium/src/+/main/services/network/throttling/throttling_p2p_network_interceptor.cc)

A separate four-browser run kept direct signaling from the publisher to both
viewers closed until after their sole chat relay left. Both viewers had
presented three frames through the relay. The test opened direct signaling
2.71 seconds after starting relay shutdown. Both viewers then presented three
frames from the publisher on their newly selected direct paths.
In a separate run, the same two viewers also spoke directly in another room.
Both voice players continued advancing on their original publications while
the screen relay left and the two screen routes recovered.

### Hosted H.264 with two viewers

In three Chromium loopback runs on `19948350`, the first viewer's selected video
element measured 0 × 0 in all nine samples while its frame count stayed at 16,
14 or 13. In the 16-frame run, received frames rose from 35 to 165. In another
0 × 0 run the element advanced from 35 to 169 frames. The cause of the plateaus
remains unresolved.

In the 13-frame run, received frames rose from 20 to 140 while jitter-buffer
output and decoded frames stayed at 13. All 153 timestamps from the selected
relay input matched the first viewer's RTP writer, which recorded 300 packets
with consecutive sequence numbers. Payload digests matched for 148 access
units. The other five contained H.264 aggregation packets.

Two controls opened the foreground player with the Watch button. The selected
element measured 640 × 254 and advanced from 14 to 137 and from 25 to 158
frames. In a separate run on `a38c21fd`, opening chat hid the player. The
Return banner restored the 640 × 254 player and frames advanced on the same
selected flow, stream and track.

At `8d18463c`, a generated 640 × 360 H.264 clock fed two visible Chromium
players. On a direct route the first viewer's presented frame count advanced
from 245 to 417 across the second viewer's arrival. In a separate run each
browser could reach only the test Server. Both viewers reported server relay.
The first viewer kept the same SSRC and advanced from 63 to 959 presented
frames over about 49 seconds. The second advanced from 221 to 532 over about
16 seconds. Both reported 20 fps at the final sample.

### UDP Failure With Signaling Intact

On `d8e86667` (Channel 38), two Chromium 152 processes used separate Alpine
network namespaces and the packaged Server/Web. The normal control reached ICE
`connected` in roughly 0.2 seconds and the viewer decoded a picture. A fresh
connection then exchanged ordinary TCP signaling while each endpoint's input
filter silently dropped UDP; the kernel counters recorded 359 and 358 packets.
The source's browser reported `connectionState: failed` at 15.176 seconds and
Piik sent `link_state` 3 ms later, before the 20-second preparation deadline.
Both browsers entered another ICE check around 20.9 seconds. This single control
establishes prompt propagation of the observed browser failure; it does not
identify the next attempt's timer or determine a general connection deadline.

### Slow Direct Signaling And Early Relay Preparation

Four loopback Chromium clients compared on-demand recovery at `3c7059b0`
with a variant that prepared relays while direct signaling was pending. Each
build ran once per condition (ten runs). Before C subscribed to B's screen,
the host had confirmed only the A–D middle link. Delayed runs buffered real
B–C signaling and released it on the original pair. The blackhole suppressed
B–C signaling throughout, leaving B–A–D–C as the only media path.

| B–C signaling | First frame, on demand | First frame, early preparation | Distinct pair IDs, on demand / early |
|---|---:|---:|---:|
| Immediate | 2.083 s | 2.055 s | 1 / 2 |
| 2 s delay | 3.058 s | 2.895 s | 1 / 3 |
| 5 s delay | 5.885 s | 6.062 s | 1 / 2 |
| 10 s delay | 10.862 s | 10.866 s | 1 / 3 |
| Blackhole | 23.980 s | 23.906 s | 7 / 7 |

All four successful direct conditions used the original B–C pair for playback.
Both blackhole runs delivered through A and D, with 10 SDP offers on demand
and 11 with early preparation. On-demand recovery remains the default because
early preparation added one or two pair attempts when direct signaling succeeded,
and the single blackhole comparison showed only a 74 ms first-frame difference.

In a four-browser loopback run on frozen `c40d335c` (protocol 38), every
link started cold. The browser probe dropped SDP and ICE signaling between
nonadjacent peers, leaving B–A–D–C as the only media path. B dropped the first
direct offer 1.192 s after C requested playback. Core opened the next trial by
21.082 s, while B's parallel transport timer reported the original link
failed at 21.136 s. C presented its first frame at 66.099 s and advanced from
2 to 34 frames on the same track. The run saw 10 distinct signaled pair IDs.
All four browsers released their peer connections after C stopped watching
and both helpers left. This single signaling fault run measures neither NAT
failure recovery rates nor the effect of shortening the timers. The warm
middle-edge measurements above use a different revision.

### Moving an incumbent to admit a waiting viewer

A four-browser loopback experiment at `e04f46a0` tested a live switch alongside
the five-endpoint graph comparison below. A and B already received the source.
Moving A behind B would free a direct slot for C. In the baseline, assigning C
to A made C depend on the input being replaced. Core retired the candidate
2.523 s after A reported decoding it. C displayed zero frames across 12 samples.

Deferring C's first parent assignment during the switch preserved the existing
quality and presentation checks. A reported `SwitchReady` 6.021 s after decoding
and presented 129 frames with a maximum gap of 194 ms. At the first sample
showing playback, 10.138 s after requesting the screen, C had displayed six
frames. With candidate video stalled, A presented 135 frames (maximum gap
125 ms), the switch stayed unapproved and C displayed zero frames in 12 samples.
Each initial condition ran once on one fixed graph with a synthetic screen.
In a longer run with both paths from the viewers to C blocked, C still had zero
frames at 46.961 s. In a separate run, opening A→C at 26.216 s after the
request, once the candidate had expired, let C display video by 30.165 s on
the original subscription.

### Screen coverage on five-endpoint graphs

At `b43edf0c`, all four receivers requested one source in a fixed order.
Every endpoint could send to one downstream, all four receivers could relay,
and the initial tree was empty. Across all $2^{10}=1{,}024$ labeled undirected
graphs, the production planner matched the largest feasible viewer count in
1,005 graphs. Enumerating simple paths from the source gave the exact count
under these conditions. The Rust regression
`confirmed_routes_on_five_nodes_match_simple_path_bounds` reproduces the comparison.

For physical edges $(0,1),(0,2),(1,2),(1,3),(1,4),(2,3)$, the planned path was 0→1→2→3.
The feasible path 0→2→3→1→4 serves all four. Trying one additional extension
in reverse demand order and scoring it in the original request order reduced
the number of misses from 19 to 10. It still missed this example. In a separate
20-endpoint fixture with 12 requests and a default limit of two, coverage rose
from three to four. Median cold planning time across five batches of 5,000
runs rose from 38.2 to 48.4 µs. These comparisons concern planning on known
links. [Delivery tree model](./channel-forwarding-plan.md#selecting-delivery-trees)

Trying interior endpoints before leaves when coverage is incomplete reached the
optimum on 1,012 of the same 1,024 graphs. With a second publication already
using 1→4, this order also covered all four viewers in the regression
`confirmed_chain_reuses_a_publishers_edge_to_the_only_leaf`. In 672 paired
20-endpoint fixtures, it added coverage in 19 and tied the baseline in 653.
Both planners preserved the edges serving the first four subscriptions as
demand grew to 19. These fixtures use confirmed edges and fixed forwarding limits.

Stopping at the proven maximum when the first candidate serves all waiting
endpoints directly preserved every parent assignment in 6,144 comparisons
with `579e337c` (1,024 graphs, three source limits and two starting trees).
In a 20-endpoint cold-planning fixture with ten waiting viewers and ten
source slots, median planning time fell from 125.2 to 6.6 µs. With only
two source slots the same comparison measured 183.4 and 181.5 µs. Each
measurement is the median of five batches of 200 plans on one machine.

At `b079e283`, 911 of the same 1,024 graphs used a relay to deliver one
screen over confirmed links with one output per endpoint. Removing each
active relay in turn gave 2,127 departures. Once routing settled, every case
reached the maximum viewer count obtainable while keeping the healthy part
of the original path. Rebuilding the whole path could serve one more viewer
in 194 cases, each requiring a change to a healthy viewer's path. The fixture
supplied decode and switch evidence. NAT traversal and frame gaps require
measurements on live connections.

### Screen Capacity With An Unreachable First Viewer

Nine loopback Chromium runs at `0fb4f74a` kept channel signaling available
while blocking media signaling between channel owner A and both other peers.
Room host B shared its screen. C subscribed once per run and decoded directly
from B in all nine. Times start when C sent its subscription. These measurements
cover only the local fixture.

| Room direct limit | Viewing order | Runs | B selects B→C (s) | C first frame (s) |
|---|---|---:|---:|---:|
| 1 | C alone | 2 | 0.003 / 0.005 | 2.085 / 2.229 |
| 1 | A first, stays subscribed | 2 | 19.926 / 19.896 | 21.984 / 22.174 |
| 1 | A first, cancels about 2.3 s after C subscribes | 2 | 2.293 / 2.325 | 4.382 / 4.452 |
| 2 | A first, still waiting at C's first frame | 2 | 0.003 / 0.004 | 2.483 / 2.588 |
| 1 | A first, B–C already connected through a second authorized room | 1 | 19.899 | 20.787 |

A's pending request occupied the sole screen slot. With two slots, C received
its pair assignment in 6–7 ms while A still had zero frames. In the last run B
reused the existing B–C pair ID once the screen slot became available.

With the direct limit set to one, a second comparison used the packaged Web
UI and three Chromium sessions. B and C first established a connection in
voice. A requested B's screen first and its media signaling was blocked.
From C clicking Watch to its first video frame callback, one run took
20,545 ms at `9e3ca608` and one took 889 ms at `9bb55c3e`. The publisher
selected at most one screen output in each run. This fixture exercises reuse
of a confirmed pair on loopback. Independent-network coverage remains open.

### Concurrent connection admission

A wire-40 Core control used 20 independent rooms, one silent first candidate
and reachable peers reporting connection 100 ms after allocation. Allowing four
channel attempts and two per endpoint reduced the other 19 rooms' allocation
range from 20.0–21.8 s to 0–0.6 s. The existing selected flow kept its pair and
flow IDs. These virtual-clock timings measure admission, not first picture.
The shared-source control also verified that an untried connection receives a
vacated slot before an eligible retry with no earlier successful connection.

In a four-browser control, only A–C signaling was blocked. From that pair's
first browser projection, D received four decoded frames of A's source by
4.570 s. D's selected relay leg first appeared at 2.241 s; another room used
an already established connection. Existing voice kept the same pair, track
and RTP report while received samples advanced. The observed peak was three
simultaneous connection attempts.

A Windows protocol control separately traced slow Native room replies to
interface enumeration before each new pair. Ten of twelve scans took
1.126–1.234 s. With a shared netwatch monitor, the first snapshot took 1.187 s
and subsequent reads took less than 1 ms. The same final Browse operation took
2,423 ms before and 133 ms after the change, with the original five-second
request deadline. This is one instrumented comparison on the local machine.

### Recovery after UDP blackout

Linux network namespaces isolated the relay and its router. Both fixtures used
Native and Browser WASM builds from tree `295ad897`. After a 50-second UDP
blackout and a relay NAT address change, the Native path established a new
host connection in 2.673 s and restored decoded picture and source audio in
5.906 s after traffic resumed. The Browser relay restored both in 2.805 s.
Both passed the 30 s recovery window with the selected route, continuity and
WAN RTP verified. The first Browser setup timed out before fault injection
while guest memory was low; the same binaries passed after retired lab copies
were removed. These timings describe the two Linux lab fixtures.

### Recovery after a screen relay leaves

Four Chromium sessions at `9bb55c3e` shared a synthetic screen through a
relay. Closing the relay and then allowing direct signaling let the downstream
viewer resume on its original subscription. In one run the viewer presented
a frame on the new video track 330 ms after the relay window closed. The gap
between the last presented frame on the old track and the first on the new
track was 1,478 ms, including time spent closing the window.

A separate run observed the direct route 335 ms after closure and first met
its page-wide video frame-count condition at 20.19 s. That run did not record
per-track video statistics or presentation callbacks, so the duration of its
visible interruption is unknown. An independent room voice connection kept
the same receiver and SSRC, with increasing received samples and audio energy.

A protocol-47 Windows control used four independent Chromium processes and a
moving synthetic source at about 10 fps. Normal page departure gave a 1.491 s
last-old-frame to first-new-frame gap; an earlier normal run gave 0.184 s.
Terminating the owned relay process gave a 15.905 s gap. The publisher observed
that relay offline at 88.6 ms, but the viewer first observed its old flow retired
at 15.792 s. Source frames continued advancing. Each fully instrumented arm
ran once and recovered to source-direct playback. These observations locate
the delay between offline signaling and flow retirement; they do not identify
a particular timer or establish a typical recovery time. Both arms lost the
control connection. Media-only loss with signaling alive remains unmeasured.

An additional instrumented hard exit measured a 16.119 s frame gap. The source
and viewer observed RTC `disconnected` at 6.064 and 7.251 s. The first failure
command came from the source-to-relay connection's RTC `failed` event at
16.034 s. The room writer then synchronized that failed pair, retired the
dependent branch and delivered a new direct frame 133.9 ms later. No earlier
flow failure or route wake was observed. This run locates the main wait at the
Browser's terminal RTC report; the 20-second identity expiry had not elapsed.
It does not justify treating every transient disconnect as a failed path.

A leaf-only experiment compared the same four-browser workload with early
candidate preparation when the selected parent's signaling was offline and its
RTC connection was disconnected. Default recovery took 16.127 s and the
experiment 7.284 s, one sample each. The candidate used an already confirmed
sibling connection and spare forwarding capacity; source output stayed at two.
The old flow stayed selected until the candidate both decoded and presented.
Core controls retained a healthy path on signaling-only loss, cancelled the
candidate when the old path recovered, and respected zero forwarding capacity.
Those controls were simulated. The experiment used a private fixture envelope,
not a production wire change; Native, subtrees and other network conditions
remain outside this measurement.

### File forwarding during a room call

In a four-browser loopback run, both file recipients could reach the sender
through the same relay. The room allowed three downstreams and the relay
offered one file slot. The first recipient had received 393,216 bytes when
the second requested the file. The relay refused the second file branch.
During the next 725 ms that recipient received zero file bytes while its
existing voice stream delivered 38 RTP packets and 36,480 audio samples.

Raising the relay's file limit to two resumed the pending download. The
recipient verified all 12,582,929 bytes against the sender's SHA-256. The
room used the routing implementation from `5493e339` and a synthetic
microphone. This run measures admission and recovery on a shared relay.

### Idle physical connection cost

On 2026-11-21, on one Windows host, two Chromium 156 instances using the production transport
adapter on local ICE paths reached 64 idle pairs per endpoint. At 64, each
endpoint exchanged 7.825 KiB/s of UDP payload. Growing from two to 64 pairs
added 26.8 and 25.9 MiB to the respective working sets. Two debug Windows
Native driver processes reached 64 pairs with staggered handshakes. In the
later 24-second idle window each used about 6% of one logical CPU and exchanged
about 15,100 UDP payload bytes/s. Two burst controls from 20 to 40 pairs confirmed
38 and 34 pairs. Their harness held signaling until both plan updates finished;
the instrumented run first observed a preparation timeout 23.64 seconds after
submission. These adapter measurements used local signaling,
zero business payload and same-host ICE. Mobile cost and public NAT success
require measurements on those networks.

### First frame on a cold and reused connection

In two ordinary Linux kernel NAT trials on `1e00d9e0` (Core32), the source was
already publishing through the Native host when the Chromium viewer joined voice.
From `watch()` to the first `requestVideoFrameCallback` on the subscribed video,
the cold trials took 1,465 and 1,253 ms. ICE first showed connected 279 and
158 ms after `watch()`, leaving 1,187 and 1,095 ms until the frame callback.
Including voice join, the cold totals were 2,064 and 1,685 ms. After withdrawing
the subscription and watching again, first frames took 711 and 451 ms. In each
trial the viewer retained the same `RTCPeerConnection`, selected ICE candidate
pair ID and connected DTLS transport across withdrawal and resubscription.
Both trials ran cold first, so the observed reduction includes any media warm-up.

### Playable Route Improvement

On 2026-11-14, a controlled trial reused the `64e6281e` screen-routing
implementation, unchanged in `27bb5840`. A Browser supplied a roughly 210 kbps
low layer and a 5 Mbps high layer. Under a 1.467 Mbps A-to-Viewer limit, the old
route continued at 160 × 90 and 13.66 fps. An explicit research request used the
existing Switch and quality proof to select B, which already held an authorized
physical connection to that Viewer. Commit was observed after 7.45 seconds;
the subsequent picture delivered 640 × 360 at 29.70 fps.

The old picture lease retired while base duties, room voice and the second
room's connection remained. Complete phase traffic capture confirmed the media
edges; the runner's original final assertion retained a failure because its
startup capture had reached its packet limit. Static and low-cadence source
controls preserved their supplied cadence. This establishes the benefit and
lifecycle of one explicit switch, not an automatic trigger or general Internet
performance. Production alternative-parent selection remains in
[TODO](../todo.md#next).

An isolated `0babfe65` follow-up used actual Native selected-layer/allocation
observations to request one existing leaf Switch after three approximately
two-second restricted windows. Those windows were experimental parameters;
the existing 20-second operation and five-second proof freshness remained.
The candidate additionally needed more decoded pixels, no cadence regression,
and continuing progress without freeze/pause increases on both inputs.

The continuing local-edge limit produced a real gain: the approved interval
compared 160 × 90 at 24 frames with 640 × 360 at 60 frames over two seconds;
the selected replacement subsequently delivered about 29.9 fps. Its old picture
lease retired while base and other-room leases remained. A common Viewer
downlink limit produced no strict gain and no switch, but the incumbent incurred
one freeze during the trial: retaining a lease does not make overlap free.

When the local limit was removed at the trigger, the trial still committed and
640-pixel-wide playback was first observed after 14.53 seconds. A matched arm
with no Switch recovered the retained path to that width at its first
2.26-second sample. This contrast indicates recovery interference or relative
comparison bias; it does not isolate the transport mechanism. Relative strict
improvement alone did not establish a sustained path defect or a net benefit
from this trial. These controls do not support enabling automatic quality trials.

### Native Desired Capacity

A `dc15472f` control on 2026-11-14 exercised the current Native demand calculation
through real media and SDK inputs. Once source observations were available, the
desired target equalled preferred original video plus both audio flows, about
5.1 Mbps; unknown startup retained its existing behavior. The target remained
separate from the restricted output allocation and publication ceiling.

Under the fixed 1.467 Mbps limit, the supplied low layer continued decoding.
Removing the limit restored 640-pixel-wide output after 3.12 seconds; the final
window delivered about 30 fps. The source track and healthy sibling retained
their behavior. This verifies that control's delivery and recovery, without a
route switch; it is not a comparative Internet performance or NAT-success result.

A four-arm in-process control on `2e051685` used two real RTCs and the pinned
[str0m probe controller](https://github.com/TNTcraftHIM/str0m/blob/2d0d6eaaf4d19d7530588f695cd631eedf42acf5/src/bwe/probe/control.rs)
with its Netem: 25 seconds per arm, 20 ms each way, a 100 kB forward queue and
no configured random loss. Selected RTP stayed at 2 Mbps. At 8 seconds,
`minimum` stayed at 2 Mbps; the trial arm raised `desired` from 2 to 5 Mbps.
Both media sections were already negotiated. The fixture admitted the fixed
3 Mbps optional flow when the SDK estimate reached the combined 5 Mbps cost.

| Link | Arm | Desired after request | Optional RTP after request |
| --- | --- | --- | --- |
| 6 Mbps | Steady | 2 Mbps | None requested |
| 6 Mbps | Trial | 5 Mbps | 84.592 ms; estimate crossed 5 Mbps at 61 ms |
| 3 Mbps | Steady | 2 Mbps | None requested |
| 3 Mbps | Trial | 5 Mbps | Not admitted; estimate remained below 5 Mbps |

Both trial arms emitted an SDK probe in the request's virtual-clock turn;
exponential probing took precedence over allocation probing. All four arms
received 6,244,500 bytes of selected RTP payload. Estimate, media, explicit
padding and RTX were recorded separately. This supports keeping SDK probing:
the constrained trial probed but lacked capacity. Full Native Driver admission
and decoded-picture quality were outside this control; these timings are not
field performance guarantees.

A Windows Driver control on `86980991` kept injected feedback at 180 kbps and
forwarded decodable synthetic VP8 and Opus silence. With selected video held at 10 fps,
reducing the optional source from 10 to 2 fps lowered desired demand from
269,727 to 159,099 bps. The Driver admitted optional picture and sound together
after 2.018 seconds. Selected output identities stayed unchanged, and the
received selected and optional media decoded through the existing Windows VP8
and Opus decoders. This used the original-forwarding Driver without capture;
received data was decoded offline. Capture-enabled derivation, physical audio,
presented cadence and Internet performance remain separate checks.

The Windows RTC pump's timer was compared with the same pinned SDK at
`9e359a52`. On the review machine's ordinary system tick, the Tokio wait left
the loopback bandwidth estimate around 0.2–0.3 Mbps; meeting the SDK deadlines
raised it above 11 Mbps. On a second Windows machine with a roughly 1 ms system
timer resolution, both implementations already admitted the selected and
optional media. Their single startup estimates were 1.206 and 1.831 Mbps;
those samples do not establish a comparative bandwidth improvement.

The platform owner uses one persistent high-resolution waitable timer and one
stopping event per RTC pump. In a same-process 10-second comparison, this reduced
worker CPU from 187.5 to 62.5 ms relative to one-millisecond sleep slices, with
similar median lateness. Actual Native consent, LocalInput, deadline replacement
and shutdown checks passed. Thread scheduling can still delay a wake. The
[Windows timer](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw)
and [wait](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitformultipleobjects)
own timing; RTC still owns pacing, congestion control and consent.

### Duplicate NACK Feedback

A controlled Windows UDP comparison uses Piik's `Transport.write_au`, real
SDP/DTLS/SRTP/RTCP and received RTP events. The same proxy adds 25 ms each way,
holds original reverse feedback for 350 ms and delays repair packets by 120 ms.
For one lost video packet, official str0m `8e0067cc` emits five repairs within
its measured 53 ms round trip; the
[patched dependency](../../prototype/channel-native/README.md#rtc-dependency)
emits one and recovers. A second loss also drops the first repair: the candidate
retries after 68 ms, exceeding its measured 54 ms round trip, and recovers.
This exercises encrypted transport repair; it does not measure decoded picture
quality or public-network success rates.

The SDK reset regression additionally clears resend history when transmit buffers
or the SSRC reset. Piik's existing immediate-retirement check preserves another
sender on the same transport. Retransmission stays in the SDK; the adapter adds
no packet-deduplication state.

## Running The Process Layer

The remainder of this section describes the archived 2.x runner and its CI inputs.
It used an isolated Linux machine or VM with Node/Go from the repository toolchain,
Google Chrome, current `iproute2` with netem `seed` support, `nftables`,
`conntrack` and `tcpdump`. Its CI built a pinned iproute2 6.17 traffic-control binary locally because
the runner's distribution package lacked that option. Namespace administration
requires root. Windows/macOS can run the model/unit layer; they need a Linux VM
for this process layer. Root on a production host is not an equivalent setup.

The archived 2.x [process runner](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/scripts/network-lab.ts) and [original instructions](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/docs/research/network-lab.md#running-the-process-layer) record the Go build and launch commands. Those commands require that snapshot's matching Go backend and Web assets.

Set `CHROME_PATH` to the installed Chrome executable before running. `--list`
lists scenarios without root; `--suite full`, `--cases browser-browser,app-app`,
`--repeat 3` and `--seed 42` select reproducible inputs. Netem seeds do not make
browser scheduling, kernel port allocation or real-time timings deterministic.
`--prediction compare --repeat 3` pairs the isolated Site capability on and off
with the same inputs and alternates run order. Ordinary STUN destinations stay
available in both cases through the existing lab STUN service. `distributions.json`
reports trial/failure counts and nearest-rank timing summaries for validated
media trials; unavailable and timed-out attempts never become zero-millisecond
successes. Small trial counts are observations, not population estimates.
`--verify` (CI `network_lab: verify`) runs negative controls against the actual
runner: missing fault, frozen picture (before and after an impairment), partially failed setup, and cancellation
during calibration or sharing. Each must fail for its intended reason and leave
no owned resources; an unrelated process failure is not a passing control.
Each fault phase replaces its owned qdisc completely: netem's in-place change
retains some omitted attributes, including a previous rate limit. Restoration
therefore checks the resulting rules and independent UDP reachability as well as
the resumed media. Recovery has its own picture/audio/feedback observation window.
That archived workflow's `network_lab` input ran the matching Go entry point and
never published. Reports and bounded synthetic-traffic captures were retained under
ignored `build/network-lab/results/`, with CI artifacts available for seven days.

The `quality-peer`, `quality-sfu-uplink` and `quality-sfu-downlink` cases use the
same moving 720p Browser source. They establish 45 seconds of baseline, constrain
one direction to 600 kbps for 30 seconds, then observe 90 seconds beyond resumed media. The
final observation must retain the original connection and source resolution for
at least ten seconds, with advancing pictures and audio. This is an
unconstrained-fixture recovery check, not a product resolution floor or proof of
game quality. Frame cadence, bitrate, loss, repair, freezes and QP remain separate
measurements. These longer cases cap captures at 500,000 packets, retaining only
each packet's first 96 bytes; ordinary cases keep their 100,000-packet bound.

The [full process acceptance](https://github.com/TNTcraftHIM/Piik/actions/runs/40218617697)
on 2026-10-25 passed all 83 trials across 43 scenarios on candidate `8db79dd0`,
with paired enhancement on/off trials where applicable and six negative controls.
Seventy trials produced progressing media; thirteen exhausted their deliberately
restricted routes with bounded unavailability. There were no observation timeouts.
All owned resources retired and host networking remained unchanged. The matrix
includes both voice and picture, STUN fallback, every Browser/App pairing,
address changes, SFU fallback and constrained/recovered quality. It measures the
laboratory profiles, not an Internet connection-success rate.
The [paired comparison](https://github.com/TNTcraftHIM/Piik/actions/runs/38301455274)
also passed eight trials across two seeds with alternating enhancement on/off
order. All four ordinary App/App trials delivered media; all four random-mapping
trials exhausted their routes. This validates comparison/reporting and establishes
no enhancement gain for that random-mapping profile.

The [sequential-mapping comparison](https://github.com/TNTcraftHIM/Piik/actions/runs/38433597605)
passed sixteen trials across two seeds and all four endpoint pairs. Both enhanced
App/App trials delivered video and audio after about 23.6 seconds; both disabled controls exhausted
their routes. Both Apps reported step-one observations, successful preparation
and socket adoption for the same connection. Packet captures confirmed SRTP and
reverse SRTCP on that tuple. The enhanced App/App case now requires media; its
disabled control remains observational so an ordinary-ICE improvement can pass.
Browser/Browser and both mixed directions exhausted their routes with either
setting in this profile. This establishes one complete product path through sequential
kernel NAT, not a field success rate or general benefit for Browser participants.

The [mixed-endpoint recovery comparison](https://github.com/TNTcraftHIM/Piik/actions/runs/38433591403)
passed eighteen trials: three address-change runs per endpoint pair and three
ordinary Browser/App and App/App connections each. Browser/App recovery took
about 4.9 seconds, including the three-second continuity window, compared with
13..32 seconds [before the repair](https://github.com/TNTcraftHIM/Piik/actions/runs/38430143831).
The Native receiver had removed RTX during codec selection. Packet captures
showed repeated old primary packets before the fix and negotiated RTX without
repeated primary sequence numbers afterward. Pion's existing
[RFC 4588](https://www.rfc-editor.org/rfc/rfc4588) repair handles reception;
no new recovery timer or relaxed replay check was added. The other endpoint pairs
retained their prior recovery range. These controlled observations establish a
media-recovery repair, not a change in NAT reachability or Internet success rate.
The [shared-receiver acceptance](https://github.com/TNTcraftHIM/Piik/actions/runs/38439642180)
adds three SFU-only outage trials, three SFU fallback trials and three further
Browser/App address-change trials. All delivered media and cleaned up their
resources. SFU outage recovery took about 4.9 seconds; repeated Browser/App
recovery ranged from 4.9 to 11.1 seconds, so 4.9 seconds is not a guaranteed bound.
The SFU-only fixture verifies the locked server-media control and disabled
NAT policy; it does not attempt to enable a hidden P2P setting.

The shared outgoing transport also needs RTX negotiation. A local UDP regression
delays NACK feedback after one dropped video packet: primary-stream repair
arrived after 16 later packets, but failed after 96, beyond Pion's default
64-packet SRTP replay window. Offering the associated RTX codec lets LiveKit
repair the delayed loss through its separate sequence space. A receiver declining
RTX retains ordinary NACK within the primary replay window. This applies to
Native and SFU outputs; it does not establish the cause of unmatched field stalls.

App Host checks must use the real H264 Browser-to-App ingress and App WAN sender;
launching an App alongside a Browser-only VP8 share is not an App-path test.

Each router uses destination-aware connection tracking for filtering. Independent
probes check responses from the contacted endpoint, another port and another
address before sharing. Preserve, random and sequential SNAT describe observed
mapping, not every consumer NAT implementation. Sequential cases use nftables'
number generator and a typed port map: new UDP flows advance through ports
40000..44095, with the same destination-dependent filter. Calibration must
observe three consecutive mappings before Piik starts. All four endpoint pairs
compare the enhancement capability; this capability also
changes the retry budget, so aggregate differences do not isolate one mechanism.
The recorded Native preparation and adoption results distinguish its use from
ordinary ICE. Address-change cases replace only the isolated router's UDP public
address and conntrack entries while proving that TCP signaling stays usable;
both old and new media windows retain their respective addresses for
packet/feedback checks.
IPv6 cases provide a Pion-based external STUN endpoint as well as IPv4 embedded
STUN. Browser mDNS host names cannot resolve across these routed networks;
keep normal Browser privacy behavior and obtain IPv6 reflexive candidates through
STUN. The App may use its ordinary IPv6 host candidates. IPv6 cases block IPv4
UDP and independently verify that block; they do not require a Browser to try a
blocked IPv4 candidate before selecting working IPv6. Continuity checks require
changing decoded pictures and advancing audio energy; cadence and dimensions are
measured separately, without imposing a new minimum on WebRTC adaptation.
App checks require current Native connection state and a local Browser bridge in
both initial and recovered media windows; a Browser WAN fallback cannot validate
Native recovery. Rate calibration requires offered traffic above the configured
ceiling, so a slow test process cannot impersonate a constrained network.
Recovery timing begins when the impairment is removed, including subsequent
calibration and sampling time. Recovery requires a new advancing-picture sample
followed by a full three-second audio/video continuity window and the current
Native path where applicable. A buffered burst followed by another stall keeps
the original 60-second observation deadline; it is not a successful recovery.
`firstPictureMs` starts at Viewer navigation and
ends at the first sample with at least 15 decoded frames; sampling is every
500 ms. Recovery checks poll every second. These are sampled media-admission
times, not exact first-packet timestamps or one-way media latency.

## Local Media Lifecycle Gate

The archived 2.x [media lifecycle runner](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/scripts/media-lifecycle-gate.ts) reused the process layer's endpoint, synthetic picture/tone, stats and cleanup on loopback without Linux namespaces or administrator permissions. Its build and selection inputs belong to that snapshot.

The four Browser/App directions exercise initial playback, a quiet source and
repainting, stop/reshare, either page reloading, joining before sharing, and
replacement during unfinished preparation. The last case releases real old SDP
after the new share is playing. Browser senders also receive a normal Viewer
ICE-restart request; both Browser and App receivers must recover on the same
playback connection. The SFU-only case covers the same steady
lifecycle, and the two fallback cases delay real Peer signaling for 15 seconds
to exercise SFU commitment followed by direct continuation. Video-frame callbacks
check that the working route keeps presenting during that continuation.

These are real local UI, room and media paths, not simulated route messages.
App senders use Browser H.264 ingress and Native fanout; App receivers use the
Native receive/playback bridge. Each local App has its own approved origin, and
the gate checks the exact control origin and current Native edge. SFU fallback
uses Browser publication/subscription here. This gate does not validate physical
Native capture/publication, real NATs or Internet connection success rates.

Reports under ignored `build/media-lifecycle/` record source identity, binary
hashes, Browser versions, stage samples, screenshots and resource cleanup.
First-picture timing starts after the stage's navigation/share action completes;
it is not end-to-end startup time. `--negative frozen-picture --cases browser-browser` freezes
the source after playback; it must fail specifically for non-progressing decoded
picture. `--negative cancel --cases browser-browser` cancels after playback.
Both must exit unsuccessfully with complete cleanup; an unrelated setup failure
is not a passing negative control.
Real link impairment and sustained resolution recovery remain in the namespace
and Pion transport gates, rather than interpreting a CDP throttle as UDP shaping.

On 2026-10-15, all seven cases passed twice on Windows with Chrome
154.0.8037.98, including cleanup. The four SFU-to-Peer continuation windows
had maximum presented-frame gaps of 76--118 ms on loopback; these are not WAN
latency guarantees. Frozen-picture and cancellation controls failed for their
intended reasons and cleaned up. The route regression separately covers a connected
Peer reaching its operation deadline before a first frame: untried fallback must
survive that deadline, while each attempted route retains its finite budget.

### Route-Handoff Measurement

An additional continuous `requestVideoFrameCallback` inspection loop can change
the behavior being measured. On Chromium 152.0.7977.82, it reproduced a receiver
stall during a P2P/SFU switch while RTP reception continued. Removing only that
extra observer, retaining pixel readback, decoded-frame counters and Piik's own
first-frame observer, passed six Auto/P2P/SFU transitions against the same current
Server: the moving VP8 picture sustained about 30 fps. Installed Chrome
155.0.8059.84 also passed with the continuous observer. This establishes a
probe-dependent browser interaction, not a Piik route failure or a particular
upstream fix. Recheck a failed probe with passive frame counters and changing
pixels before adding playback resets or transport workarounds.

## Sustained Quality Recovery

P2P stage comparisons also use the existing
[Browser shared/ordinary probe](./browser-local-encoding-pool.md#sustained-h264-recovery)
with recorded UDP limits and decoded frames, and
[coupled Native encoding/transport controls](./webrtc-encoder-pool.md#budget-restoration).
Compare restored allocation, encoded dimensions and received/decoded progress
separately. Single-codec recovery and an unblocked packet stream do not establish
recovery of every receiver or perceptual quality.

The CPU-only `TestPublicationConstrainedRecovery` gate complements the Browser
cases below. It runs the actual Native publication allocator and Pion transport
through healthy, brief, periodic and sustained constraints, then pause/resume
and source replacement. It checks recent frame arrival and sustained payload,
not decoded picture quality. The archived 2.x [publication recovery fixture](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/media/forwarding/publication_recovery_test.go) and [original instructions](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/docs/research/network-lab.md#sustained-quality-recovery) retain the matching inputs. The [publication comparison](./node-local-media-design.md#send-queue-recovery)
owns measured results and the distinction between encoder demand and capacity.

The [2026-10-14 comparison](https://github.com/TNTcraftHIM/Piik/actions/runs/38446966925)
passed two trials for each quality case on candidate `ea2c7268`, using Chrome
154.0.8037.97 and the moving 720p30 VP8 source. All six retained their connection,
restored source resolution and cleaned up. Times below start at impairment
removal; resumed media includes the existing three-second continuity check.
Source-resolution recovery is measured separately from resumed decoding.

| Constrained path | Resumed media | Sustained 720p |
| --- | --- | --- |
| Browser P2P downlink | 4.9 s | 45.3–47.2 s |
| Host-to-SFU uplink | 17.0–19.0 s | 28.1–29.1 s |
| SFU-to-Viewer downlink | 11.9–13.0 s | 22.0 s |

Final twenty-second windows delivered 29.3–29.4 decoded fps with no new freezes.
The impaired SFU paths did pause, and the Browser encoder's bitrate/quantization
recovered gradually after dimensions returned. These results do not establish
instantaneous or perceptually lossless recovery. The forwarding SFU can pause
when no received layer fits a child's capacity; it does not create a lower
encoding for that child.

The v1.9.2 report of persistent self-hosted degradation has no matched trace,
codec or confirmed route. Piik already forwards encoded video without server
decoding/transcoding. An opaque UDP relay changes transport feedback and delivery
semantics; its reported improvement does not isolate CPU, network or an SFU cause.
The [queue/probe repairs](./node-local-media-design.md#send-queue-recovery) address
confirmed mechanisms present in v1.9.2, but this run is candidate acceptance,
not a matched old/new reproduction of that report. It does not measure a cloud
server's CPU requirement, H264 behavior, multi-Viewer load or hours-long stability.
