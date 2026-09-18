# Room Interaction Assessment

- Reviewed: 2026-09-19
- Status: isolated local prototype; production integration awaits UI acceptance
- Current behavior: [rooms/access](../standards/rooms-access.md),
  [routing](../standards/routing-transport.md),
  [media](../standards/media-quality.md) and
  [presentation](../standards/presentation-lifecycle.md)
- Remaining decisions belong to [TODO](../todo.md#now).

## Local Prototype

Run `npm run preview:interactions` and open
`http://127.0.0.1:18961/__interaction-preview`. Join a room, then use the second-tab
link to join as another participant. The first participant is the Host and
chooses one source: screen/window/browser tab, or camera. During a share the Host
can enable a microphone, mixed with source audio into one outgoing track. During
the share, select a seat to send a tomato, cartoon poop or heart. Viewers receive
automatically, with a local mute control and an autoplay-unlock button when
needed. One video element plays both picture and sound; the Host preview stays
muted. Viewers never request microphone/camera permission. Use headphones when
trying two tabs on one device.

The preview has a loopback-only development WebSocket on the same Vite port.
It is not a deployment mode, does not change public protocol versions and is
excluded from production Web builds. Rooms admit one Host plus 20 Viewers;
the preview sends media directly from the Host to each Viewer, with
no STUN/TURN/SFU or public-network/performance guarantee. This is not the accepted
production routing implementation. The Host leaving ends this ephemeral preview
room; Viewers are never promoted automatically. Stop sharing releases devices,
detaches outgoing tracks and disables props. Effects are transient, bounded and
locally hideable, with no history or replay. The local harness keeps its seats
and connections for another capture test; leaving retires them. Production
integration reuses the existing share/session generation owner instead of copying
this test-room lifetime.

Ownership is deliberately small:

- `protocol.ts` owns the typed event catalog and boundary validation.
- `scripts/interaction-room.ts` owns membership, sender identity, admission,
  event limits and room lifetime; the runner mounts it only for this preview.
- `session.ts` owns one socket and retires capture and media on leave/disconnection.
- `source.ts` owns Host capture permissions, source replacement and a Web Audio
  mixer. A retired source stops its devices and rejects late permission results.
  Denied replacement keeps the old source; microphone failure preserves video.
- `media.ts` owns peer connections and borrows the source's tracks. Room connection
  identity rejects stale signaling. Only the Host
  offers send-only slots; Viewers answer receive-only. The server admits device
  announcements only from the Host and signals only between Host–Viewer pairs.
- The page, copy catalog and prop renderer own presentation. Props carry actor,
  target and a typed preset, not coordinates. Adding a preset requires its art
  and localized label, not another synchronization path.

## Mobile Camera Source

Camera capture is a plausible addition to the existing Browser Host source
owner. It produces a normal `MediaStream` through `getUserMedia`; it does not
provide phone screen capture where `getDisplayMedia` is unavailable. The
prototype requests the rear camera preferentially, separately from microphone
permission, and transmits it through the preview Host's fixed video slot.

Production integration should keep one active Host video source and reuse the
current source replacement, quality and route owners. Never silently switch to
camera/microphone capture after screen permission is denied. Label the source
explicitly, close devices on retirement, and verify switching, phone orientation,
backgrounding, permissions and playback on actual iOS/Android devices. HTTPS is
required for mobile device capture; this loopback preview is not remotely
accessible. Browser-emulated mobile layout is not device acceptance.

## Product Fit

The selected scope preserves one Host as the only media source:

| Feature | Ownership and boundary |
| --- | --- |
| Host microphone | Mix commentary with source audio before transmission. Browser and App capture need their respective source integration; no Viewer microphone or independent voice room. |
| Camera sharing | An alternative video source alongside screen/window/tab capture, including on mobile; one active picture at a time. |
| Preset reactions/props | Short room events target current participants. Reuse share authority; no history, uploads, sounds, inventories or separate media route. |

Text chat and floating messages are excluded from this increment. Text could
travel over existing signaling without changing media routes, but always-on
conversation would add presence, retention and privacy decisions. There is no
reason to refactor the room model to retain an unwanted feature.

Keep props brief and local to the sofa, with bounded bursts and a local hide
control. Discard effects for departed targets, stopped shares and disconnected
rooms. Production commentary should reuse the existing Host media, routing and
recovery owners; the preview's direct fanout is only a local test harness.

## Existing Boundaries

The authenticated [signaling server](../../internal/server/signal/server.go)
already knows room membership and sender identity. Its
[session owner](../../internal/server/signal/session.go) has a bounded outgoing
queue. Reactions can reuse that authority without another
service, database or media data channel. They still need typed messages,
participant validation, bounded input/fanout and compatibility review.

The active [Host page](../../src/client/pages/HostPage.tsx) creates its signaling
connection after capture begins and closes it when sharing stops. The server's
Host authentication announces an online source. Production reactions should use
that existing active-share lifetime; do not open the socket early to invent
presence. Old-room events must never replay into a later room or sharing session.
Reaction events pass through the room authority and do not acquire media's
peer-to-peer confidentiality. No new listening port or service is needed for
this direction; public wire compatibility still requires review before integration.

The [Browser audio capture helper](../../src/client/media/audio-capture.ts)
deliberately disables voice processing for screen audio. Microphone capture
needs its own permission, mute and voice-processing intent. Web Audio can mix
Browser audio into one outgoing track, but this does not automatically extend
the App's [native capture boundary](../../internal/app/nativecapture/protocol.go)
or the shared [media transport](../../internal/media/forwarding/transport.go).
Current Browser and native senders expose one audio sender per media edge.
The selected direction is source-side mixing: one outgoing video track and at
most one audio track. The prototype uses the Browser's Web Audio mixer without
local microphone monitoring; mic mute and source replacement keep its output
track alive. Viewers mute the combined audio with one control. The prototype does not
settle production App/native audio integration or microphone/music level tuning;
test real sound levels and clipping before accepting production defaults.

A Host microphone experiment must verify denial and unplugging, capture/source
changes, pause/stop, speaker echo and device changes, and all supported media
paths. A microphone failure should not end healthy video. Screen-audio processing
must continue to preserve music rather than inheriting speech filters.

## Primary Technical References

- [Web Audio: stream destination](https://www.w3.org/TR/webaudio-1.0/#MediaStreamAudioDestinationNode)
  describes producing a single audio track from an audio graph.
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
  owns microphone permissions, device lifecycle and echo-cancellation constraints.
- [Browser camera capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
  and [screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
  document separate capabilities and secure-context requirements.
- [WebRTC track replacement](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack)
  documents when a source can change within an existing negotiated media slot.
