# Camera And Host Microphone

Status: integrated into the ordinary Host UI and accepted for release.
Remaining device coverage belongs to [TODO](../todo.md#awaiting-device-or-reporter-evidence).

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

App native screen/window capture mixes selected-device microphone PCM with source
audio before the existing Opus encoder. Windows uses WASAPI, macOS uses
AVAudioEngine and Linux uses PulseAudio/PipeWire through GStreamer. Platform
converters supply 48 kHz stereo PCM; one 20 ms output clock consumes each input
once, with a bounded queue and silence for missing samples. This bounds backlog;
it does not replace platform resampling or establish long-term clock-drift and
echo-cancellation performance.

New App/page pairs opt into a stable mixed audio track from share startup, even
with source sound disabled. Opening or muting the microphone and replacing the
source preserve that track, encoder, preview and route owners. Source sound and
microphone availability remain separate reported facts. Old Apps/pages retain
the existing capture contract through capability negotiation; microphone capture
starts only after an explicit action. Permission waiting is cancellable and does
not hold the control reader. Device loss retires only that audio input.

Windows native capture and the App-to-Viewer path have local acceptance evidence.
macOS/Linux microphone compilation is checked by native-platform packaging.
Real audio-level/echo checks, macOS/Linux device acceptance and actual phone
capture remain physical evidence limits; synthetic tests do not establish
those results. The owner authorized release with those limits retained. The
Host preview remains muted on every path.

This scope adds no room messages, ports, chat, Viewer microphone or emoji
interactions. Microphone, pause, source replacement and stop share one action
row below the picture, outside the playback controls and television status.
Their order and meaning stay the same in Chinese, English and pure-visual modes.
Source-sound details describe the raw capture input; microphone intent and
Viewer playback volume are separate facts. Pausing the share silences the mixed
output and temporarily disables microphone toggling without clearing its intent.
Sharing settings open from the action dock. Picture presets/parameters and sound
form separate groups, with microphone device/input gain under sound and a further
disclosure for connection/codec options. The panel expands in page flow, pushing
the couch down; video presets remain available before capture starts.
The dock keeps only its frequent mute action; camera selection stays with source selection.
The default follows the system; an explicit selection never silently falls back
to another device. Browser capture and native capture keep separate device IDs
for the page lifetime. Enumeration does not request permission. Browser labels
may appear only after the first grant; refresh and device-change events update
the list. A missing selected device stays visible as unavailable.
Switching an active microphone prepares the new input before retiring the old
one; failure leaves the old input running. The mixed output stays unchanged.
Camera selection belongs in the existing Camera tab and uses the same named
thumbnail cards as window/display selection. Entering the
Camera tab may request camera permission for local previews; it never requests
microphone access or starts a room. Preview inputs open serially and stop after
one bounded thumbnail. Leaving the tab or cancelling the picker stops owned
inputs and discards late permission results. Images last only for that picker.
While already sharing a camera, preview borrows the current video frame and
lists other devices without opening them, because some phones retire an active
camera when another opens. Missing thumbnails do not disable a known device.
The Host's existing source-replacement operation
owns the old camera's automatic end event until the pending capture settles;
failure with an already-ended old camera retires sharing normally. This does
not suppress a user's screen-share Stop action. Some phones require releasing
the old camera before opening another; seamless switching is not established.

The input-volume control adjusts microphone input from
0–200% through smoothed input gain. It does not change source audio or Viewer playback volume,
reopen permission, or replace the outgoing track. Its value lasts for the Host
page lifetime; new page loads use 100%. Mute remains a separate direct action.
Volume settings use the existing settings disclosure without covering the picture
or participants. The microphone-volume comic describes outgoing
commentary, separately from the Viewer's local listening volume.

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
- [WASAPI shared capture](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-initialize),
  [AVAudioConverter resampling](https://developer.apple.com/documentation/technotes/tn3136-avaudioconverter-performing-sample-rate-conversions)
  and [GStreamer audio mixing](https://gstreamer.freedesktop.org/documentation/audiomixer/audiomixer.html)
  define the platform conversion and PCM mixing boundaries.
