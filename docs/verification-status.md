# Verification Status

Last updated: 2026-09-05

This file owns only cross-module physical evidence that still changes how the
current product may be described. [Status](./status.md) owns exact source and
production identity; product modules and ADRs own accepted behavior; tests and
Git own completed implementation evidence.

## Route And Network

Still required on representative public networks:

- direct Host-to-Viewer P2P;
- Peer-fed and SFU-fed Browser relay, including a second-level child;
- Host and Viewer TUN/VPN cases;
- relay-ingress failure with subtree retention;
- disconnect and effective-capacity drain;
- two simultaneous rooms with independent SFU publications;
- measured endpoint upload and server ingress/egress during steady routing and
  make-before-break overlap;
- 20-Viewer queue tail, route depth, resource use, and endurance; and
- all-UDP-blocked bounded failure.

The route model, capacity `C=1..3`, first-frame commit, rollback, SFU admission,
and managed-room lifecycle have automated invariant coverage. That coverage does
not prove target-network quality, latency, or interoperability. See
[ADR-0005](./adr/0005-automatic-hybrid-media-routing.md) and the
[routing contract](./product/routing-transport.md).

## Media Quality

Still required:

- real games at 720p30, 1080p30, and 1080p60 on weaker Hosts;
- actual H.264/VP8 encoder paths and sustained CPU/GPU contention on Windows,
  macOS, and Linux;
- mixed P2P/SFU quality and recovery on heterogeneous public networks;
- screen-audio presence, stereo correctness, weak-network behavior, and A/V
  synchronization after SFU RED was disabled; and
- long-running encode/decode cost, thermals, frame delivery, and resource
  admission at the 20-Viewer bound.

Current controlled Browser evidence supports the H.264/VP8 gate, `motion`
content intent, startup-quality workaround, LiveKit-owned SFU adaptation, native
edge convergence, and same-edge connection regeneration invariants. The
2026-08-30 production comparison confirms recovery on a fresh same-route sender,
but does not establish its quality or resource benefit on heterogeneous public
networks. Room 8489 confirms synchronized SFU stalls and representation churn,
but retained logs do not prove whether Dynacast layer disablement, subscriber
forwarding, or keyframe reacquisition owned each freeze. See
[media quality](./product/media-quality.md)
and [realtime quality research](./research/realtime-quality-adaptation.md).

## Browser Lifecycle

Still required on physical Android Chrome and iOS Safari:

- autoplay and user-gesture recovery;
- foreground/background audio;
- foreground video recovery after background or lock;
- page reclamation and BFCache behavior;
- rotation and viewport changes;
- Wi-Fi/cellular migration; and
- survival or controller recovery when the mobile Viewer is a relay.

Desktop Host background/minimized capture also remains unconfirmed under a
current-production real game. Web code cannot promise OS background execution,
page retention, or capture keepalive. See
[presentation and lifecycle](./product/presentation-lifecycle.md) and
[background capture research](./research/browser-background-capture.md).

## Screener Client

The Go Client has unit coverage for persistent Local/Site configuration, LAN
address selection, Browser launch commands, bounded Node supervision, its
loopback port/Origin/Host/session contract, and exact package revision. The same
source cross-builds for Windows amd64, macOS arm64, and Linux amd64.

On Windows, Chrome 151.0.7922.175 completed the built Local page's
fragment access, Host surface, LAN invitation, and clean Client/Node/Browser
shutdown. A separate synthetic run formed a P2P-only Host-plus-three-Viewer tree
with one Browser relay and advancing frames at every Viewer. The Hosted Site
completed v8 loopback `hello`/`ping` after CDP granted `loopback-network`; without
that permission Chrome blocked it as expected.
The current clean-revision Windows package assembled with Node 24.19.0 passed the
package checks recorded for that revision; changing `app/REVISION` made it fail
before opening a listener. Its fresh Site loopback gate closed the Client,
Browser, port, and temporary profile.
The same explicit-target assembly produced a Linux amd64 package that ran its
bundled Node application and loopback runtime on an independent Ubuntu host.
Its full package also created a public link reachable from another network and
closed that link and all local ports on exit. The macOS arm64 output contains
matching Mach-O arm64 Client and Node binaries. Its prior fixed-profile capture
baseline and current variable-profile/audio sidecar compile on the macOS runner;
the latter passes the synthetic hardware-H.264 IDR self-test. The full package
and ScreenCaptureKit video/audio path have not run on a physical Mac. Linux CI
also compiles, probes, packages, starts, and stops its Portal/PipeWire/system-
GStreamer hardware-H.264 adapter; it has not captured on a physical desktop.

