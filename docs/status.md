# Current Status

Last updated: 2026-08-28

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `fdc18d48cef15abd531e0066a07bc7650b4082a3`, release `fdc18d4`, wire
  `screener-v16`, from `/opt/screener/releases/fdc18d4`. The immutable runtime
  tar SHA-256 is
  `930f6ae45fce35da54941b081138a2a9fa35ba933d543ff4ed82e93aebd70070`;
  its 41-file manifest SHA-256 is
  `72e3758805ff0deb28084da9d0a6eb5a131e69397ecce52c917fb02b153e881d`.
- The served Browser entry references `assets/index-BLS925La.js`; the public
  asset SHA-256 is
  `a8048291d98d21b0bab9e14599f8d5f7425d59052ff0867e62d1640411941987`.
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

- Canonical source uses the strict `screener-v16` Browser/server contract.
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
  operation after availability work. A P2P candidate commits only after the same
  Viewer sees first-frame readiness plus three fresh windows that strictly
  improve delivered resolution or rounded FPS without regressing either. Peer
  candidates stay first; bounded SFU is only the suffix for whole-Host-root
  degradation and retains native publication proof. The gate defaults off.
- Screener has no custom SFU layer list, quality score, layer selector,
  all-pairs probe, parent-wide prediction or periodic rebalancing. P2P and SFU
  still recover their current route before actual failure enters reassignment.
- Viewer hidden/freeze/pagehide suppress decoded-stall routing authority;
  visible/resume/pageshow rebaseline and rearm current-frame proof. SFU
  pagehide no longer triggers LiveKit's automatic disconnect. Native Viewer
  controls still own playback, and manual reconnect stays on the current route.

## Current Milestone

Measured route convergence and generation-owned Viewer presentation are
deployed. A compatible `screener-v16` application restart retained the active
6020 Host capture and rebuilt six Viewer routes without a page reload.

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

No source or deployment P0/P1 is open. Sanitized route logging remains enabled
for the pre-release canary.
