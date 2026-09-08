# Current Status

Last updated: 2026-09-09

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Recorded Pre-Cutover Production Check

Read-only verification on 2026-09-08 confirmed the pre-cutover production state
below. The runtime release descriptor and deployment record own later cutover
identity; this historical check is not a live service-status endpoint.

- The running Go application and public Browser asset at
  `https://share.bonfire.icu` retain the strict `screener-v21` contract.
  Current revision, release, artifact,
  manifest, and asset identity are
  retained by the immutable release descriptor, runtime `REVISION`, and
  deployment record rather than copied into this source snapshot.
- The latest scoped check found application health and the immutable Browser
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
  ingress is TCP 80/443; Screener 8787 and LiveKit control/signaling 7880 are
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

- The candidate uses one shared Go core and the strict `screener-v22`
  Browser/server contract, Native control v9 and capture v7. These artifacts
  form one private contract. Optional SQLite persists stable room authority;
  participants, routes and media remain process-only.
- Hosted Screener owns configured Binding-only STUN and optional SFU UDP
  listeners in-process. SFU SDP/ICE and direct-subscriber demand use authenticated
  room signaling. There is no external SFU room service, Browser LiveKit SDK,
  media token or second signaling connection. Startup and shutdown own all
  configured listeners; Local and public-link Clients remain P2P-only.
- One controller still owns the committed graph and one serial child operation.
  Endpoint copy limits, first-decoded-frame commits, bounded direct acquisition
  and candidate-relative quality proof remain in
  [routing and transport](./product/routing-transport.md). Exact physical
  subscription/publication closure now releases the matching SFU reservation.
- Native parents and embedded SFU share a Pion/LiveKit media adapter for
  forwarding, bandwidth estimation, allocation, pacing and recovery. A Native
  parent reuses a suitable encoded output and derives a missing lower output
  only on direct-child demand. Source groups retain the highest needed output
  and lower fallbacks; each child receives one selected output. Native Host SFU
  publication reuses the source directly and has one aggregate upstream budget.
  [Media quality](./product/media-quality.md) owns this behavior and its limits.
- Browser senders retain source-owned clones and stock WebRTC adaptation.
  Current SFU demand updates the publisher's active output prefix; live quality
  changes and ICE recovery retain their connection identities. Healthy media
  survives transient room-signaling loss, and transport teardown cannot stop
  the Host's original capture track.
- Host tab authority is separate from the persistent origin resume hint. The
  Client admits two independent native control sessions; reconnect, room
  replacement and source retirement remain fenced by their current owners.
  Public-link startup reserves its local listener before starting a tunnel.
- Viewer presentation retains current-media identity and decoded-frame proof
  across lifecycle changes. Diagnostic capture, signaling and native-request
  events are opt-in and bounded; [configuration](./reference/configuration.md)
  owns activation and export. Diagnostics do not add media or routing authority.
- The runtime-only container recipe reuses the Server release rather than
  rebuilding the application. Non-root/read-only execution, memory/SQLite
  restart behavior, diagnostic export, STUN and UDP lifecycle pass in the local
  Linux VM. Public-network media and production cutover remain separate.

## Source/Production Relationship

The source change requires a coordinated production cutover. The recorded check
above retains the external-service history; exact release identity belongs to
the deployment record. The
[self-hosting transaction](./operations/self-hosting.md#coordinated-embedded-media-cutover)
replaces those services and their configuration together. The routine application
wrapper requires an existing embedded Go deployment and cannot perform or roll
back the initial infrastructure change.

## Active Boundaries

- Native shared-output implementation follows the
  [encoder-pool review](./research/webrtc-encoder-pool.md); remaining release
  acceptance is held in TODO. Windows capture and derivation now attach stock
  WebRTC output pipelines; both codecs pass bounded process-level shrinking and
  recovery checks. Incompatible weak-consumer grouping now has real relay
  split/rejoin and independent-dimension delivery evidence; exact throughput,
  representative-network behavior and extreme-overload limits remain explicit.
  The extreme single-core check reaches WebRTC's sample-reset boundary; it does
  not justify another application resource controller.
  Independent Client/service fixes remain preserved.
- Browser and Native H264/VP8 publication through embedded SFU pass Browser decoding,
  live-profile and cleanup checks; the Native path also delivers Opus. Bounded
  Native VP8 forwarding/derivation and stopped-upper recovery have synthetic
  codec and shaped-network evidence. Hardware
  overload, below-lowest-output, public-network and packaged acceptance remain open.
- Current Windows VP8 and H264 owned-window minimize/profile/restore checks pass,
  including live and paused changes and the H264 source-switch/restart path.
  The owner confirmed Windows 10 display sharing resolved. Distinct game
  HWND/device-loss behavior, 60 fps endurance and hardware overload remain
  separate evidence boundaries. The reported
  machine freeze has no confirmed cause; [TODO](./todo.md) owns the current
  authorization and serialization of physical workloads.
- Linux capture producers compile. Updated macOS producers still require an
  SDK build; neither platform's current capture/audio/recovery has physical
  acceptance. Prior package and single-output results do not prove the new
  multi-output contract. The owner defers these secondary-platform matrices;
  Windows Client and Browser remain this phase's acceptance targets. Two Native
  control sessions and rooms now pass concurrent media and independent retirement.
- Matched platform artifacts,
  representative packet loss/congestion, 20-Viewer endurance, public-link
  Browser delivery and restricted-NAT success remain in the
  [TODO ledger](./todo.md) and [verification status](./verification-status.md).
  Browser/OS suspension remains a physical limit, not a keepalive promise.
- Windows Native Host, Native embedded-SFU and Browser-to-Client fanout pass the
  current combined profile, pause/recovery and closure checks. Pure Browser
  reuse was then tested separately: late-join recovery works, but legacy fanout
  fails independent quality and sender accounting; standard transforms reject
  cross-source frames. The experiment adds no product path. Normal Browser
  senders and optional Client fanout remain the supported composition.

## Release Acceptance

The phase requires matching current Web/Server/Client/capture artifacts and the
remaining media acceptance before one owner-accepted integration. The first
production move also needs an active-session check, accepted share interruption,
released old UDP listeners, and verified unit/environment/proxy/service recovery.
Restoring only an application symlink cannot roll back that protocol and
infrastructure transaction. No deployment or current-platform acceptance is
claimed by these source documents.
