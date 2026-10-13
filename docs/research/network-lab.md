# Controlled Network Laboratory

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

The fast layer already uses Pion vnet in `internal/app/mediaedge` and
`internal/media/forwarding`. It exercises production transport with synthetic
media, not every Browser/OS behavior. The process layer uses Linux namespaces,
kernel NAT/firewall rules and traffic shaping. Neither layer establishes
Windows/macOS driver behavior, physical radio scheduling, mobile suspension or
the distribution of real-world NATs. The current process matrix uses desktop
Chrome and a Linux App with Browser-generated H264 ingress; it does not exercise
physical capture, other Browser engines, real gateway mapping or the public
invitation provider.

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

```sh
npm ci
npm run build:web
mkdir -p build/network-lab/bin
CGO_ENABLED=0 go build -trimpath -o build/network-lab/bin/piik-server ./cmd/piik-server
CGO_ENABLED=0 go build -trimpath -o build/network-lab/bin/piik-app ./cmd/piik-app
CGO_ENABLED=0 go build -trimpath -o build/network-lab/bin/stun ./scripts/network-lab/stun
sudo --preserve-env=PATH,CHROME_PATH "$(command -v node)" --import tsx scripts/network-lab.ts --suite smoke
```

Set `CHROME_PATH` to the installed Chrome executable before running. `--list`
lists scenarios without root; `--suite full`, `--cases browser-browser,app-app`,
`--repeat 3` and `--seed 42` select reproducible inputs. Netem seeds do not make
browser scheduling, kernel port allocation or real-time timings deterministic.
`--prediction compare --repeat 3` pairs the existing Host enhancement switch on
and off with the same inputs and alternates run order. `distributions.json`
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

The [full process acceptance](https://github.com/TNTcraftHIM/Piik/actions/runs/38300988699)
on 2026-10-13 passed all 19 scenarios and five negative controls, including
resource cleanup and unchanged host networking. Sixteen scenarios produced
advancing decoded audio/video; blocked UDP and the two random-mapping profiles
produced bounded unavailability. A passing failure observation is not a
successful connection or an Internet success-rate measurement.
The [paired comparison](https://github.com/TNTcraftHIM/Piik/actions/runs/38301455274)
also passed eight trials across two seeds with alternating enhancement on/off
order. All four ordinary App/App trials delivered media; all four random-mapping
trials exhausted their routes. This validates comparison/reporting and establishes
no enhancement gain for that random-mapping profile.

The [sequential-mapping comparison](https://github.com/TNTcraftHIM/Piik/actions/runs/38332289068)
passed twelve trials across two seeds. Both enhanced App/App trials delivered
1280x720 video and audio after about 23.7 seconds; both disabled controls exhausted
their routes. Both Apps reported step-one observations, successful preparation
and socket adoption for the same connection. Packet captures confirmed SRTP and
reverse SRTCP on that tuple. The enhanced App/App case now requires media; its
disabled control remains observational so an ordinary-ICE improvement can pass.
Browser/Browser and App/Browser exhausted their routes with either setting in
this profile. This establishes one complete product path through sequential
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

App Host checks must use the real H264 Browser-to-App ingress and App WAN sender;
launching an App alongside a Browser-only VP8 share is not an App-path test.

Each router uses destination-aware connection tracking for filtering. Independent
probes check responses from the contacted endpoint, another port and another
address before sharing. Preserve, random and sequential SNAT describe observed
mapping, not every consumer NAT implementation. Sequential cases use nftables'
number generator and a typed port map: new UDP flows advance through ports
40000..44095, with the same destination-dependent filter. Calibration must
observe three consecutive mappings before Piik starts. All four endpoint pairs
compare the existing enhancement switch; this switch also
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
