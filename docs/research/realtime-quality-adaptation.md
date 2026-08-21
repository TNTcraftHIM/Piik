# Realtime Screen-Share Quality Adaptation

- Research date: 2026-08-21
- Scope: realtime game screen sharing in the browser
- Status: implementation input; real-device quality remains unverified

## Finding

Screener should not optimize one quality dimension at the expense of the
others. `maintain-framerate` may preserve motion by reducing resolution until
game UI, maps, subtitles, and text become unreadable; `maintain-resolution`
may instead lower frame rate. Neither preference overrides congestion control.

The user accepted `balanced` as the recommended-profile and advanced default.
A previous iteration temporarily returned those defaults to clarity-first after
field feedback, but that overcorrection is superseded: current source uses
`balanced`, while `maintain-resolution` and `maintain-framerate` remain explicit
choices. Independently, the P2P answer-time whole-profile workaround rested on
confounded evidence and is removed below. These preferences still leave actual
degradation to the browser; Screener observes readback and stats.

The inspected Chromium/libwebrtc source chain makes a screen-only shortcut
especially unsafe to assume for Screener. The JavaScript `motion` hint reaches
`VideoRtpSender` as `kFluid`, which explicitly clears `options.is_screencast`.
`WebRtcVideoSendStream` then configures the encoder as `kRealtimeVideo`, while
`VideoStreamEncoder` only reinterprets `BALANCED` as `MAINTAIN_RESOLUTION` when
its encoder is marked as screen share. The explicit `balanced` preference still
wins the earlier preference-selection branch, but the later screen-only remap
does not follow from this project path. Treat the effective tradeoff as an
implementation detail to verify, not a product guarantee.

An older libwebrtc experiment could detect animated screen content under
`balanced` and cap it to 1280x720. Commit `1d7d0e6e2c50` deleted that experiment
on 2024-05-22; the commit says it had already been disabled for several years
and was not maintained. Current Chromium behavior must therefore not be
described as automatically detecting game motion and forcing a 720p cap.

## Production Degradation Report

On 2026-08-19 production `769de201f7cc` was reported to become severely blurry
while the host repeatedly showed a sustained native
`qualityLimitationReason=bandwidth`, despite one capable viewer on the same LAN
and the UI showing direct P2P. This is a user report, not yet an instrumented
root cause. The probe is read-only, requires three consecutive windows, and
does not change media. Same-LAN/direct does not exclude Wi-Fi loss or queuing,
per-PeerConnection GCC, aggregate host-uplink contention, or browser bandwidth
underestimation; isolated encoder pressure would more commonly report `cpu`.

Only a full Host refresh and re-share was reported to restore immediate
high-definition, fluid video; Viewer refresh did not. With a stable
session-storage `clientId` and reconnect inside the five-second grace, Viewer
reauth reuses its `peerId` and emits `peer-joined`, while `HostPage.startPeer`
retains an already-connected `HostPeer`; a new tab, storage failure, or expired
grace can instead allocate a new peer. The reported Viewer refresh therefore
did not create a new host PeerConnection/GCC generation. Host-page cleanup
disposes every peer,
stops capture, and creates all-new capture, sender, PC, and GCC generations.
This makes a stuck host sender/PC/GCC or shared-capture generation a priority
hypothesis, not a conclusion. A further report that quality may remain low
after the old viewer leaves and a new viewer joins must likewise be tested
against lifecycle evidence rather than assumed.

Use this as the first A+B/C reproduction before quality-aware topology
classification or dual-layer publication:

1. Reproduce one wired LAN/direct viewer first, then Wi-Fi, two/three viewers,
   and forced TURN, using the same high-motion scene for 60 to 90 seconds.
2. In one window record A capture; B actual/target/available outbound bitrate,
   dimensions/FPS, codec, encode cost, loss/RTT/retransmission, selected path,
   limitation, and PC/track generations; and C inbound decode/drop/freeze.
3. First retain capture and every healthy peer while rebuilding only the
   affected `HostPeer`/`connectionId`. Separately compare capture/track
   replacement with PCs retained, then a full Host rebuild; do not combine the
   interventions.
4. For viewer churn and stable-`clientId` reconnect, retain old/new
   `peerId`/`connectionId`, `peer-left`-to-dispose time, active sender count
   inside/outside the five-second grace, old snapshot removal, whether a new PC
   actually exists, capture settings, and new-path BWE/limitation.

A single-edge rebuild passes only if the affected viewer recovers, unaffected
viewers neither migrate nor interrupt, and the host-edge cap holds. Only proven
generation-specific failure can justify a later automatic one-edge recovery
with sustained-bandwidth and healthy-counterpart evidence, cooldown, and a
generation guard. Do not add periodic reconnect, blindly raise a ceiling, or
change the current routing behavior before this gate.

Missing `scaleResolutionDownBy` is not itself a root cause for a single encoding
because its effective default is 1.0. Likewise, the current 3/5/8 Mbps values
are ceilings rather than targets. Raising them cannot repair CPU or bandwidth
limitation and should only follow evidence that the encoder is already pinned
to the ceiling while spare transport capacity remains.

## Confounded Same-Setting Observation

On 2026-08-21 one bounded local Chrome 151 run used exact source `b447ab6`, a
synthetic 1920x1080 at 60 fps capture, and one direct UDP Viewer. After the
initial connection had existed for about 22 seconds, the Host outbound and
Viewer inbound were both 1280x720 at 57 fps and about 7.03 Mbps. The sender
reported `qualityLimitationReason=bandwidth`, despite about 12.59 Mbps of
available outgoing bitrate. Reapplying the identical 1080p60 `balanced` setting
through the real Host control produced 1920x1080 at 55 fps and about 7.11 Mbps
after 5.2 seconds, with the limitation cleared. Both ends reported zero packet
loss and no Viewer freeze.

