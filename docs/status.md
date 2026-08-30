# Current Status

Last updated: 2026-08-31

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `11614c3820061a29aa053254bae5af2e4b27c36f`, release `11614c3`, wire
  `screener-v17`, from `/opt/screener/releases/11614c3`. The immutable runtime
  tar SHA-256 is
  `c5c3f7bc187e6e45372c7cd8e7708a3a8c7b998954c2fb1cd9fc7551162a3c1c`;
  its 41-file manifest SHA-256 is
  `b68ea94212598d4bbb2924f5c3c177ad30e3862f72de458a0f46cd16b55d3b41`.
- The served Browser entry references `assets/index-DePSo8m_.js`; the public
  asset SHA-256 is
  `64bbdaa981e48d2839bff3741dfc91565670bface51c5650e3699192fed05470`.
  Public `/healthz` returns 200. The release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts. Controlled application restarts
  have retained SQLite room authority and Host capture while P2P/SFU routes and
  Viewer diagnostics recovered without a page refresh.
- Production enables SQLite room authority at
  `/var/lib/screener/rooms.sqlite`; live participants, routes and media remain
  process-only. A controlled restart retained the room authority and Host-owned
  capture while the Viewer rebuilt media without a page refresh. Lightweight
  mode remains available when `ROOM_DATABASE_PATH` is unset and reacquires a
  room rather than persisting the old authority.
- Site access uses a stateless 24-hour rolling idle cookie. An active
  site-authorized page renews it hourly through the existing status request;
  Viewer-grant admission remains independent and cannot create or renew it.
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
- The living-room presentation is deployed with Chinese, English, and
  pure-visual modes, light/dark themes, one Host/Viewer stage language,
  a Host-first identity roster, progressive per-Viewer diagnostics,
  container-responsive topology, and reduced-motion behavior. Fresh Browsers
  start in visual mode; explicit choices persist locally.
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
  when that Viewer departs or the room is deleted. A replacement Host identity
  resets physical route ownership without discarding Viewer capacity. Retiring
  SFU roots remain only as inactive anchors while Peer descendants reassign.
- WebRTC/LiveKit own media adaptation. After availability work, one persistently
  degraded native edge may use the existing serial operation. A P2P candidate
  needs first-frame readiness, fresh native healthy sender evidence, and three
  clean receive windows that do not regress resolution or rounded FPS. A zero-
  frame incumbent is zero delivery only against an overlapping candidate that
  decodes video. Peer candidates stay first; bounded SFU remains only the whole-
  Host-root suffix; when no different Peer is eligible, the same operation may
  append one same-parent connection-regeneration candidate. Its old edge remains
  until proof, and its exact post-commit sender identity damps only another
  same-edge regeneration. The pre-share gate defaults on and locks while sharing.
- Every direct, Browser-relay, and Host SFU video sender owns one clone of its
  source track; the original remains presentation and source authority only.
  Replacement, rollback, unpublish, physical LiveKit sender recreation, and
  teardown retire that clone. Sibling clones may still share source pressure.
- Screener has no custom SFU layer list, quality score, layer selector,
  all-pairs probe, parent-wide prediction or periodic rebalancing. P2P and SFU
  still recover their current route before actual failure enters reassignment.
- Viewer hidden/freeze/pagehide suppress decoded-stall routing authority;
  visible/resume/pageshow rebaseline and rearm current-frame proof. Host and
  Viewer SFU clients disable LiveKit page-leave auto-disconnect, so SFU recovery
  cannot stop Host-owned capture. Native Viewer controls still own playback,
  and manual reconnect stays on the current route.
- Viewer presentation derives access, Host, route, playback, and runtime state
  from separate owners. An exact media generation plus monotonic proof epoch
  owns visible-frame truth; every invalidation rearms proof, while stale epochs
  and replaced generations cannot clear or revive the current result. Viewer
  diagnostics continue through incomplete presentation windows, but those
  windows remain ineligible for route-quality convergence.
- Host, Viewer, join, and access surfaces share the living-room presentation
  model. Room codes, invitation URLs, the current display name, selected
  participant details, route labels, and metrics remain visible in visual mode;
  Host and Viewer couch/topology identities stay consistent across expression
  modes, and bounded deep trees scroll within their own surface.

## Source/Production Delta

- Production application code matches canonical source application revision
  `11614c3820061a29aa053254bae5af2e4b27c36f`; current `main` adds only this
  status-record checkpoint after that application revision.

## Active Boundaries

- Desktop Host background capture remains unconfirmed. The current-browser
  screening did not reproduce a Host-page drop; accepted Viewer lifecycle work
  prevents frozen JavaScript wall time from becoming an immediate route failure
  but is not capture keepalive.
- Current-path quality can drive local convergence in source and production,
  including bounded same-edge connection regeneration. Both default it on with a
  pre-share Host opt-out. Weighted/global optimization remains parked.
- Repository simplification does not change or deploy product behavior beyond
  deleting proven dead private surfaces.
- Native/executable senders, shared encode, and distribution packages remain
  outside the current release. Current UI refinement is presentation-only and
  does not authorize route or media-model changes.

## Current Hold

No source or deployment P0/P1 is open. Sanitized route logging remains enabled
for the pre-release canary.
