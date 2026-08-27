# Current Status

Last updated: 2026-08-27

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `17bd1e46fea7d391ce5df18a2bccf7a316bde693`, release `17bd1e4`, wire
  `screener-v15`, from `/opt/screener/releases/17bd1e4`. The immutable runtime
  tar SHA-256 is
  `74d75741ce25fe8989fd51f5ba217ee3f6b98cee7bffa1c703fe6d49a7d6e1b0`;
  its 41-file manifest SHA-256 is
  `ffe118ec1d9d14baaf6fdc0d8df0abbfab2e4ce083be9c71eba5ae7eb2805461`.
- The served Browser entry references `assets/index-DSw6oypG.js`; the public
  asset SHA-256 is
  `fcca56647ce4c50766b0271e111a7a4ccfa8bd28b778f71865d62de9d7743515`.
  Public `/healthz` returns 200. The release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts.
- Production enables SQLite room authority at
  `/var/lib/screener/rooms.sqlite`; live participants, routes and media remain
  process-only. A controlled restart retained the room authority and Host-owned
  capture while the Viewer rebuilt media without a page refresh. Lightweight
  mode remains available when `ROOM_DATABASE_PATH` is unset and reacquires a
  room rather than persisting the old authority.
- Public media listeners remain STUN-only UDP 3478 and LiveKit UDP 7882. Web
  ingress is TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are
  private. TURN, ICE/TCP, media TCP, TLS relay, port 5349, and relay ranges are
  disabled.
- Browser video uses the content-independent H.264 sender gate with VP8
  fallback, plus the locked pre-share `VP8 | Auto | H264` Host selector and
  resolved codec display. Video retains `contentHint = "motion"`; audio uses
  `music`. The SFU publisher uses the Host's one codec decision, leaves
  representation construction to pinned LiveKit,
  enables Dynacast, uses server send-side BWE, keeps AdaptiveStream disabled,
  and configures no external ICE servers on Browser SFU PCs.
- Screen audio provides live 64/128/192 kbps ceilings with 128 default. SFU
  publication uses stereo, DTX off, and RED off. Early autoplay presentation is
  gated by current media connection state.
- Native-edge local convergence is available behind the default-off pre-share
  topology policy. The adjacent default-off peer-only policy excludes all SFU
  paths for that share generation. Both policies lock while sharing.

## Current Source

- Canonical source uses the strict `screener-v15` Browser/server contract.
  Optional SQLite stable authority, non-expiring local preferred code, atomic
  room replacement and the Host codec selector remain implemented; production
  selects stable storage. Graceful restart, crash, timeout and network loss use
  one reconnect state. LiveKit room teardown cannot stop Host-owned capture.
- One event-driven controller owns the committed graph and one room-serial child
  operation. Initial direct acquisition uses a five-second foreground window;
  exact transport-connected progress may retain that candidate through the
  total deadline, while first decoded frame remains the only commit proof. SFU
  provides working media before finite background direct convergence. Healthy
  decoded edges remain sticky.
- WebRTC/LiveKit own media adaptation. With the per-share convergence gate
  enabled, one fresh degraded native edge may enter the existing serial route
  operation after availability work. A candidate commits only after first-frame
  readiness and fresh healthy native proof while the old edge remains degraded.
  Peer candidates stay first and bounded SFU is only the suffix after healthy
  Peer escape fails. The gate defaults off.
- Screener has no custom SFU layer list, quality score, layer selector,
  all-pairs probe, parent-wide prediction or periodic rebalancing. P2P and SFU
  still recover their current route before actual failure enters reassignment.
- Viewer hidden/freeze/pagehide suppress decoded-stall routing authority;
  visible/resume/pageshow rebaseline and rearm current-frame proof. SFU
  pagehide no longer triggers LiveKit's automatic disconnect. Native Viewer
  controls still own playback, and manual reconnect stays on the current route.

## Current Milestone

Native-edge local convergence is deployed behind its default-off per-share
policy. Persistent exact sender windows drive ordinary P2P movement. SFU quality
work is limited to multi-root Host fanout relief and requires independent
Host-ingress and same-Viewer candidate proof before one move.

## Active Boundaries

- Desktop Host background capture remains unconfirmed. The current-browser
  screening did not reproduce a Host-page drop; accepted Viewer lifecycle work
  prevents frozen JavaScript wall time from becoming an immediate route failure
  but is not capture keepalive.
- Current-path quality can drive opt-in local convergence in source and
  production. Weighted/global optimization remains parked.
- Repository simplification does not change or deploy product behavior beyond
  deleting proven dead private surfaces.
- Native/executable senders, shared encode, distribution packages, broad UI
  polish, and bilingual support remain outside the current release.

## Current Hold

No source or deployment P0/P1 is open. Sanitized route-event logging remains
enabled for the pre-release canary. Broader product evidence remains parked.
