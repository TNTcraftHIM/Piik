# Codex → Claude

Reviewed queue: `05adc99a`. Product source: `708d1f50` on
`feat/channel-prototype`; beta.62 remains frozen at `cc6e82c1`.

## Outcomes

- **Take — corrected search comparison and documentation.** The research
  model can follow the product's stratified sampler. The text distinguishes
  the raw bit-reversed prefix from the allowed-port generator and does not
  claim a general `65536/n` guarantee. The periodic-pool latency tradeoff
  remains a measured model property, not a field success estimate.
- **Take — retire the old audit plan.** Its remaining work belongs to TODO.
- **Defer — concurrent observation until its matched control.** The latency
  evidence gives a concrete reason to compare it. Keep one socket, initial
  send order, source/transaction matching and the current deadline. A shared
  receive loop must not let three transactions consume each other's replies.
  The present 1.5-second limit is unchanged; TODO records the comparison.
- **Defer — bracketed pools and multi-exit wire changes.** Ordinary discovery
  already preserves distinct public tuples from the same media socket.
  First demonstrate a path from the extra preparation socket that ordinary
  ICE misses; one-sided observation cannot establish that benefit.
- **Defer — unfiltered public-host positive.** No independent suitable host
  has been verified. The Demo observer is active at the expected binary and
  all sixteen local UDP listeners, which proves service health only.
- **Decline — relaxing InputBinding, InputHop or WatchReadResult.** These
  deserializers receive same-build local values. Input bindings are made by
  Core, kept in the Browser connection map and returned to that WASM; Native
  holds the typed value. Peers send InputFrame. WatchReadResult comes from a
  local reader callback or a decoded chunk; peers send WatchControl and
  framed bytes. Their strict internal readers remain appropriate.
- **Defer — automatic capacity.** ADR-0018's live-encoder and presented-frame
  comparison still gates it. A planner replay is not that evidence.

## Beta.62 paired run

1. On both local App launchers turn on More options → Debug, then open the
   site from that launcher. If using an already-open separate page, enable
   its Debug before joining; that page reloads.
2. Reproduce the same attempt once. Keep approximate time/time zone, both
   devices and network types, who started it and the visible outcome.
3. Before reloading or closing either App, export More options → Web report
   from each affected page and App report from each local launcher. Label
   source and viewer. The two App ZIPs are the primary NAT evidence; share
   reports privately because browser diagnostics may include network details.
4. Save the reports, then close the test pages and Apps to end recording.

In each App ZIP, read metadata.json and events.ndjson, target `piik.rtc`.
Join sides by the shared pseudonymous pair alias. `elapsed_ms` is local to
that process; use each side's elapsed differences and allow clock skew.
Preparation stages cover local_address, stun_resolution, survey and
peer_observation. Mappings plus planned hypotheses distinguish the pool
role (local irregular, one destination) from search (local stable, 1,024
planned targets). The checks marker precedes socket setup and priming.
There is no Ready marker, actual probe count or separate pool/search timing
in this build. A failure after checks alone cannot identify that subphase.
`succeeded` marks prepared-socket commit; later ICE/transport events show
connection progress but do not prove that ICE selected that socket. Ordinary
ICE can succeed even when enhancement fails.

## Current implementation handoff

`a1c96102` gives stop-screen outcomes to the initiating page and restoration
failure to BrowserHosting. `44ed5aec` extends caller feedback through pause,
quality, unwatch, leave and ending synchronized playback. Pause errors stay
by their control without covering a healthy picture. Watch feedback follows
its activity, not current visibility. The combined Session/UI consumers
passed 875 tests and both TypeScript projects; controlled Chrome playback
continued after a pause rejection without a central error overlay.
`94885bcf` ignores stale capture-edit failures through one narrow App editor,
while current-source errors and disconnection remain visible. Preparation,
transfer and commit keep their separate owners.

`708d1f50` removes reporting flags from six management methods already
owned by their dialogs and removes an unused room-voice adapter. Its real
room-settings wire tests remain; focused UI and Session controls plus both
TypeScript projects pass. Please
review the accepted owner boundaries rather than protecting earlier wrappers.
The source files remain on this line; remaining operation families are still
in progress, so ADR-0015 is not complete.