The route revision, PeerConnection identity, RTP SSRC, RTP stats object, and
track identifier all remained unchanged. This rules out a new route, sender,
or capture generation as the source of that observed transition. It does not
prove visual quality, production behavior, or SFU behavior. Earlier samples in
the same run remained at 640x360 through roughly 20 seconds and reached 720p in
the two-second window immediately before the control action, so continued
stock BWE ramp-up remains a causal confound. No second browser run was made.
The Host control applies same-track capture constraints before updating sender
parameters, so this run also cannot isolate those two standard calls.

Static review does not support the simpler claim that Chromium discards every
pre-negotiation `setParameters()` call. Current libwebrtc stores sender init
parameters while no SSRC exists and transfers them into the negotiated sender.
The observed transition followed the same-setting action, but this single run
cannot attribute it to sender lifecycle or the reapply itself and therefore
does not support an answer-time whole-profile workaround. Current source keeps
the pre-offer sender configuration and serialized explicit source/profile
updates, but an accepted answer itself does not rewrite the profile. A future
workaround requires a controlled, real-capture reproduction that isolates one
intervention from stock BWE ramp-up.

This evidence does not justify an SFU change. The current SFU publisher always
publishes the ordered `q,h` pair when an SFU route is active and configures its
sender after SDK publication. The pinned client publication defaults to
`HIGH`, and Screener also requests a `HIGH` subscriber ceiling immediately
after subscribing. A low SFU receive layer can still be a valid server BWE
choice. Diagnose that case by correlating publisher high-layer stats with the
Viewer's actual inbound layer; do not infer a missing `HIGH` request or change
the application policy without those measurements. LiveKit's pinned client
also contains an SDP start-bitrate mitigation for initial video blur, but
Screener's accepted boundary forbids adding application SDP bitrate hacks.

The same production release is also reported to reduce game-stream frame rate
and consume noticeable Host resources. That report applies only to deployed
`769de201f7cc`, not automatically to the newer diagnostics on `main`. The Web
sender creates one independent `RTCRtpSender` per viewer and has no cross-PC
shared-encoder guarantee; its muted local preview creates no media edge or
server traffic but may still consume compositor/GPU work. Compare the exact
release and current `main` under one fixture, with preview on/off as a separate
binary intervention.

## SFU Profile Lifecycle And Publisher Evidence

A 2026-08-21 report says that selecting fluid preference on an SFU path could
retain low received FPS without reducing the visible resolution. This is not
proof that the preference was ignored: `maintain-framerate` is a degradation
tradeoff rather than an FPS target. It is also not evidence of SFU temporal
downlayering: the current codec is left to automatic negotiation unless the Host
explicitly selects one. Pinned LiveKit server 1.13.5 installs a temporal selector
for VP8, but its H.264/H.265 path installs only the simulcast spatial selector.
With H.264 selected, a `HIGH` ceiling may therefore let BWE choose the
lower-resolution `q` representation, not a lower temporal layer at the same
resolution. When resolution remains stable, classify the case in A/B/C order:
capture FPS, Host publisher outbound FPS and limitation, then Viewer inbound FPS
and decode.

Pinned LiveKit client 2.22.0 keeps three relevant pieces of state. Its public
`LocalVideoTrack.setDegradationPreference()` updates the saved preference used
when a sender is installed; `LocalVideoTrack.publishOptions` drives encoding
recomputation after a track restart; and `LocalTrackPublication.options` is the
input to `republishAllTracks()`. The previous Screener update path configured
the raw sender and replaced only `track.publishOptions`, so a later SDK
republish could read the initial publication preference. The bounded fix uses
the existing publisher operation queue and rollback: call the SDK preference
API to update its saved state, configure/read back the current `q,h` sender as
the final write, then assign one merged option object to both retained
locations. Failure reapplies the previous profile; generation loss cannot
retain the result as current publisher state. This changes no capture
constraint, codec, representation, subscriber layer or route policy and does
not explain an immediate same-publication report.

Host SFU publisher A+B remains a separate observability slice. The smallest
design is one two-second, publication-generation-bound local sampler owned by
`SfuPublisher`: merge its video/audio `LocalTrack` reports, reuse the existing
strict stats parser and accumulator, correlate capture settings from the owned
video track, and emit only while the same publication is active. Activation,
replacement, deactivation and disconnect reset its identity and interval
baseline. `HostSfuRoute` may expose that local snapshot to one Host-only
publisher row; it must not duplicate the shared Host-to-SFU ingress inside each
SFU Viewer card. Viewer inbound remains the per-Viewer C signal. This needs no
wire, server telemetry, global score, selector or new UI framework, but crosses
publisher sampling, route ownership and Host rendering and therefore is not
bundled into the lifecycle repair.

## Codec Preference And Evidence Boundary

RFC 7742 requires WebRTC browsers to implement both VP8 and H.264 Constrained
Baseline, while W3C `setCodecPreferences()` lets the application reorder the
browser's negotiated codec set. The smallest Web policy is automatic by default:
do not override browser/LiveKit negotiation. Advanced settings can explicitly
place every advertised H.264 or VP8 entry first while retaining the complete
repair and fallback list. A missing capability or rejected preference leaves the
browser default unchanged. LiveKit likewise keeps its default codec for
`automatic`, overrides it only for an explicit selection, and retains
`backupCodec=false`; there is no parallel backup-codec publication.

