# Current Status

Last updated: 2026-09-09

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) owns unresolved physical limits,
and Git/PRs own completed history.

## Production

The coordinated embedded-media cutover is complete. The immutable release
descriptor, runtime REVISION and operator deployment record own exact identity.

- One Go process serves the Web application, room authority/signaling,
  Binding-only STUN on UDP 3478/3479/3480 and optional SFU on UDP 7882.
  External LiveKit/coturn services are stopped and disabled. nginx retains HTTPS.
- Browser/server v22, Native control v9 and capture v7 form the current private
  contract. Old pages and Clients must use matching artifacts.
- SQLite persists stable room authority; participants, routes and media remain
  process-only. Lightweight mode remains available without a database path.
- Public health/assets and all three STUN Binding endpoints pass postflight.
  Synthetic H264/VP8 media crosses the public SFU, retains decoded Opus through
  720p-to-480p changes, and retires cleanly. Public signaling also passes a direct
  Peer check; both direct endpoints were on the acceptance machine.
- Initial SFU startup exposed the systemd address-family restriction on Linux
  interface discovery. The old release/unit/environment/proxy/media-service
  state was restored successfully, then the corrected unit passed media
  postflight. AF_NETLINK is needed by Go/Pion interface enumeration; no new
  administrative capability was granted. The template correction is carried
  in the current Debug supplement.
- This private deployment is not a public demonstration service.

## Current Supplement

Detailed Client, Server and Browser Debug feedback is the active implementation
scope. Complete its checks and owner review before another integration or
deployment; do not treat a foundational logger as the detailed report.

The supplement retains the existing local recorder/export owners and adds
correlated requests, meaningful error causes, media/dependency observations,
selected runtime context and explicit partial-report/history information.
[Configuration](./reference/configuration.md#diagnostics) owns exact activation,
report contents and disclosure. The Linux service-template correction belongs
to this same supplement.

Public README/Quick Start refinement, the static GitHub Pages website and the
planned piik rename are queued after this work. No public site or bulk rename
has been deployed. [TODO](./todo.md) is the only work ledger.

## Media Evidence And Limits

- Compatible Native consumers share one complete stock WebRTC encoding and
  adaptation pipeline per local output. Different weak demands stay independent;
  suitable received media can be forwarded without decoding/re-encoding.
  Pion/LiveKit retain transport, estimation, pacing and forwarding ownership.
- Windows H264/VP8 have bounded encoding/adaptation evidence. Actual Native
  relay checks cover compatible sharing, weak-budget separation and rejoining,
  source retirement and large encoded-frame delivery. These results do not
  establish a universal encoder count, CPU saving or Browser-equivalent quality.
- Windows Host acceptance covers live and paused settings, quiet-source
  preparation/restore, source changes and subsequent sharing. The owner
  confirmed Windows 10 whole-display capture resolved. Specific new game/device
  failures should be reopened from new evidence.
- Native Host publication through embedded SFU retains video/audio; Browser to
  Client fanout and Client-exit fallback have bounded physical checks. Two
  independent Native sessions have simultaneous media/retirement evidence.
- The Linux runtime container has non-root/read-only, memory/SQLite, diagnostic
  export, STUN and listener-lifecycle evidence. This does not establish every
  operator's proxy/firewall or public-media configuration.
- Pure Browser encoded reuse was investigated after the mainline checkpoint.
  Late-join recovery works in the legacy probe, but shared-master quality and
  sender accounting violate independent adaptation; standard Transform rejects
  cross-source frames. No product adapter was added. Normal Browser senders and
  optional Client fanout remain supported.
- Slow adaptation recovery, the extreme CPU-overload sampling limit and missing
  broad device/network/endurance results remain explicit in
  [encoder research](./research/webrtc-encoder-pool.md) and verification status.
  macOS/Linux physical capture is deferred by the owner; Windows Client and
  Browser are this phase's primary targets.
