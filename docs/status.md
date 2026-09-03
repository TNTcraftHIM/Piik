# Current Status

Last updated: 2026-09-04

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs the strict `screener-v19` Browser/server
  contract. Exact revision, release, artifact, manifest, and asset identity are
  retained by the immutable release descriptor, runtime `REVISION`, and
  deployment record rather than copied into this source snapshot.
- The latest scoped postflight found public health and the immutable Browser
  asset available, with Screener, LiveKit, coturn, and nginx active and without
  restarts.
- Production enables SQLite room authority at
  `/var/lib/screener/rooms.sqlite`; live participants, routes and media remain
  process-only. A controlled restart retained the room authority and Host-owned
  capture while the Viewer rebuilt media without a page refresh. Lightweight
  mode remains available when `ROOM_DATABASE_PATH` is unset and reacquires a
  room rather than persisting the old authority.
- Site access uses a stateless 24-hour rolling idle cookie. An active
  site-authorized page renews it hourly through the existing status request;
  Viewer-grant admission remains independent and cannot create or renew it.
- Public media listeners remain STUN-only UDP 3478 and LiveKit UDP 7882.
  Production enables optional NAT prediction with self-hosted STUN-only UDP
  3479 and 3480; ordinary `STUN_URLS` and media routes remain unchanged. Web
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

- Canonical source uses the strict `screener-v19` Browser/server contract.
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
  append one same-parent connection-regeneration candidate. Inconclusive current-
  sender windows retain the bounded Peer operation; failed exact candidates stay
  consumed until the sender or candidate opportunity changes. The pre-share gate
  defaults on and locks while sharing.
- Source keeps NAT prediction deployment-gated and disabled by default. When a
  deployment enables it, Host Advanced settings shows a per-share switch that
  defaults on. Every Browser P2P role uses the same bounded, connection-local
  adapter with only the deployment's self-hosted 3478/3479/3480 STUN endpoints;
  candidate and selected-path logs retain anonymous
  `ordinary | predicted | unknown` provenance. Ordinary candidates and SFU
  fallback remain unchanged.
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

## Source/Production Relationship

- The deployment record owns exact source/release comparison. Routine releases
  change this file only when its semantic or operational snapshot changes.

## Active Boundaries

- Desktop Host background capture remains unconfirmed. Current Browser screening
  did not reproduce a drop; Viewer lifecycle work prevents frozen JavaScript
  wall time from becoming route-failure evidence but is not capture keepalive.
- Current-path quality can drive local convergence in source and production,
  including bounded same-edge connection regeneration. Both default it on with a
  pre-share Host opt-out. Weighted/global optimization remains parked.
- Source contains the cross-platform Client outside the current Web release.
  One Go entry opens a lightweight system-Browser launcher for Local, temporary
  public-link, or Site operation, supervises the same Node application when
  needed, and owns loopback native media. The same Host UI explicitly selects
  Browser capture or an exact native screen/window. Windows gates prove
  packaged Local/Site operation, WGC hardware-H.264 plus process/system audio, bounded
  shared-encode P2P, and cleanup. The window arm also proves source end and
  same-room reselection; display-source lifecycle remains a separate physical
  gate. An explicit target assembler also produces a
  Linux amd64 package with proved Local/one-link runtime and a structurally
  verified but unexecuted macOS arm64 package; its capture sidecar now passes an
  arm64 compile plus hardware-H.264 IDR self-test. Client-scoped pull requests
  build and Local-smoke all three candidates before merge; a validated `main`
  push emits them as short-lived Actions artifacts. One-link mode preserves the Host Local
  authority while exposing its ordinary invitation and HTTP/WebSocket control
  path through a session-scoped Quick Tunnel. An independent Linux Pion Viewer
  has received that native media over a direct ICE pair; remote Browser media
  remains unproved. Site and one-link native shares also make one bounded
  best-effort PCP/UPnP/NAT-PMP mapping for their sole UDP socket without
  changing ICE when no gateway accepts it; pure LAN Local mode does not.
  Native P2P edges now negotiate TWCC and send Pion GCC's target-versus-source
  payload category through the existing sender-quality evidence path without
  pacing or changing the shared encode. A local bridge now supplies native Host
  media to the existing Browser LiveKit publisher; an isolated LiveKit gate
  proves 1280x720 delivery and complete cleanup without a second SFU client.
  Non-Windows capture remains outside the release. The default packaged Client
  launcher performs a non-blocking official GitHub Release check and the
  deployment tree provides a read-only operator check against the same full-SHA
  release identity; neither installs or interrupts a running share.

## Current Hold

No source or deployment P0/P1 is open; sanitized route logging remains enabled.
