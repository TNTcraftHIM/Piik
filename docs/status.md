# Current Status

Last updated: 2026-10-23

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) summarizes material evidence limits,
and Git/PRs own completed history.

## Accepted Release Contract

- The 2.0 release boundary uses Browser/server v24, Native control v10 and
  capture v7. App and Site must upgrade together; 1.x cannot participate in a
  2.0 session. SQLite schema 2 is unchanged.
  [Versioning](./standards/versioning.md#public-compatibility-promise) owns
  compatibility between published Web/App/Server versions.
- Hosted Server defaults to SQLite schema 2. Room authority has no inactivity
  expiry by default; replacement/deletion or grant rotation/revocation ends the
  corresponding authority. Explicit memory mode and App Local end rooms at
  process exit. Site access retains its separate 24-hour idle lifetime within
  one service run; service restart requires site-password entry again.
- Browser/App entry lifecycle and current-edge reconnect ownership repairs
  are implemented. Browser node-local pooling and detailed local Debug export
  remain part of the accepted media surface. Product modules own their behavior;
  [configuration](./standards/configuration.md#diagnostics) owns Debug activation,
  report contents and disclosure.
- Shared feedback composition is implemented: generic loading uses the wink
  mascot, concrete media waits use their owning comic, and waiting captions are
  secondary to literal status. Website reduced-motion preference and player
  tooltip placement follow the same presentation owners.
- Camera sharing and room voice are accepted product features. Source audio
  follows the picture; room voice owns conversation microphones under the
  same route controller. Optional Host commentary belongs to the share's audio
  and has separate activation; its restored UI still needs scoped acceptance.
  Device selection and sharing settings keep their owners. The
  [capture assessment](./research/camera-and-microphone.md) owns platform behavior
  and platform limits.

Website delivery includes a bilingual reader documentation center generated
from the repository's guides alongside the homepage, with search and detailed
troubleshooting separate from the homepage FAQ.

## Accepted Interaction Phase

The accepted [room-interaction design](./research/room-interactions.md) includes
the verified media repairs. It adds authenticated text and reactions
over existing signaling, with optional local chat overlay and a shared floating
panel. Its opted-in room session can outlive a publication; capture, quality and
route owners remain unchanged. Optional Windows screen-audio exclusion uses the
existing source/mixer boundary. Hosted Server
also accepts an optional SFU-only policy through the same route controller.
Windows native capture and thumbnails share automatic HDR-to-SDR conversion.
The [fidelity assessment](./research/media-fidelity.md#hdr-to-sdr) owns its evidence
and the distinction from Browser capture and end-to-end HDR.
Room voice supplies Host and Viewer speech separately from source audio.
Release artifacts and operator deployment records own delivery completion;
[TODO](./todo.md#now) owns remaining work.

## Current Work

The current 2.x release line retains attended keyboard/mouse control, Viewer
playback settings and the interaction window, with the maintenance media and lifecycle
repairs. The accepted maintenance phase preserves the published protocols and
route owners; release artifacts and operator records establish publication and
postflight completion. Room voice integrates normal App/Server/Web, with the same
room graph and serial route operation, separate picture and voice lifetimes, explicit pre-share room creation
and Host-owned room voice activation. Normal Browser checks cover a three-participant Peer
relay and embedded SFU, duplex audio, local-mute isolation, picture replacement,
detached UI and capture retirement. Optional voluntary Peer fanout and local
picture rotation are included; frp uses the documented existing UDP configuration.
Windows x64 Server packaging uses the existing
release inventory; Docker images remain Linux-only.
App Local invitations now use HTTPS on the selected LAN address; the Host keeps
its loopback entry. Hosted Server also supports optional direct HTTPS with a
temporary local certificate or supplied certificate files. Both use the same
room authority and require the browser to accept the certificate.
Channel availability derives from Host membership and uses one
room microphone for Host and Viewers. Local normal-page acceptance covers both
P2P and SFU, independent listening, picture continuity and voice-facet recovery.
Controlled-network voice cases and platform package checks have passed; the
release artifacts and operator records establish publication and deployment.
Shared keyboard/mouse and optional Windows ViGEmBus virtual-gamepad prototypes
use the normal App/Web input and authorization surfaces. Host and Viewers see
granted collaborators on the couch through a share-scoped presence projection.
The Windows adapter
calls the installed driver directly; App packages contain no optional input SDK
or driver. Linux uinput passed
an isolated real-kernel gate; desktop permissions and game recognition remain
unverified. The macOS virtual-HID
implementation needs its Apple entitlement and a macOS build/runtime check.
Co-play and the maintenance changes form one integrated candidate awaiting owner
acceptance; the platform evidence limits above remain explicit.
The website uses the selected bilingual film A with on-demand loading and
shared product playback controls; the final card stays visible after playback.
[TODO](./todo.md) owns unfinished work and explicit deferrals;
release artifacts and operator records own exact delivery results.

2.0 separates numeric media requests from presets and bounded runtime admission,
retains successfully applied quality settings, and lets App serve an approved
Site independently of Local/public room startup. It also adds detached chat on
supporting desktop Browsers. Media, room authority and P2P-first routing keep
their existing owners; [product standards](./standards/README.md) define the
accepted behavior.

Optional coordinated Native UDP preparation augments the existing retry owner.
The [network laboratory](./research/network-lab.md) covers all Browser/App
pairings, recovery, SFU policies and successful two-App preparation through
sequential kernel NAT. These results do not establish a public success rate.
Magicsock remains excluded: its [controlled comparison](./research/nat-traversal.md#integration-cost-and-recovery-controls)
established no additional reachability worth its integration costs.

The [media assessment](./research/native-client-media.md#media-capability-extension-assessment)
owns bounded output and live-control evidence. Additional codecs, surround
delivery and end-to-end HDR remain outside the published phase.

2.0 was published after final acceptance without a separate field beta.
Immutable release artifacts and operator records own exact delivery
and postflight; [TODO](./todo.md#now) owns remaining product work. Hosted room
retention stays indefinite by default. Demo uses one hour without authenticated
participants; the private deployment keeps the default.

## Deployment

Source, package identity, GitHub repository and local worktree paths use Piik.
Runtime code keeps only the Piik wire labels and stored keys.
The immutable release descriptor, runtime `REVISION` and operator deployment
record own exact identity and postflight results.

The existing deployment uses one Go process for Web, room authority/signaling,
Binding-only STUN on UDP 3478/3479/3480 and optional SFU on UDP 7882. nginx owns
HTTPS. Participants, routes and media remain process-only. This private service
is not a public demonstration.

The separate US [public demo](https://demo.piik.tv) is deployed with open site
entry, persistent room authority and P2P-only media. Cloudflare fronts HTTP/WSS
and caches static bundles; STUN uses a separate DNS-only hostname. Caddy owns
origin HTTPS, and the standard systemd service runs the published Server package.
Public DNS,
HTTPS, runtime assets, all three STUN listeners and a bounded browser P2P
sharing/stop check passed; the browser check used synthetic video on one network.
The operator record owns exact identity and postflight evidence.

[TODO](./todo.md) owns unfinished work. The owner declared the first
public release on 2026-09-12. Source is public, main protection is active, and
`piik.tv` runs on GitHub Pages behind Cloudflare with HTTPS. The private service
remains a separate deployment. Release descriptors and GitHub deployment records
identify published artifacts and website revisions.

GitHub owns the original Server and registered App packages. Gitee copies them
without rebuilding; mirror completion requires anonymous checksum verification.
Mirror reads retry complete transfers; ambiguous uploads are reconciled by
inventory before another attempt. Public-repository CI
and native packaging passed. App entry, update links
and bounded two-build interoperability have acceptance evidence. Accepted
product changes publish automatically; standalone website and documentation
changes validate and deploy the website without creating App/Server versions.
GitHub/Gitee release comparison, mirror publishing and PR-sourced notes follow
[versioning](./standards/versioning.md). [Verification status](./verification-status.md#device-evidence-boundary)
summarizes material evidence limits; shared lessons live in
[engineering](./standards/engineering.md).

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
  App fanout and App-exit fallback have bounded physical checks. Two
  independent Native sessions have simultaneous media/retirement evidence.
- The Linux runtime container has non-root/read-only, memory/SQLite, diagnostic
  export, STUN and listener-lifecycle evidence. This does not establish every
  operator's proxy/firewall or public-media configuration.
- The independent Browser producer in ADR-0014 is integrated.
  Bounded H264/VP8 checks cover direct and received-track sharing, weak-child
  isolation/recovery, live/quiet settings, pause, source change and ordinary
  fallback. Its native allocation and complete-frame output replace the earlier
  payload-only Worker path. Fewer full encodes are established; total CPU gains
  depend on codec/hardware. [Browser research](./research/browser-local-encoding-pool.md)
  owns these measurements and failed controls. The owner accepted this scoped
  Browser composition for release; actual deployment identity stays in the
  runtime descriptor.
- Browser-controlled recovery and extreme CPU-overload limits remain in
  [encoder research](./research/webrtc-encoder-pool.md). Windows App and Browser
  are this phase's primary targets; macOS/Linux physical capture remains deferred.
