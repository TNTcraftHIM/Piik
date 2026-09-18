# Camera And Host Microphone

Status: unpublished candidate integrated into the ordinary Host UI.
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

This scope adds no room messages, ports, chat, Viewer microphone or emoji
interactions. The microphone control stays near the capture preview, with the
same action and state in Chinese, English and pure-visual modes.
The adjacent disclosure adjusts microphone input from 0–200% through a smoothed
Web Audio gain. It does not change source audio or Viewer playback volume,
reopen permission, or replace the outgoing track. Its value lasts for the Host
page lifetime; new page loads use 100%. Mute remains a separate direct action.

## Local Review

Use the ordinary development or embedded Server entry described in
[the contributor guide](../../CONTRIBUTING.md).
Start a share from the normal Host page, select a source, then join through its
ordinary invitation in another browser tab. Use headphones for same-device
microphone tests. Browser-emulated mobile layout and synthetic devices do not
establish actual iOS/Android permission, orientation, background or audio behavior.

## Primary Technical References

- [Google Meet audio controls](https://support.google.com/meet/answer/10409699?hl=en)
  keeps microphone settings next to the frequent mute action.
- [OBS audio mixer](https://obsproject.com/kb/audio-mixer-guide) separates source
  volume, mute and monitoring; Piik uses only the controls needed for commentary.

- [Web Audio stream destination](https://www.w3.org/TR/webaudio-1.0/#MediaStreamAudioDestinationNode)
  produces a single audio track from the audio graph.
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
  owns microphone permissions, device lifetime and echo-cancellation constraints.
- [Camera capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
  and [screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
  have separate permissions, capabilities and secure-context requirements.
- [WebRTC track replacement](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack)
  describes reuse of negotiated media slots and when renegotiation is required.
