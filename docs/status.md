# Current Status

Last updated: 2026-10-22

This index tracks the current candidate and deployments. Product standards own
behavior, [verification status](./verification-status.md) owns material evidence
limits, and [TODO](./todo.md) owns unfinished work. Git/PRs retain completed history;
release descriptors and operator records identify published artifacts and postflight.

## Accepted Release Contract

- The 2.x baseline uses Browser/server v24, Native control v10, capture v7 and
  SQLite schema 2. App and Site must upgrade together from 1.x; same-major
  compatibility follows [versioning](./standards/versioning.md#public-compatibility-promise).
- Hosted Server defaults to SQLite and indefinite room authority. Explicit
  memory mode and App Local end rooms at process exit. Site access has a
  separate 24-hour idle lifetime within one service run.
- Web Host, Viewer and Browser relay share one P2P-first route controller with
  optional embedded SFU. Camera sharing, room voice, attended keyboard/mouse
  control and local playback settings are accepted features. The
  [product standards](./standards/README.md) own their behavior.

## Accepted Interaction Phase

Authenticated text/reactions, floating and detached chat, room voice, and Windows
screen-audio exclusion are integrated. Room membership can outlive a picture
publication. The [interaction assessment](./research/room-interactions.md) owns
the design and [capture assessment](./research/camera-and-microphone.md) owns
platform limits. Windows native capture and thumbnails use automatic
[HDR-to-SDR conversion](./research/media-fidelity.md#hdr-to-sdr).

## Current Work

The integrated candidate adds room-aware connection presentation, a Host-owned
room voice bitrate ceiling, Host playback with outgoing source-volume control,
and independent App approvals for multiple Sites with one starred startup choice.
Functional acceptance and cross-platform candidate checks have passed; bilingual
release notes are prepared. The owner requested a final review of the latest
website and App guidance on 2026-10-22. Publication awaits that review and explicit
release authorization. The route controller and published wire identifiers are unchanged.

The website uses promotional film A, shared brand motion and illustrated task
guides. Its bilingual documentation center renders repository guides with search.
Separate shared-keyboard/virtual-gamepad experiments remain prototypes.
[TODO](./todo.md) records remaining work and owner deferrals.

## Deployment

| Surface | Current boundary |
| --- | --- |
| Private service | One Go process for Web, authority/signaling, STUN on UDP 3478/3479/3480 and optional SFU on UDP 7882; nginx terminates HTTPS. Room authority persists; participants, routes and media are process-only. |
| [Public Demo](https://demo.piik.tv) | Separate US deployment, open site entry, SQLite room authority, one-hour empty-room retention and P2P-only media. Cloudflare fronts HTTP/WSS; STUN uses DNS-only routing. Caddy and systemd run the origin. |
| `piik.tv` | GitHub Pages behind Cloudflare with HTTPS; source is public and main protection is active. |
| Packages | GitHub owns original App/Server artifacts; Gitee mirrors the same bytes. Windows x64 Server is packaged; Docker images are Linux-only. |

App Local invitations use HTTPS on the selected LAN address while the Host keeps
its loopback entry. Hosted Server can also provide direct HTTPS with a temporary
or supplied certificate. [Configuration](./standards/configuration.md) and
[self-hosting](./operations/self-hosting.md) own setup.

Accepted product changes publish through the authorized release workflow;
standalone website/docs changes deploy without creating App/Server versions.
[Versioning](./standards/versioning.md) owns publication and mirror rules;
[deployment](./deployment.md) owns updates and recovery.

## Media Evidence And Limits

- Native and Browser local encoding pools have bounded H264/VP8 sharing,
  weak-child isolation/recovery, settings and retirement evidence. The
  [Native assessment](./research/native-client-media.md) and
  [Browser assessment](./research/browser-local-encoding-pool.md) retain
  measurements and failed controls.
- Room-voice checks cover normal P2P/SFU flows, Browser/App combinations, UDP
  interruption, picture continuity, independent listening and voice recovery.
  [Verification status](./verification-status.md#device-evidence-boundary)
  distinguishes synthetic inputs and package checks from physical-device coverage.
- The [network laboratory](./research/network-lab.md) covers endpoint pairings,
  recovery, SFU policies and two-App preparation through sequential kernel NAT.
  Magicsock remains excluded after its
  [controlled comparison](./research/nat-traversal.md#integration-cost-and-recovery-controls).
- Browser-controlled recovery, extreme CPU overload and sustained-loss limits
  remain in [encoder research](./research/webrtc-encoder-pool.md). Additional
  codecs, surround delivery and end-to-end HDR remain outside the published phase.