Still required are physical second-device LAN playback, first-run LNA prompt,
no-STUN mDNS behavior, macOS package execution, and equivalent non-Windows
capture, audio, firewall, and process-lifecycle tests. Windows native capture, hardware H.264,
one shared Pion source feeding two Chrome transports, STUN candidate gathering,
and a Local Client Host path have bounded physical gates. A remote Pion gate
also received 30 video packets over a selected `srflx`-to-`srflx` pair; its
signaling used a temporary reverse SSH test path. The Windows media gate now
also receives non-zero process/system-loopback Opus on both native edges and
verifies decoded audio energy. The native Host gate passes display and window
source selection and bounded previews; its window arm closes the captured
source, observes the current share end, restarts capture in the same room, and
requires the existing Viewer to receive a different media object plus 30 new
frames. The same product gate changes a live Native Host from default 1080p30
to 1440p30, then changes resolution while paused and resumes the same Viewer
media object through the Host UI. A separate two-Viewer media gate changes
720p30 to 1440p60, then changes to 480p15 while paused and resumes both
connections. Display-source lifecycle is not claimed by that arm.
Native P2P quality evidence and the Browser-mediated native-source SFU happy
path now have bounded gates. A focused unit gate proves that a quality candidate
from a current Native sender edge selects the stock Browser sender, while ordinary
candidates remain Native. Controlled weak-path commit/rollback, production
package integration, SFU recovery and endurance, and physical non-Windows
capture remain unproved.

A five-second headless topology run with 20 Viewers passed the existing route
capacity, no-orphan-publication, quality-propagation, and decoded-frame checks;
it is topology evidence, not a long-running or public-network quality claim.
An isolated LiveKit Server 1.13.6 run also delivered default 1080p native media,
then 15 decoded 854x480 frames after a live source/publisher profile change,
through the existing Browser SFU publisher and completed cleanup.

The one-link gate started a session-scoped public origin from a Windows Client,
confirmed that its ordinary invitation used that origin, and served the Viewer
page plus the existing `/signal` WebSocket upgrade to an independent Linux host.
A native Host then used that public signaling path with an independent Linux
Pion Viewer; repeated runs delivered 30+ H.264 RTP packets over selected direct
paths using a reflexive candidate. Client exit stopped Node and the public link.
This still does not prove decoded Browser media on a physical second device.

On 2026-09-05, a local Windows gate proved a Browser Host feeding a Client-
activated Native Viewer: the Viewer held the v8 control session while Chrome
decoded 621 frames at 1280x720. A separate Pion integration gate proves that the
same inbound source forwards H.264 and Opus RTP to one downstream edge without
re-encoding. A physical mixed-device relay and public-link Browser Viewer remain
open.

On 2026-09-05, a Native preflight showed that Pion's ordinary srflx gatherer
used three temporary local ports for three public STUN destinations. The current
Universal UDP mux adapter instead emitted an srflx observation related to the
Engine's sole media port. A public-link run then delivered 35 H.264 RTP packets
from that Windows Native Host to the independent Linux Pion Viewer over a
selected direct host-to-srflx pair. The active TUN path exposed only one distinct
mapping, so this proves shared-socket discovery and transport, not prediction.

On 2026-09-04, a bounded Windows physical check held a static Notepad source
open beyond seven seconds, produced a requested recovery keyframe from its
retained image, and exited cleanly. The Native Host crash gate also terminated the
Client process and observed the Host return to its start-share control within
the bounded check. These results cover the current Windows build only.

The same clean revision assembled into a self-contained Windows package with a
matching Node runtime, application tree, and native capture process. Chrome 151
passed the package's Local startup gate and both Site loopback-permission arms;
revision mismatch remains fail-closed before a listener starts.

## Interpretation Rules

The current Windows Native candidate additionally passed manual VP8 and Auto-
selected H264 playback, with actual Host/Viewer RTP codec checks across live
presets, paused changes and source replacement. A three-attempt NAT acquisition
has deterministic controller/signaling coverage, not a field success-rate
claim. The completed checks do not resolve the reported Windows 10 monitor
startup or game-specific aspect/window-replacement issues. The matching bundle
must be accepted before any coordinated private-wire deployment.

- Configuration, unit tests, loopback, and synthetic signaling prove invariants,
  not target-network or device behavior.
- An automated/package gate is evidence from its scripted runner; a physical
  gate requires the named target device, network, or desktop environment.
- Missing RTCStats fields are unknown, not zero.
- Requested quality values are ceilings; actual sender/receiver stats are truth.
- A page-lifecycle correction is recovery logic, not a keepalive guarantee.
- Expensive evidence remains applicable only while its protocol, component,
  configuration, environment, and acceptance boundary remain materially the
  same.