H.264 remains an explicit option because mature cross-device hardware
encode/decode paths may avoid an observed VP8 software-path cost. A controlled
Web comparison also found that forcing H.264 could lower downstream FPS with the
current browser configuration, so the product does not force either codec by
default. Neither observation proves an intrinsic bitrate or efficiency win for
every implementation or scene; actual outbound codec/profile, encoder
implementation and decoded stats remain the result truth. A codec choice also
does not prove shared encode: separate browser PeerConnections may construct
separate encoders, and the SFU still publishes only the configured `q,h`
representations.

The retained follow-up is one direct-Viewer comparison using existing stats,
not a new benchmark: actual codec/profile, encoder implementation, power
efficiency, source/send/receive FPS, encode time and limitation reason. It must
distinguish software fallback from a hardware queue or driver limit before any
H.264-specific policy changes.

Open-source distribution is not itself a patent-license exemption. This Web
change only requests a codec already implemented by the browser/LiveKit path and
ships no H.264 codec binary or new codec dependency, so licensing uncertainty is
not a runtime blocker for the preference. Bundling a codec implementation or
changing the distribution/service model still requires a separate license review.

These reversible standard preferences are gated by focused ordering, fallback and
interoperability tests, not by an exhaustive CPU/GPU/game matrix on one ordinary
PC. Primary specifications, maintained implementation behavior, representative
target-device observations and sanitized production stats drive product choices.
Synthetic local runs may verify negotiation, decode, cleanup and edge bounds;
they must not calibrate capacity, claim performance, or block a standard feature.
Hardware attribution and controlled performance evidence remain required before
making efficiency claims or introducing dynamic codec selection. AV1 remains
outside the default because compression efficiency alone does not establish a
power-efficient WebRTC encoder on the target cohort.

Discord's published Go Live material is a useful architecture comparison, not
a preset to copy. It describes native OS/driver-integrated capture and encoding,
GPU hardware encoding, WebRTC transport, and one codec that the sender and all
current viewers can decode. Discord lists VP8 and H.264 as its broad baseline,
with HEVC and AV1 on selected platforms; its RTC worker routes the sender's
stream rather than requiring one browser PeerConnection per viewer. This is
evidence for a common publication, not proof of one physical encoder object.
Discord also documents a feedback loop that could lock 60 fps output down to
30 fps, accidental keyframes as often as once per second, and the resulting
quality gains from a stable encoder lifetime, explicit keyframe cadence, and
rate-control headroom. These findings support measuring the complete
capture/encoder/congestion loop; they do not make AV1 universally cheaper.

A read-only inspection of the locally installed Oopz 0.87.425 package is
consistent with a native, hardware-first common publication: its Viewer bundle
selects H.264, the package exposes a hardware-acceleration status, and the
inspection found one screen-track publication. It does not prove the runtime
codec/GPU choice or one physical encoder. Components, retained hashes, and the
privacy boundary are owned by
[Native shared-encode sender](./native-shared-encode-sender.md).

## Evidence Before Adaptation

Verified specification facts: the W3C stats model supports the needed
separation but does not produce the product decision itself.
`MediaStreamTrack.getSettings()` supplies the actual
capture dimensions/frame rate. Outbound RTP exposes emitted dimensions/FPS,
byte and retransmission counters, encode time, target bitrate when available,
and the current `qualityLimitationReason`; the selected candidate pair can
expose RTT and available outgoing bitrate. Inbound RTP exposes received
dimensions/FPS, byte/loss/jitter counters, decoded/dropped frames, and freeze
counters when implemented. Stats members may be absent, and cumulative values
must be compared across two samples rather than treated as interval values.

The user-facing loss value should therefore be an RTP interval loss rate, not
the cumulative `packetsLost` counter and not a claim about UDP itself. For one
unchanged RTP stats object, compute `lostDelta / (receivedDelta + lostDelta)`;
an initial sample, reset, negative delta, zero denominator, or absent field is
unknown. `RTCReceivedRtpStreamStats` defines both counters and notes that
`packetsLost` can be negative. `RTCIceCandidateStats.address` is privacy-sensitive
and remote addresses are null by default unless the application supplied the
candidate. Screener may show a selected address locally in collapsed details,
but it must never enter Viewer C, signaling, logs, exports, persistence, route
selection, or NAT/geography inference.

Correlate one time interval and media generation across:

| Evidence | Fields |
| --- | --- |
| A. Host capture | actual width, height, FPS from `getSettings()` |
| B. Host outbound | width/FPS/bitrate, target/available bitrate, interval encode time, limitation reason, path, RTT, loss/retransmission, and derived negotiated codec/profile/parameters plus applicable `scalabilityMode` |
| C. Viewer inbound | width/FPS/bitrate, loss, jitter, interval decode/drop/freeze, corresponding derived codec/profile/parameters/layer, and actual decode behavior |

Product inference from those facts: use the following ordered classification:

| Correlated observation | Likely boundary |
| --- | --- |
| Capture low | capture or constraints |
| Capture high; outbound low; `cpu` | encoder/resource pressure |
| Capture high; outbound low; `bandwidth` | GCC, uplink, or TURN/path pressure |
| Outbound healthy; inbound low | transport or receiver path |
| Inbound healthy; image visibly blurry | bitrate/quantization, codec, or display scaling |

This is a diagnostic classification, not a weighted health score. Missing or
reset evidence remains unknown and rebases the interval.

The smallest implementation sequence is local A+B correlation in one host
sampling tick, followed by a minimal authenticated C report carrying the
receive/decode and derived negotiation signals needed by the topology
predicate. It never carries raw SDP, raw stats, candidate addresses, or raw
device/network identifiers. Server-authoritative path and connection generations
provide authorization and correlation; a general remote stats stream or
telemetry pipeline is unnecessary.

