# Current Status

Last updated: 2026-09-05

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

- Canonical source uses the strict `screener-v20` Browser/server contract.
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
- NAT prediction stays authority-gated and defaults on only when offered. Browser
  and Native P2P use one connection-local rule with Site or Public-Link survey
  endpoints; pure LAN, route scoring, and SFU preference remain unchanged.
  Enabled acquisition now shares a three-attempt budget in the route controller,
  across foreground P2P and background direct continuation. Viewer progress
  reflects actual candidate creation; quality trials retain their prior budget.
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
  and manual reconnect stays on the current route. A Client-launched Viewer can
  receive H.264/VP8 and Opus through a native encoded source, bridge one local Browser
  preview, and reuse that source for compatible P2P children; unsupported codec
  or failed bridge returns to the Browser peer.
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
  One Go entry starts a process-level loopback capability service, then opens the
  current system-Browser launcher for Local, temporary public-link, or saved-Site
  operation. The saved Site remains allowed while another room source runs; the
  same Host UI explicitly selects
  Browser capture or an exact native screen/window. Windows Native now shares
  the VP8/Auto/H264 selector, with libvpx software VP8 and hardware H264; Auto
  uses a bounded target-profile throughput check. Both VP8 and Auto-selected
  H264 passed real Browser delivery and codec-stable live/source changes.
  Windows gates prove
  packaged Local/Site operation, WGC hardware-H.264 plus process/system audio, bounded
  shared-encode P2P, and cleanup. The window arm also proves source end and
  same-room reselection; display-source lifecycle remains a separate physical
  gate. An explicit target assembler also produces a
  Linux amd64 package with proved Local/one-link runtime and a structurally
  verified macOS arm64 package. Its capture sidecar passes an arm64 compile,
  hardware-H.264 IDR self-test, and audio-adapter build, but the package and
  capture path remain unrun on a physical Mac. The Linux package now includes a
  thin Portal/PipeWire/GStreamer hardware-H.264 capture adapter and passes its
  compile, probe, package, startup, and shutdown checks; real desktop capture,
  system audio, and recovery remain unproved. Client-scoped pull requests build
  and run the scripted Local smoke on all three candidates before merge; a
  validated `main` push emits them as short-lived Actions artifacts. One-link
  mode preserves the Host Local authority while exposing its ordinary invitation
  and HTTP/WebSocket control path through a session-scoped Quick Tunnel. An
  independent Linux Pion Viewer
  has received that native media over a direct ICE pair; remote Browser media
  remains unproved. Site and one-link native shares also make one bounded
  best-effort PCP/UPnP/NAT-PMP mapping and Pion Universal-UDP-mux STUN discovery
  on their media socket. A public-link run delivered 35 H.264 packets to an
  independent Linux Viewer; no predicted-path win is yet claimed.
  Native P2P edges now negotiate TWCC and send Pion GCC's target-versus-source
  payload category through the existing sender-quality evidence path without
  pacing or changing the shared encode. The existing quality operation may test
  a Browser sender for one persistently degraded Native edge without lowering
  healthy shared edges. A local bridge supplies native Host media to the existing
  Browser LiveKit publisher; an isolated LiveKit gate
  proves default 1080p delivery, a live change to 480p, and complete cleanup
  without a second SFU client.
  A Windows gate proves Browser Host to Client-native Viewer delivery and Chrome
  decode; an RTP gate covers bounded H.264/Opus child relay and cleanup.
  Client-assisted Browser H.264 capture now reuses one local sender for Native
  fanout while quality convergence is enabled. Its two-Viewer gate covers
  cadence, live controls and Client-exit recovery; weak-network acceptance
  remains open. Native RTP forwarding preserves padding and its sequence
  continuity without requiring decoded dimensions for capacity evidence.
  Native control treats malformed/stale/repeated per-edge signaling as disposable;
  unexpected Client close reaches the current Browser participant through the
  existing fence. Windows
  retains one converted frame for quiet-source keyframe recovery. Its live
  profile gate keeps two PeerConnections while moving the hardware source from
  720p30 to 1440p60, then to 480p15 while paused, and resumes both Viewers;
  current source-switch, static, and crash gates pass, while cross-version
  capture remains open.
  Local Client access is open by default and can be protected with a user-chosen
  password from the Browser launcher; Hosted Site access is unchanged.
  Non-Windows native media remains outside physical acceptance. The default
  packaged Client launcher performs a non-blocking official GitHub Release check;
  the deployment tree provides a read-only operator check against the same full-
  SHA release identity. Neither installs or interrupts a running share.

## Current Hold

Client acceptance remains open for the reported Windows 10 display startup and
game-specific source behavior. Windows 11 display, minimized-source recovery,
live presets and source-switch checks pass, but do not establish those reports
as resolved. NAT acquisition has controller and signaling coverage, not a new
public-network success-rate claim. Its added prepare progress field requires a
coordinated private-wire release: old strict pages cannot consume it safely.
Native codec and capability fields likewise require the matching bundled UI.
Production is unchanged; [TODO](./todo.md) owns acceptance and release work.
