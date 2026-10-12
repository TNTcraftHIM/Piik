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
the distribution of real-world NATs.

Actual packets/counters must corroborate each impairment. DevTools accepting a
network-emulation request is insufficient: an earlier Piik check observed RTP
outside the requested limits. Keep negative controls, finite deadlines and
resource limits as part of the laboratory rather than changing product recovery
to make an experiment pass.
