# Room Voice: Design Assessment

Reviewed 2026-09-24 against public `v1.6.3` (`f423df0a`). This is a proposal,
not an accepted product contract or implementation authorization. The separate
room-interaction experiment supplies candidate lifecycle behavior; it has not
been integrated. [TODO](../todo.md#now) owns the outstanding work and decisions.

## Recommendation

Keep existing room authority and the Host-rooted screen route. Model room voice
as participant-owned microphone publications and independent listening. Chat,
screen playback and voice share admission, not a media lifetime. Do not turn the
screen tree into a conference graph or introduce another room/session store.

There is no equally small solution that simultaneously promises all 21 members
can talk, preserves every P2P-only deployment, and supplies conference-grade
connectivity. Choose the first voice scope before implementing its transport.
For the next technical experiment, assess a small direct group and audio
recapture isolation first. Four total voice participants is a useful test size,
**not an accepted product limit or a demonstrated performance guarantee**.
If full-room voice is required initially, assess a mature conference SFU before
building a mesh intended to grow into one.

## Current Owners And Actual Gaps

| Current owner | Verified behavior | Consequence for voice |
| --- | --- | --- |
| Room store and authenticated signaling | Room admission, participant identity, grant revocation and session replacement | Extend this authority; no voice login or second membership store |
| `HostAudio` in `src/client/media/host-audio.ts` | Source and microphone mixed into one share-scoped track | This is commentary; it cannot supply independent conversation |
| `internal/app/nativehost/audio_mix.go` | Native source/mic PCM share one mixer and output clock | Keep source audio here; avoid duplicating the Host mic across outputs |
| `src/client/media/viewer-audio.ts` | Audio follows the picture's play/pause/mute state | Room speech needs its own playback owner |
| Screen controller and media edges | One Host source, one upstream per Viewer, bounded screen-copy capacity | Voice must not borrow screen generations, first-video-frame proof or copy slots |
| Embedded SFU admission/media | One committed room publication, video-required metadata, share-scoped resource identity | Multiple audio-only publishers need a new capability, not another flag |

The SFU constraints are explicit in `validPublicationMedia` in
`internal/server/sfu/media.go`, `ResourceFence` and `CommitPublication` in
`internal/server/sfu/admission.go`, and the Host/Viewer dispatch in
`internal/server/signal/router_sfu_signal.go`.
[ADR-0013](../adr/0013-embedded-node-local-media.md) embeds Pion/LiveKit components;
it does not embed LiveKit's complete room service.

The interaction candidate separates a retained Host room session from screen
publication. That is a useful foundation, not permission to allocate rooms on
page visit. Preserve the accepted entry: first share creates the room and an
existing room can resume. Retaining opted-in interaction after stopping media is
the candidate lifecycle, not published behavior. A separate voice-only
room-creation flow would be another product decision.

## Transport Choice

| Approach | Benefit | Cost and boundary |
| --- | --- | --- |
| Small direct voice mesh | Keeps media P2P and does not require a reachable central media server | Each sender sends to every listener; needs a total voice-member bound, separate resource accounting and real NAT/device tests |
| Mature multi-publisher SFU | Each speaker uploads once; suitable direction for full-room voice | New publication/subscription integration and central-media availability/privacy decision |
| Host forwarding or mixing hub | Fewer peer relationships | Reintroduces Host dependency, forwarding/mixing and echo ownership; unsuitable for Host-independent conversation |
| Custom voice relay tree or automatic mesh/SFU switching | Potentially combines deployment options | Adds another routing/recovery problem; outside the first scope |

For a full bidirectional mesh, `N` participants need `N*(N-1)/2` pair connections
and up to `N-1` microphone copies per sender: 21 people means 210 pairs and 20
copies; four means six pairs and three copies. These are topology counts, not
bandwidth or CPU measurements. Limiting speakers alone does not bound sender
upload: one speaker and 20 listeners still need 20 copies. The screen's existing
`C=1..3` limit must retain its meaning; any independent voice budget needs explicit
acceptance and combined-load measurement.

Two SFU implementations deserve a bounded comparison: a complete mature room
engine, or a narrow participant-audio adapter around existing media components.
The former adds deployment and potentially competing session ownership; the
latter leaves Piik responsible for admission, subscriptions, recovery and cleanup.
Do not describe the adapter as mature conference behavior merely because its
forwarder uses mature libraries. LiveKit's
[room/participant/track model](https://docs.livekit.io/intro/basics/rooms-participants-tracks/)
and [SFU architecture](https://docs.livekit.io/reference/internals/livekit-sfu/)
show the layers involved.

Select one topology for the first capability. Jitsi's
[two-party P2P design](https://jitsi.org/blog/p2p4121/) retains its bridge connection
and changes transport when group size changes: useful evidence that a hybrid
mode has real lifecycle cost. It is not a reason to copy that complexity here.

Deployment is part of this decision. Demo and App Local/public-link modes are
P2P-only today. Public-link tunneling carries HTTP/WebSocket control traffic,
not a public SFU media endpoint. Existing STUN is not TURN, and existing embedded
UDP media does not provide media TCP/TLS. A full conference engine's
[connectivity options](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
are not inherited by importing its library. This proposal enables no new service
or port and does not change Demo configuration.

## Proposed Responsibility Boundaries

```text
Existing room authority and authenticated signaling
  +-- screen publication -> existing P2P/SFU screen route -> picture/source sound
  +-- interaction events -> bounded chat/reactions
  +-- voice admission -> participant microphone -> selected voice transport
                                               -> independent voice playback
```

These are responsibility boundaries, not a request for a generic media framework
or one new service per line. Keep the first implementation cohesive:

| Responsibility | Owns | Does not own |
| --- | --- | --- |
| Room authority | Who belongs, who may publish/listen, bounds and retirement | OS microphone permission or local volume |
| Participant voice session | Explicit join intent, current admitted publication/subscriptions and their transport lifetime | Screen routes, share generation or a second reconnect policy |
| Microphone input | One acquisition, device choice, local mute, replacement and disposal | Remote permission to turn capture on |
| Voice playback | Received tracks, local volume/person mute, output capability and autoplay recovery | The video's pause/mute state or remote speaking permission |

Do not attach room speech to a screen peer merely to reduce connection count:
screen parent replacement and share retirement have different lifetimes. The
selected voice transport owns its connections and counts them explicitly.

Prefer a Browser-owned room microphone for both roles, including a Host using
App screen capture. This reuses platform speech processing and avoids a second
native voice service. Reuse existing device-selection semantics, not native
device identifiers. Browser microphone acquisition requires a secure context;
plain HTTP LAN pages and unsupported browsers must have truthful capability
presentation. App detection alone does not establish microphone availability.
See the [capture specification](https://www.w3.org/TR/mediacapture-streams/).
Browser voice also does not inherit the native Pion path's port mapping, NAT
assistance or native media fallback just because an App is attached. Measure
voice reachability independently; a working screen path does not prove it.

Room voice and source sound need different audio treatment. Voice uses the
platform's speech/AEC facilities; music/game sound keeps its fidelity settings.
Do not force both through the existing source-audio Opus profile or write a new
voice codec, AEC, PCM subtraction routine or virtual-audio driver.

## Consent, Lifecycle And Presentation

Proposed first permission model: admitted members may explicitly join voice and
then unmute themselves; existing room removal remains the authority boundary.
Start with a closed microphone. Joining may unlock playback, but only explicit
unmute requests input permission. If Host-only speaking approval is required,
specify it before adding a moderation UI. No remote action may start a microphone;
LiveKit also disables [remote unmute by default](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/).

| Event | Proposed behavior |
| --- | --- |
| Share start/stop/pause, source or quality change | Voice stays independent |
| Local mic mute | Silence that publication without leaving voice; retain explicit device intent |
| Local person mute or voice volume | Change local listening only; picture volume remains separate |
| Leave voice | Release mic and voice media, remain in room/chat |
| Host leaves page while room service remains | Retire Host voice; other admitted participants may continue |
| App exits in Local/public-link mode | Room service disappears; independent voice cannot outlive its authority |
| Site-mode App media fails | Browser voice may continue while the Site room authority remains |
| Revocation, replacement or room close | Retire affected resources and reject stale completions/signaling |
| Mic permission/device failure | Preserve picture and other voices; show the actual input failure |
| Hidden page or phone interruption | Visibility alone is not leave/mute; report actual suspension/device loss |

Transient signaling loss is not automatically a media failure or a grant
revocation. Current `presence.go` and `route.Controller.DisconnectSession`
distinguish disconnected sessions from confirmed departure; Viewers have bounded
membership grace. Voice must consume that authority owner's transitions, with no
parallel grace timer or indefinite stale-session publication. Before implementation,
define and test the Host case, reservation retention, reconnect re-admission and
revocation during an outage. Do not extrapolate Viewer grace to a Host or reuse
an old session ID as current authority. This is a design gate, not a claim that
screen recovery already implements voice recovery.

One input owner prevents duplicate captures. Retire late permission results after
leave; prepare a replacement device before releasing a healthy old input; keep a
failed explicit selection visible rather than silently choosing another mic.
Repeated mute/join/leave must converge without a second saved effective-state flag.
Ordinary publication mute need not renegotiate every time; mature systems
[distinguish mute, unpublish and unsubscribe](https://docs.livekit.io/intro/basics/rooms-participants-tracks/tracks/).

Use the existing participants/sofa and room actions, not a conference grid.
First controls: join/leave voice, mic toggle and input choice/check, independent
voice volume, and local person mute in the participant menu. Keep source-sound
settings with the picture. Default to system output; show output selection only
where supported. Do not add deafen, global push-to-talk or a permission-role matrix
until their need and restoration behavior are established.

Display local intent, authorized membership, transport readiness and actual
playback separately. A speaking pulse follows observed audio activity, not a
connected flag or UUID animation seed. Catch blocked playback, including tracks
arriving after joining, and offer an explicit enable-audio action; compare
[LiveKit's autoplay handling](https://docs.livekit.io/reference/components/react/component/startaudio/).
Mobile lock-screen calling remains unproven; platform suspension is not fixed by
extra timers. See [browser lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

## Audio Isolation Is A Prerequisite

Whole-system loopback records received room speech played on the captured output
endpoint. That speech can then be sent back through screen audio. Headphones
remove an acoustic path, not this digital recapture; microphone AEC does not clean
the separate source-audio track. This matters even if only the Host shares a screen.

Windows exposes narrower process-tree capture and process exclusion. Current
Piik includes the selected process tree for window sound or captures the output
endpoint for system sound; it does not implement process exclusion. Excluding
the browser that plays Piik voice could also exclude intended browser content.
Test actual process ownership and output routing rather than assuming a window
selection isolates sound. See Microsoft's
[loopback description](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
and [process-capture sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

Browser `restrictOwnAudio` is relevant; `suppressLocalAudioPlayback` has a different
purpose. Chrome documents the former as excluding audio originating from the
capturing document when system audio is captured. Check support, applied settings
and decoded output on supported platforms; a hint is not cross-browser proof.
See the [Screen Capture specification](https://www.w3.org/TR/screen-capture/)
and [Chrome's implementation announcement](https://developer.chrome.com/blog/chrome-141-beta).

Verify source sound and incoming voices using distinguishable signals. Cover
native window/system capture, browser tab/window/system capture, source changes,
same-browser content and output-device changes. Where isolation cannot be
established, a supported combination or explicit feature limitation must be
chosen before release. Never silently discard source sound or promise that a
headphone hint solves it.

## Compatibility, Trust And Bounds

The Host microphone must have one distribution path. Sending it in both existing
commentary and independent voice causes duplicates and defeats individual mute.
Moving it exclusively to voice can make older/non-participating Viewers lose
commentary. Choose an explicit room capability/participation boundary or a
coordinated major-version transition; do not ship a silent behavior change.
The [versioning owner](../standards/versioning.md) governs that choice. This
assessment does not select a release number or authorize removal of native mic.
Once that boundary is selected, define the handoff before coding: retire the old
microphone distribution before enabling the new one, and test failure/cancellation
without silently losing commentary for Viewers who cannot receive room voice.

Browser-first capture can avoid new native voice commands, but does not make
room signaling automatically compatible. Trace strict readers in both directions;
advertise support before new messages. Keep stable peer identity, authenticated
session, grant and media connection identity distinct. Reuse an existing identity
only when its lifetime matches; do not add a room-wide epoch for convenience.

Bind signaling to current authenticated participants and exact publication/peer
resources; bound memberships, publications, subscriptions, candidates and message
rates before allocation. Leave/revoke must release actual resources before their
slots become reusable. No audio through chat events or durable voice recordings.

P2P revocation has an enforcement limit: the server can refuse signaling and
conforming endpoints can stop capture/drop tracks, but it cannot intercept media
between two modified peers. An SFU can enforce its own forwarding removal. Do not
promise identical server-enforced muting across these models, or hide the central
server's media access under the existing P2P privacy label.

## Implementation Sequence And Acceptance

1. Reconcile the isolated interaction candidate with current main and accept its
   room/picture separation on its own. Preserve the existing staged work; do not
   merge an old branch wholesale. Voice need not block chat/UI acceptance.
2. Select total voice membership, deployment coverage, speaking policy and the
   commentary/compatibility boundary. Record accepted changes in the existing
   product owners and an ADR only when architectural decisions are accepted.
3. Run an isolated transport/audio-isolation experiment before shipping UI.
   Measure screen plus voice CPU, upload, number of connections, audible latency,
   NAT failure, echo and cleanup. Use one topology; stop if the required scope
   implies a custom conference engine or unsupported audio isolation.
4. Implement one vertical slice through the owners above: explicit join, muted
   input, unmute, remote audio, local mute and leave. Then expand participants and
   exact authority teardown. Reuse existing controls, status/comic meanings and
   diagnostic export; avoid separate feature-local rules.
5. Accept faults as well as the happy path: permission resolves after leave,
   device switch fails, source changes, autoplay is blocked, signaling drops
   during healthy audio, reconnect races revoke/replacement, Host leaves, service
   exits, mobile suspends, and repeated join/leave leaks no resources. Test quiet
   and muted participants without video-frame admission requirements. Include
   supported old/new endpoints and Chinese/English/visual presentation.

Transport experiments must report measured limits rather than treating a
successful localhost call as public-network or mobile acceptance. This planning
round ran no voice, acoustic-echo or device-performance experiment.

## Independent Fidelity Work

Stereo acceptance can proceed separately: distinguishable left/right signals
through Browser, Native, relay and SFU, with microphone mixing and source changes.
The released native answer fix negotiates receive-side stereo; SDP alone does not
prove decoded channel separation. Opus negotiation follows
[RFC 7587 section 7](https://www.rfc-editor.org/rfc/rfc7587.html#section-7).
Do not add surround channels as a prerequisite for voice.

For [HDR issue #420](https://github.com/TNTcraftHIM/Piik/issues/420), investigate
correct SDR output first: preserve HDR range during native capture, then use
platform tone/gamut mapping before the existing SDR encoder. Windows documents
[floating-point capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
and a [tone-map effect](https://learn.microsoft.com/en-us/windows/win32/direct2d/hdr-tone-map-effect).
Validate mixed SDR/HDR content, highlights, SDR reference output and display-mode
changes. Already-clipped browser input cannot be restored downstream. Full HDR
transport/metadata, surround sound, recording and transcription remain outside
this proposal.