The repository implements the local host A+B foundation: same-tick capture
settings plus one uniquely matched outbound RTP sample, explicit sample/media
identity and adjacent deltas, `remoteId` linkage, and the selected path reached
through that RTP stream's transport. Source replacement blocks sampling and
invalidates in-flight generations.

Authenticated Viewer C is also implemented for each current ordinary or
peer-assisted P2P hop. A viewer sends one nullable, sanitized aggregate window
on the existing two-second stats cadence, bounded to 2 KiB; the server derives
the current viewer, parent, connection, and route revision, while the parent
accepts only the matching local generation and expires it. The report contains
no raw SDP, stats, candidates, addresses, device identifiers, or room identity,
is neither stored nor used for media or routing action, and fails closed for an
SFU-fed root until a real SFU last-hop B/generation exists.

Codec evidence follows only that outbound RTP object's `codecId`, and the
referenced `RTCCodecStats` must use the same transport. The local diagnostics
expose nullable, bounded MIME plus a normalized profile token and an ASCII allowlist of
format parameters: H.264 `profile-level-id`, `packetization-mode`, and
`level-asymmetry-allowed`; VP9 `profile-id`, `max-fr`, and `max-fs`; VP8
`max-fr` and `max-fs`; and AV1 `profile`, `level-idx`, and `tier`. Unknown,
invalid, duplicated, oversized, or non-allowlisted fields such as H.264
parameter sets are discarded. This diagnostic path does not expose or persist
raw `sdpFmtpLine`, SDP, candidates, or complete stats, and it does not infer
specification defaults. Profile tokens remain self-describing, for example
H.264 `profile-level-id=42e01f`; they are not translated into quality,
hardware, support, or capability conclusions.

The same unique outbound object supplies nullable current configured
`scalabilityMode`. Sender parameter readback exposes an applied mode only for
one unambiguous encoding. Current quality settings do not request a mode, so
the requested value remains null and a browser-reported default is not called
a mismatch; multiple encodings remain unknown. Inbound stats provide no current
standard `scalabilityMode` source, so C does not carry a null-only placeholder.
The topology classifier and shared `HIGH+LOW` publication remain unimplemented,
and browser support remains subject to the controlled matrix. Physically
stopping an unused `LOW` is a resource optimization rather than a prerequisite.

