# Media Status

`src/client/ui/media-status.ts` owns the shared visual projection, demonstrated
by `/__status-preview`. It is not a routing or quality controller. The existing
presentation reducer continues to own playback facts; roster and quality
evidence retain their own authority. Overlay, indicators, notices and title are
consumers, not truth sources.

Frontend controls, names and details share `Tooltip`, following the
[visual language](./visual-language.md). Its native Popover top layer escapes scrolling
containers, with viewport-relative placement. Hover, keyboard focus and touch
hold share one visibility owner; Escape dismisses even a mouse-only hint.
`/__tooltip-preview` shows the catalogue. Playback actions and their local audio
ownership are defined in [presentation lifecycle](../product/presentation-lifecycle.md#playback-ownership);
`/__playback-preview` exercises the actual control bar with generated local media.

## Status Meaning

Keep three questions separate: is the media path available, is this picture
playing, and is this particular stream limited? An available path does not
prove excellent quality. One weak child does not make its parent's received
picture or a healthy sibling unhealthy.

The shared [visual language](./visual-language.md) owns colours, cast, shapes,
panel accents and motion. This document owns the evidence and scope that select
those meanings. Current `StatusDescriptor` tone and progress take precedence
over a reused comic's default; text and pure-visual tooltips retain that context.

## Projection Rules

- Overlay: appears when there is no usable picture, an intentional Host pause,
  or a required user action. Ordinary quality warnings never cover playback.
  Initial connection guidance is not an error even though it occupies the stage.
- Television: one media-status icon sits inside the lower television frame
  (`lr-tv-chin`). Visual mode explains it with the existing comic tooltip;
  text modes expose the specific localized status in the same paper tooltip.
  Both reuse `Tooltip` for hover, keyboard focus, touch hold and viewport
  placement; no native `title` competes with the custom status hint. There is no
  permanent text bubble, additional round lamp, or repeated control-menu caption.
  The Host television describes its local source, not an arbitrary outbound
  child. A confirmed limitation may colour the relevant icon amber while the
  page title still says watching.
- Host couch: each Viewer has one round lamp. Grey means waiting for the share,
  blue means waiting for the media path, green means committed `mediaReady`, and
  amber means a recent receive freeze. The Host's own pawn has no duplicate
  lamp. `deriveParticipantStatus` supplies both the couch and Host overview;
  neither stores another copy of the status.
- Viewer couch: pawns have no round lamps. While awaiting media readiness a
  pawn's body breathes gently; it becomes still when ready. This expresses the
  same roster fact without claiming to know other Viewers' quality.
- Header: the page's connection to the room server. Its control-link comics
  show a Browser and server, not a failed video path. A media-route failure can
  coexist with a healthy server connection, and vice versa.
- Connection notice: signaling recovery may coexist with healthy media. It
  cannot convert proved playback into waiting.
- Notices: necessary coexisting issues and operation feedback use the existing
  pills near the stage; they are not another primary media status. Raw
  PeerConnection errors remain diagnostic observations, not persistent red
  warnings after media recovers. The control menu does not repeat the television
  status or aggregate the first weak outbound edge into a global quality warning.
- Title: keeps the primary activity, with a compact warning for an applicable
  problem. Losing focus alone never means waiting for media.
- Recovery: every projection is recomputed from current facts. A warning requires
  current evidence; an expired or mismatched sample becomes unknown, not healthy
  or disconnected. A ready participant can therefore return to a green readiness
  lamp without claiming that its quality has recovered. No warning latch or
  additional timer is needed.

## Evidence And Integration Boundary

Use WebRTC `connectionState` for transport explanation, not first-frame proof.
`disconnected` may recover; `failed` is terminal for that connection. Closing a
retired connection is not an error in the replacement connection.
`qualityLimitationReason` describes an **outbound** encoder. A relay's sender
warning must never become a warning about its own inbound picture. Low FPS,
resolution or bitrate alone does not prove poor quality; a static screen or a
small source can legitimately need little data. Do not introduce UI thresholds
or a new quality score.

Current roster messages expose committed `mediaReady` to both roles, not a
complete remote quality/failure state. Missing readiness means waiting or
recovery, not confirmed disconnection; departed participants leave the roster.
Viewer receive evidence is shared with its parent and the Host, not with every
other Viewer. No additional remote-quality broadcast is needed.

The Host's amber participant lamp requires an active share, committed readiness,
fresh receive evidence for the current upstream, and a positive
`freezeCountDelta` or `freezeDurationMsDelta`. The existing evidence-expiry path
clears stale warnings. Hidden, paused and other diagnostic-only windows provide
no freeze proof; low FPS, resolution or bitrate is not a substitute.

All `*Delta` metrics describe one observation window and never inherit an older
non-null value. Non-window fields retain the existing details-display cache.
Participant status reads the current evidence directly; it adds no stored
status, timer, threshold or score. Detailed sender/receiver metrics
remain available in connection details and Debug with their original scope.

The preview labels supplied example quality facts for the displayed stream.
Examples do not authorize guessing unavailable production facts.

## References

- [W3C WebRTC connection states](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnectionstate):
  transport lifecycle is distinct from receiving and presenting media.
- [W3C WebRTC statistics](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-qualitylimitationreason):
  native `none`, `bandwidth`, `cpu`, `other` describe outbound limitations.
- [LiveKit connection quality](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/#connection-quality):
  quality and connection events are separate; unknown is an explicit value.
- [LiveKit reconnection](https://docs.livekit.io/intro/basics/connect/#network-changes-and-reconnection):
  transient signaling/media recovery does not always interrupt the picture.

We reuse these distinctions and the existing Piik owners, not a new SDK, scoring
algorithm or transport policy.
