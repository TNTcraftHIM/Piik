# Controlled Network Laboratory

The Go/Pion process runners and results below are retained 2.x evidence. The [current Rust source map](../standards/engineering.md#module-map) owns the private 3.x implementation. Generic network-model and namespace helpers remain reusable; the retired process runners are not current validation entrypoints.

This document owns the laboratory's method and evidence limits. Product routing
remains in [routing and transport](../standards/routing-transport.md); pending
work remains in [TODO](../todo.md). The laboratory does not authorize NAT or
adaptation changes.

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
the distribution of real-world NATs. The current process matrix uses desktop
Chrome and a Linux App with Browser-generated H264 ingress; it does not exercise
physical capture, other Browser engines, real gateway mapping or the public
invitation provider.

The `voice-browser-browser`, `voice-browser-app`, `voice-app-browser` and
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

## Running The Process Layer

Use an isolated Linux machine or VM with Node/Go from the repository toolchain,
Google Chrome, current `iproute2` with netem `seed` support, `nftables`,
`conntrack` and `tcpdump`. CI builds a pinned iproute2 6.17 traffic-control binary locally because
the runner's distribution package lacks that option. Namespace administration
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
The manual CI workflow's `network_lab` input runs this same entry point and never
publishes. Reports and bounded synthetic-traffic captures are under ignored
`build/network-lab/results/`; CI retains them for seven days.

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