Official W3C text checked 2026-08-19 defines names ending in `Id` as stats-object
references. In particular, outbound [`mediaSourceId`](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-mediasourceid)
references the sender's current media source, whose
[`trackIdentifier`](https://www.w3.org/TR/webrtc-stats/#dom-rtcmediasourcestats-trackidentifier)
is the `MediaStreamTrack.id`; RTP [`transportId`](https://www.w3.org/TR/webrtc-stats/#dom-rtcrtpstreamstats-transportid)
references its transport, and that transport's
[`selectedCandidatePairId`](https://www.w3.org/TR/webrtc-stats/#dom-rtctransportstats-selectedcandidatepairid)
references its selected pair. Therefore an ambiguous RTP set or a broken or
cross-transport reference remains unknown; an opaque stats ID is not a safe
substitute for those relationships.

The same specification defines [`codecId`](https://www.w3.org/TR/webrtc-stats/#dom-rtcrtpstreamstats-codecid)
as the RTP stream's reference to `RTCCodecStats`, whose `sdpFmtpLine` contains
format-specific negotiated parameters, and defines outbound
[`scalabilityMode`](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-scalabilitymode)
as present only when a mode is currently configured for that stream.
WebRTC-SVC separately permits post-negotiation `getParameters()` to return a
different configured mode from one explicitly requested. If no mode was
provided, its absence must not be replaced with an implementation-dependent
default. Chromium currently maps its configured per-stream mode into the
outbound stats field; other browser implementations may omit any optional
member, which remains null rather than a capability conclusion.

## Accepted Adaptation Direction

ADR-0007 rejects room-wide worst-link adaptation. Direct/peer paths retain their
independent stock WebRTC congestion control. Each SFU path starts with a `HIGH`
ceiling; the preferred candidate publishes one shared `HIGH+LOW` pair and lets
LiveKit BWE independently select and recover its forwarded layer. If that gate
passes, Screener does not add a media-layer selector. The hard active
representation/layer limit is two, never one per viewer, and stopping idle
`LOW` remains optional.

Correlated sender/viewer evidence and asymmetric entry/recovery windows classify
topology eligibility and diagnostics only. An observed BWE downshift is
`suspect`; sustained evidence confirms `FALLBACK`, removes parent capacity, and
longer recovery plus cooldown can restore that capacity. These application
states do not command ordinary built-in layer changes.

`LOW` itself is conditional: if no qualified hardware/power-efficient media
path exists or the additional representation exceeds the measured
CPU/GPU/game/upload budget, the system preserves `HIGH` and fails visibly for
the weak path. It never intentionally buys weak-path recovery by degrading
healthy paths.

That fail-closed result is exceptional damage containment, not a supported
steady state. A supported sender cohort that cannot reliably provide the one
shared `LOW`, either always-on or on demand, fails the quality gate; its encoding
path must be improved or the cohort explicitly marked unsupported. `HIGH`
remains protected in either case.

A viewer's `LOW` request is advisory and must be authenticated, session-bound,
rate-limited, deduplicated, and corroborated by sender transport/encode and
viewer receive/decode stats. UA or device-model detection is not quality or
relay-capacity evidence. A valid report may affect confirmed topology eligibility; it does not
command built-in WebRTC/LiveKit media adaptation.

The application must not stably retain a confirmed `FALLBACK` parent. For a
later planned or explicit quality fallback it evacuates children under the current generation
before setting `LOW`, preserving the prior state on failure. Built-in SFU BWE
can downshift before application evidence exists; record that as `suspect`, then
evacuate and set capacity zero only after bounded correlated confirmation. The
system cannot promise packet-level preemption of that congestion response, so a
root-with-children gate must measure and bound temporary descendant impact
before default enablement.

An ordinary non-scalable stream cannot yield a second independent quality by
packet forwarding alone. The alternatives are a second representation,
scalable layers, or relay/SFU transcoding. Static review closes current Web P2P
simulcast and Web/LiveKit SVC as cross-path shortcuts, while pinned LiveKit
two-layer simulcast remains the priority bounded runtime candidate. This SVC
gate does not run a browser or select a custom implementation.

WebRTC provides sender-side encoding control but no
`RTCRtpReceiver.setParameters()` or other standard per-RID subscription method.
Consequently, direct P2P receivers cannot explicitly choose `HIGH` versus `LOW`
from one shared simulcast sender, while separate viewer PeerConnections have no
portable shared-encoder contract. This is
`no-go-web-p2p-simulcast-layer-selection`. The unrun sender experiment makes no
claim about per-RID traffic or whether `active=false` releases a physical
encoder, CPU work, or GPU allocation.

Pinned LiveKit 2.22.0 can publish screen-share original plus one lower
simulcast encoding. `RemoteTrackPublication.setVideoQuality(HIGH)` sets a
per-subscriber spatial-quality ceiling. Server 1.13.5 derives requested
spatial/temporal maxima from quality, dimensions and FPS, but applies them
through codec-specific selectors: VP8 has temporal selection, while H.264/H.265
simulcast is spatial-only. When H.264 is selected, the candidate can adapt each
SFU downtrack between `q,h` spatial representations and recover it independently.
Server Dynacast
takes the maximum quality requested across subscribers and subscriber nodes,
then enables every quality at or below that maximum; a `HIGH` root therefore
keeps `LOW` active. That prevents dynamic `LOW` stop while `HIGH` is subscribed,
but idle-layer stop is only an optimization, so this cumulative behavior is not
a product no-go. The Firefox branch's 4x scale, 10 bps, and non-standard
`maxFrameRate` fallback likewise cautions against assuming a clean stopped
layer; it does not invalidate the always-on two-layer candidate.

The next runtime gate must publish exactly `HIGH+LOW` with standard
simulcast/send encodings, leave each zero-descendant SFU leaf's ceiling at
`HIGH`, and first test built-in per-subscriber SFU bandwidth adaptation and
recovery. Start with Dynacast off for a deterministic always-on measurement;
pinned cumulative
Dynacast-on is another always-on form, not a third representation. Prove the
received layer, the two-layer ceiling, unchanged healthy P2P/`HIGH`, and
hardware encoder, game FPS/p1 low, CPU/GPU, interval encode cost, upload, and
per-layer byte budgets. Before default enablement, a separate root-with-children
gate must inject an autonomous downshift, observe `suspect`, evacuate after
bounded confirmation, and limit temporary descendant impact; no confirmed
`FALLBACK` root may retain children. Screener's current publisher always
configures exactly two ordered `q`/`h` encodings whenever an SFU publication is
active, leaves Dynacast at `false`, disables backup-codec publication, and its
subscriber sets a `HIGH` ceiling after subscribing. The publication is not
behind a separate quality flag; its per-subscriber BWE and resource acceptance
gates remain unverified. This is implemented configuration, not browser or
performance evidence. The subscriber also does not attach a
`RemoteTrack`, so SDK `adaptiveStream` is not directly usable without changing
that ownership; built-in SFU bandwidth adaptation does not depend on enabling
that feature. If built-in selection fails the product gates, test explicit
standard subscriber quality selection before manual sender
activation/deactivation.

### Per-Flow Shaping Preflight

The 2026-08-19 Windows preflight stopped before downloading LiveKit, writing a
harness, or starting Chrome. Chrome 151 is available, and the official LiveKit
1.13.5 release provides a checksummed Windows amd64 binary, so obtaining the
pinned server is not the blocker. The workstation has no Docker installation,
no installed WSL distribution, and no Linux `tc`; the current session is also
not elevated. The existing peer-assisted benchmark starts neither LiveKit nor
an SFU quality fixture.

Windows policy-based QoS can match outbound traffic by application or IP
tuple, but this setup has not proved that it can follow one ICE-generated,
ephemeral subscriber downtrack across generation changes or apply an auditable
limit to the local loopback media path. CDP `Network` throttling likewise has no
accepted per-WebRTC-flow contract. Neither mechanism may be used as evidence
that one SFU subscriber was weakened while another stayed healthy.

Resume this gate only on an isolated Linux VM or equivalent host that can put
the publisher, healthy leaf, and weak leaf in separate network namespaces with
separate veth devices. Run the pinned application and LiveKit 1.13.5 without
TURN or media TCP. Before media, prove only the namespace, route, and veth
isolation and the availability of `tc`; the selected ICE tuple does not exist
yet. Use `tbf` for a bounded rate and `netem` only when the case explicitly adds
loss or delay.

The sole browser run has three ordered phases. First establish both leaves
without shaping, identify the selected LiveKit ICE/UDP tuples locally, record
the healthy and weak veth baselines, and require `HIGH/HIGH`. Next attach the
filter and qdisc to only the weak leaf's selected media tuple and direction.
Require filter packet/byte growth, independent TBF overlimit/queue evidence and
the expected weak-path throughput bound before accepting `HIGH/LOW`; a filter
counter alone proves classification, not shaping. The healthy veth counters,
inbound bitrate, dimensions, FPS, and decode progress must remain within the
unshaped baseline envelope. Finally remove the weak qdisc and require recovery
to `HIGH/HIGH` while the healthy leaf remains unchanged.

Retain gate evidence for the publisher's ordered `q`/`f` encodings and
per-layer bytes, both subscribers' actual dimensions, FPS, bytes, codec and
decode progress, correlated A+B/C windows, Host upload and interval encode
cost, and available system CPU/GPU/game proxies. A third layer, an affected
healthy leaf, missing classification or shaping counters, or an
application-issued `LOW` command fails the run. Root migration remains outside
this zero-descendant-leaf gate.

SVC is the third static no-go,
`no-go-web-svc-cross-path-hardware-contract`. WebRTC-SVC configures an outgoing
`RTCRtpSender`; `RTCRtpReceiver` has no matching `setParameters()` experiment or
standard base/enhancement selector. That lets an SFM/SFU selectively forward
layers, but it does not let separate direct/peer PeerConnections consume one
portable shared encoding and independently select layers. Post-negotiation
`getParameters()` can read the currently configured mode when one was
requested, including a browser-selected replacement, but a successful request
does not reveal whether the encoder is hardware or software.

The remaining capability signals cannot enforce the product's no-silent-
software-fallback rule. Media Capabilities defines `powerEfficient` as an
optimal-power judgment left to the user agent and explicitly notes that
software can qualify. RTCStats exposes `encoderImplementation` and
`powerEfficientEncoder` only when hardware exposure is allowed; the latter
should reflect acceleration but may use other information. These fields are
valuable diagnostics, not an affirmative portable hardware contract.

Official implementation surfaces checked 2026-08-19 are deliberately treated
as boundaries, not UA quality rankings:

| Implementation | Static SVC surface |
| --- | --- |
| Chromium/Chrome | Chrome 111 shipped outgoing-track SVC selection; current Blink WebIDL exposes `scalabilityMode` behind its runtime feature. Exact codec/mode and hardware use remain runtime outcomes. |
| Firefox | Current Firefox WebIDL omits `scalabilityMode`; Mozilla's implementation issue remains assigned and behind a preference. |
| Safari/WebKit | Current WebKit WebIDL omits the standard member. LiveKit 2.22.0 carries a Safari-specific legacy encoding branch, but that is an SDK workaround rather than a portable standard setter/readback contract. |

Pinned LiveKit can select layers per SFU subscriber: client 2.22.0 exposes
`RemoteTrackPublication.setVideoQuality()`, and server 1.13.5 maps each
subscriber's quality/dimensions/FPS to maximum spatial/temporal layers on that
subscriber's downtrack. The actual selector remains codec-dependent: VP8 has a
temporal selector, whereas H.264/H.265 simulcast is spatial-only. That useful
SFU contract still does not extend to direct/peer receivers. Screener's current
SFU subscriber calls `setSubscribed(true)` and requests
`setVideoQuality(HIGH)`. `HIGH` is a ceiling, not a guarantee that BWE forwards
the high layer, so the application does not own the actual layer choice.

For this screen-share product the pin has an additional hard mismatch. Client
2.22.0 overwrites SVC screen-share publication to `L1T3`, even when another
mode was supplied: one spatial resolution and three temporal layers. It
therefore supplies no low-resolution base and exceeds the two-active-layer
ceiling. LiveKit also documents that Dynacast can pause only an entire SVC
stream, not individual SVC layers. Changing those contracts would require a
different dependency/native design decision, not a runtime proof of the pinned
path. No SVC harness was written and no Chrome run was performed. None of the
rejected standard paths may bypass PR #28's stock-GCC/RTX stop line.

If built-in LiveKit selection fails the product gates, test explicit standard
subscriber quality selection. If the always-on representation cost itself
exceeds budget, test manual activation/deactivation through standard sender
primitives. Only if these standard forms fail may custom/native dual
representation remain a candidate. Retain the
favorable, testable hypothesis that one low-rate, low-resolution hardware `LOW`
may have no material game impact, but compare `HIGH` against `HIGH+LOW` under
one scene using game FPS/p1 low, CPU, GPU video-encode/copy activity, interval
encode cost, actual encoder identity, upload, and per-layer bytes before
accepting any custom path. Failure preserves `HIGH` and fails the weak path
visibly. It cannot reopen an earlier static no-go or bypass the topology policy
and resource budget.

## Why Offline Encoding Presets Do Not Transfer

[Maruko Toolbox](https://github.com/wzxjohn/marukotoolbox) is an Apache-2.0
GUI around offline video-processing tools. Its x264-style CRF, slow presets,
lookahead, and multi-pass workflows trade encoding time and buffering for file
size and quality. Interactive WebRTC cannot buffer or revisit future frames in
that way. The transferable principle is to treat bitrate, image detail, frame
rate, and encode cost as a joint tradeoff; its concrete offline presets are not
a WebRTC configuration baseline.
The GUI repository is Apache-2.0, while x264 itself uses GPL-2.0 or commercial
licensing; no implementation or preset is copied into Screener.

Discord's published Go Live design reaches the same broad conclusion for
realtime game streaming: bandwidth estimates, frame delivery, image quality,
latency, CPU, and memory conflict and must be balanced. Its native encoder
tuning and hardware integration are not available to a browser-only sender and
must not be presented as settings this project already has.

## Current Policy

The three user-visible profiles remain ceilings rather than promised rates:

| Profile | Capture ceiling | Sender bitrate ceiling |
| --- | --- | ---: |
| 1080p60 | 1920x1080 at 60 fps | 8 Mbps |
| 1080p30 | 1920x1080 at 30 fps | 5 Mbps |
| 720p30 | 1280x720 at 30 fps | 3 Mbps |

The middle profile is an explicit manual 1080p30 ceiling: choosing it trades a
60 fps ceiling for a 1080p capture bound. LiveKit currently uses the same
1080p30 at 5 Mbps screen-share preset, but neither preset guarantees the emitted
resolution, frame rate, or bitrate.

- Initial capture supplies `ideal` and `max` bounds for resolution and frame
  rate; the actual result is read back from `MediaStreamTrack.getSettings()`.
- A live profile change uses `track.applyConstraints()` and updates every
  current sender with `RTCRtpSender.setParameters()`. It does not reopen the
  source picker or renegotiate healthy peer connections.
- The video track keeps `contentHint = "motion"`; recommended profiles and the
  advanced initial value use `balanced`, with explicit `maintain-resolution`
  and `maintain-framerate` choices. None promises an emitted resolution or rate.
- `maxBitrate` and `maxFramerate` are ceilings. They are neither minimums nor
  target guarantees, and the project does not use SDP bitrate hacks.
- The folded “advanced video” panel accepts only 720p/1080p/1440p, integer
  15-60 fps, 2-12 Mbps, the three preferences, and Automatic/H.264/VP8. Codec
  selection is locked during a share and applies to the next one. It exposes no
  audio quality controls and is not renamed in the screen-audio slice. Display capture does
  not standardize channel-count or sample-rate control; the portable audio
  `maxBitrate` field remains only a 128 kbps ceiling. The accepted peer
  exception is a structured Viewer-answer Opus
  `stereo=1;maxaveragebitrate=128000` receive contract, paired with pinned
  LiveKit's explicit high-quality stereo/forceStereo option.
  DTX stays fixed off, RED retains the pinned SDK default, and FEC remains
  browser/SDK negotiation, not a control or custom adaptation algorithm. The
  full boundary is recorded in `docs/research/browser-screen-audio-quality.md`.
- Every sender update derives from `getParameters()`, calls `setParameters()`,
  then reads requested/applied bitrate, frame rate, scale, and preference.
  Rejection or browser rewriting is visible rather than console-only.
- A P2P sender receives its profile before the first offer. Explicit source or
  profile changes use the existing serialized sender-mutation path; accepting
  an answer does not trigger an extra whole-profile write.
- One strict room setting is last-wins for current/future peer relays and the
  configured SFU publisher. Ordinary P2P keeps that state local and does not add
  it to the authenticated wire.
- Pausing sharing disables every track in the current capture stream, producing
  black video and silence without closing the room or media connection.

The deployed implementation deliberately stops at manual bounded controls. It
adds no composite score, periodic adjustment, automatic codec forcing, SDP bitrate
manipulation, or scene detector. Three consecutive samples of one non-`none` native
`qualityLimitationReason` produce one explanatory warning; a reason change or
recovery resets it and never triggers a media action.

A Chrome 151 loopback smoke with one host, three viewers, and synthetic 720p30
video propagated balanced then clarity settings to every participant. Every
baseline active outbound video sender displayed the matching requested/applied
preference, peer-connection fingerprints stayed unchanged, and every viewer's
decoded-frame and foreground `requestVideoFrameCallback` counters grew after
each change. Host media edges peaked at two and relay edges at one. This verifies
controls and continuity, not visual quality, full-resolution performance,
CPU/GPU cost, public networks, or sustained behavior.

## Deliberate Non-Goals

- No canvas pixel-difference detector, machine-learned rate controller, or
  periodic profile switching.
- No copied x264 CRF/preset recipe in the browser path.
- No forced codec order until target hardware measurements identify the actual
  power-efficient encoder.
- No channel-count, sample-rate, codec, arbitrary bitrate, stereo, DTX, RED or
  FEC control, and no inference of actual stereo or sample rate from
  `opus/48000/2`. Screen media uses one route-consistent stereo contract;
  microphone voice, if ever accepted, remains a separate track and policy.
- No promise that all browsers honor `applyConstraints` or degradation
  preference identically.
- No automatic composite quality score or periodic profile controller before
  the controlled production capture identifies a reproducible bottleneck.
- No room-wide minimum-of-viewers target, per-viewer encoder, UA/device quality
  ranking, or silent software SVC fallback.

## Verification Gate

Use the same static UI scene and deterministic high-motion game scene at
720p30, 1080p30, and 1080p60. Correlate A capture, B outbound, and C inbound at
the same interval. Record actual dimensions/FPS/bitrate, limitation reason,
codec, encoder implementation, interval encode/decode cost, drops/freezes,
jitter, RTT, loss/retransmission, selected direct/TURN path, and host CPU/GPU.
A live profile change must preserve peer connection IDs, avoid a second source
prompt, and visibly converge to the requested bounds.

Compute per-frame encode and decode cost from adjacent samples of cumulative
`totalEncodeTime`/`totalDecodeTime` and frame counters. The first sample, a
zero-frame interval, changed stats object, or a counter reset is unknown and
establishes a new baseline. Skip overlapping sampling ticks on the same peer so
reports cannot complete out of order. Do not use a connection-lifetime average
to judge a later overload. Use browser WebRTC diagnostics plus a small run
manifest for time series and percentiles rather than adding a server telemetry
pipeline.

Compare image readability and motion continuity instead of declaring success
from FPS alone. If reproducible evidence later shows a supported preference
oscillates or makes the wrong tradeoff on supported machines, revise that
explicit option before enabling ADR-0007. Its acceptance matrix must prove that built-in
LiveKit BWE independently moves one shaped SFU leaf to the shared `LOW` and back
while a healthy leaf remains `HIGH`, without an application media selector. The
application's asymmetric evidence windows must affect only confirmed topology
eligibility and diagnostics. Each supported sender cohort must provide `LOW`
within measured hardware, game, and upload budgets; idle-layer resource release
is a separate optimization.

## Primary Sources

- [W3C MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC codec preferences](https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-setcodecpreferences)
- [RFC 7742 WebRTC video codec requirements](https://www.rfc-editor.org/rfc/rfc7742.html)
- [Via LA AVC/H.264 licensing program](https://via-la.com/licensing-programs/avc-h-264/)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
- [Chrome 111 WebRTC SVC extension](https://developer.chrome.com/blog/chrome-111-beta)
- [Chromium `RTCRtpEncodingParameters` WebIDL](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/peerconnection/rtc_rtp_encoding_parameters.idl)
- [Firefox `RTCRtpEncodingParameters` WebIDL](https://searchfox.org/firefox-main/source/dom/webidl/RTCRtpParameters.webidl)
- [Firefox WebRTC-SVC implementation status](https://bugzilla.mozilla.org/show_bug.cgi?id=1571470)
- [WebKit `RTCRtpEncodingParameters` WebIDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/RTCRtpEncodingParameters.idl)
- [RFC 6184 H.264 RTP payload format](https://www.rfc-editor.org/rfc/rfc6184.html)
- [RFC 7741 VP8 RTP payload format](https://www.rfc-editor.org/rfc/rfc7741.html)
- [RFC 9628 VP9 RTP payload format](https://www.rfc-editor.org/rfc/rfc9628.html)
- [IANA AV1 media type and format parameters](https://www.iana.org/assignments/media-types/video/AV1)
- [Chromium/libwebrtc video stats origins](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/stats.md)
- [Chromium WebRTC hardware encoder factory](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
- [Chromium WebRTC AV1 hardware feature gate](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/webrtc/webrtc_features.cc)
- [MDN `RTCRtpSender.setParameters()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- [Chromium `motion` to libwebrtc `kFluid` bridge](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/media_stream_video_webrtc_sink.cc)
- [libwebrtc `motion`/`kFluid` sender classification](https://webrtc.googlesource.com/src/+/3b1eab8a69cb5078befb021c5492d3f204a7d6a2/pc/rtp_sender.cc)
- [libwebrtc pre-negotiation sender parameter storage](https://webrtc.googlesource.com/src/+/refs/heads/main/pc/rtp_sender.cc)
- [libwebrtc encoder content-type selection](https://webrtc.googlesource.com/src/+/9caef2a8b88f389af10cee841732c42a98d3d45d/media/engine/webrtc_video_engine.cc)
- [libwebrtc conditional screen-share degradation mapping](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_stream_encoder.cc)
- [libwebrtc adaptation overview](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [libwebrtc per-send-stream encoder construction](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_send_stream_impl.cc)
- [libwebrtc removal of the automatic animation-detection experiment, 2024-05-22](https://webrtc.googlesource.com/src/+/1d7d0e6e2c5002815853be251ce43fe88779ac85)
- [LiveKit screen-share presets](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts)
- [LiveKit degradation defaults](https://github.com/livekit/client-sdk-js/blob/main/src/room/participant/publishUtils.ts)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit client 2.22.0 SVC defaults](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [LiveKit client 2.22.0 screen-share SVC and republish lifecycle](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/LocalParticipant.ts)
- [LiveKit client 2.22.0 start-bitrate negotiation](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/PCTransport.ts)
- [LiveKit client 2.22.0 SVC encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit client 2.22.0 subscriber quality control](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/RemoteTrackPublication.ts)
- [LiveKit server 1.13.5 per-subscriber layer application](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/subscribedtrack.go)
- [LiveKit server 1.13.5 codec-specific layer selectors](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
- [LiveKit client 2.22.0 Dynacast and saved degradation preference](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/LocalVideoTrack.ts)
- [LiveKit server 1.13.5 Dynacast quality aggregation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastqualityvideo.go)
- [LiveKit server 1.13.5 enabled-quality generation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastmanagervideo.go)
- [LiveKit server 1.13.5 release assets and checksums](https://github.com/livekit/livekit/releases/tag/v1.13.5)
- [Microsoft `New-NetQosPolicy`](https://learn.microsoft.com/en-us/powershell/module/netqos/new-netqospolicy)
- [Linux network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)
- [Linux `tc-tbf`](https://man7.org/linux/man-pages/man8/tc-tbf.8.html) and [`tc-netem`](https://man7.org/linux/man-pages/man8/tc-netem.8.html)
- [Jitsi desktop degradation preference](https://github.com/jitsi/lib-jitsi-meet/blob/master/modules/RTC/TraceablePeerConnection.ts)
- [Discord Go Live architecture](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Discord encoder-quality case study](https://discord.com/blog/from-blocky-to-brilliant-improving-video-quality-on-discord-go-live-on-amd-gpus)
- [NVIDIA NVENC application note](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-application-note/index.html)
- [Agora Windows screen sharing](https://doc.shengwang.cn/doc/rtc/windows/basic-features/screen-share)
- [Agora Windows encoding preference](https://doc.shengwang.cn/api-ref/rtc/windows/API/enum_encodingpreference)
- [Oopz help center](https://help.oopz.cn/)
