# Room Interaction Assessment

Status: unpublished candidate integrated into the ordinary Host/Viewer UI.
Remaining acceptance belongs to [TODO](../todo.md#now).

## Scope And Ownership

The existing source picker offers Browser, Camera, Window and Screen in that
order, defaulting to Window when an App is detected. Without an App, it shows
only Browser and Camera, defaulting to Browser. Mobile browsers can choose Camera
when screen capture is unavailable.
There is one active picture; capture, replacement, pause and stop retain their
existing Host session and route owners. Camera permission never includes an
implicit microphone request. HTTPS or localhost is required for device capture.

The Host microphone mixes commentary with Browser source audio into one outgoing
audio track through Web Audio. The existing P2P, relay and SFU senders borrow
that stream. Microphone mute preserves the mixed track and source replacement
preserves microphone intent. Denial or unplugging leaves healthy video alone;
retiring the share closes audio resources and discards late permission results.
The Host preview stays muted. Viewers receive the combined sound with their
existing volume control and never request microphone permission.

App native screen/window capture encodes before reaching the Browser. Its
microphone integration is **not implemented** by this Browser mixer. The
candidate disables microphone for that capture path rather than re-encoding a
local native preview. Browser/camera capture opened from the App can use it.
Native source mixing, actual phone capture and real audio-level/echo acceptance
remain prerequisites for declaring broader support.

Small interactions are transient tomato, cartoon poop and heart events during
an active share. They use authenticated room signaling, current participants
and existing connection retirement. They do not create a service, listening
port, data channel, database, participant list or media route. The server derives
the sender identity and validates the target against the current room. There is
no chat, floating text, Viewer microphone, event history or disconnected replay.
Events pass through room authority; they do not acquire media's P2P privacy.

Compatibility uses an optional `reactions` runtime capability, absent by default.
After checking it, a page subscribes on its authenticated signaling connection;
the server sends reaction events only to subscribers. Reconnection rechecks the
capability before resubscribing, without delaying media startup. Existing authentication and
media messages retain their meaning and strict validation.

The sofa footer has one compact reaction button. Its native popover opens on
click and closes after sending, outside click or Escape. A short fill on the
button shows the 1.2-second cooldown; the server enforces the same interval.
Effects travel between current seats, then disappear; hearts rise on arrival.
The shared control caps simultaneous effects, follows reduced-motion preference
and offers local hiding. Missing targets, stopped shares and excess clicks are
discarded without disrupting media.

## Local Review

Use the ordinary development or embedded Server entry described in
[the contributor guide](../../CONTRIBUTING.md). There is no separate interaction
page, preview signaling service or alternative room/transport implementation.
Start a share from the normal Host page, select a source, then join through its
ordinary invitation in another browser tab. Use headphones for same-device
microphone tests. Browser-emulated mobile layout and synthetic devices do not
establish actual iOS/Android permission, orientation, background or audio behavior.

## Primary Technical References

Interaction review (2026-09-19):
[Google Meet](https://support.google.com/meet/answer/13151720?hl=en) uses a
collapsible reaction panel and personal effect settings;
[Zoom](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063323)
distinguishes temporary emoji from persistent hand/status signals. Piik adopts
temporary, optional reactions; its target choice and cooldown are product
decisions, not claims about either reference's timing.

- [Web Audio stream destination](https://www.w3.org/TR/webaudio-1.0/#MediaStreamAudioDestinationNode)
  produces a single audio track from the audio graph.
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
  owns microphone permissions, device lifetime and echo-cancellation constraints.
- [Camera capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
  and [screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
  have separate permissions, capabilities and secure-context requirements.
- [WebRTC track replacement](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack)
  describes reuse of negotiated media slots and when renegotiation is required.
