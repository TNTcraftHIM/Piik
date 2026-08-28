# Current Status

Last updated: 2026-08-28

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `24cb780b54744af6e1bd5549254fa94c84adac96`, release `24cb780`, wire
  `screener-v16`, from `/opt/screener/releases/24cb780`. The immutable runtime
  tar SHA-256 is
  `45041f9796b1d62f49c408782335835a5e3c07238f9b532c8954ff5f5545b24c`;
  its 41-file manifest SHA-256 is
  `a1d0608f518b1fb0e4874e10e1eac9c731716b508f08569579f001668543c6f8`.
- The served Browser entry references `assets/index-Bo3ApbkQ.js`; the public
  asset SHA-256 is
  `87d074f43abf4b769d4930b52b6a21f1383c1d7229773a958feb22d592c08df7`.
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
- Native-edge local convergence defaults on for each new share and remains a
  pre-share Host opt-out. The adjacent default-off peer-only policy excludes all
  SFU paths for that share generation. Both policies lock while sharing.

## Current Source

- Canonical source uses the strict `screener-v17` Browser/server contract.
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

## Source/Production Delta

- Current source uses 24-hour rolling site-access authorization and the v17
  single wire contract; production remains on the v16 contract until release.
- Current source replaces aggregate route-fact retries with exact session,
  publication and transition opportunities; advances proved non-improving
  candidates; binds stall and recovery reports to physical media identities;
  and removes exact retired LiveKit Viewers while retaining generation-owned
  resource charges.
- Current source also keeps lease authority in `RoomStore`, batches stable-room
  expiry persistence, serializes share start with room replacement, binds Web
  release artifacts to their source revision, and retains Native sender code as
  research rather than a distribution surface. These corrections are not
  deployed; production remains exact release `24cb780` above.

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
  Both default it on with a pre-share Host opt-out. Weighted/global optimization
  remains parked.
- Repository simplification does not change or deploy product behavior beyond
  deleting proven dead private surfaces.
- Native/executable senders, shared encode, distribution packages, broad UI
  polish, and bilingual support remain outside the current release.

## Current Hold

No source P0/P1 is known. Production does not contain the current source
corrections until an explicitly authorized deployment. Sanitized route logging
remains enabled for the pre-release canary.
