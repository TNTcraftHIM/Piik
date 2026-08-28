# Current Status

Last updated: 2026-08-28

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `aa3043b9059264963ef9206e1e606a6d3c83a873`, release `aa3043b`, wire
  `screener-v16`, from `/opt/screener/releases/aa3043b`. The immutable runtime
  tar SHA-256 is
  `c1eb9e575a6865dc1b1ad9b9c79d5575a0e25592576c8362039c501a1e45647c`;
  its 41-file manifest SHA-256 is
  `7da8010103611f033a9c9bfe8a22f2645edf63b1d923459b3af7bd5ca5081f88`.
- The served Browser entry references `assets/index-DvVz3_bv.js`; the public
  asset SHA-256 is
  `a75114ab543eb247822ac86fb4aec78ca03a6ded5032c9f9fb8b92a0c2cb271f`.
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
  decoded edges remain sticky. A connected Viewer's advertised effective
  capacity survives sharing-generation graph replacement and is cleared only
  when that Viewer departs or the room is deleted.
- WebRTC/LiveKit own media adaptation. With the per-share convergence gate
  enabled, one fresh degraded native edge may enter the existing serial route
  operation after availability work. A P2P candidate commits only after the same
  Viewer sees first-frame readiness plus three fresh windows that strictly
  improve delivered resolution or rounded FPS without regressing either. Peer
  candidates stay first; bounded SFU is only the suffix for whole-Host-root
  degradation and retains native publication proof. The gate defaults on in
  source and remains a locked pre-share opt-out.
- Screener has no custom SFU layer list, quality score, layer selector,
  all-pairs probe, parent-wide prediction or periodic rebalancing. P2P and SFU
  still recover their current route before actual failure enters reassignment.
- Viewer hidden/freeze/pagehide suppress decoded-stall routing authority;
  visible/resume/pageshow rebaseline and rearm current-frame proof. SFU
  pagehide no longer triggers LiveKit's automatic disconnect. Native Viewer
  controls still own playback, and manual reconnect stays on the current route.

## Current Milestone

Measured route convergence, generation-owned Viewer presentation and
endpoint-owned capacity are deployed. The 6020 postflight restored four Viewer
capacities, used P2P relays after one bounded direct miss, converged both SFU
subscribers back to P2P, and retired the Host SFU publication.

## Active Boundaries

- Desktop Host background capture remains unconfirmed. The current-browser
  screening did not reproduce a Host-page drop; accepted Viewer lifecycle work
  prevents frozen JavaScript wall time from becoming an immediate route failure
  but is not capture keepalive.
- Current-path quality can drive local convergence in source and production.
  Source defaults it on; production remains default-off until a later release.
  Weighted/global optimization remains parked.
- Repository simplification does not change or deploy product behavior beyond
  deleting proven dead private surfaces.
- Native/executable senders, shared encode, distribution packages, broad UI
  polish, and bilingual support remain outside the current release.

## Current Hold

No source or deployment P0/P1 is open. Sanitized route logging remains enabled
for the pre-release canary.
