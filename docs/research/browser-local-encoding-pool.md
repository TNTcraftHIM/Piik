# Browser Node-Local Encoding Pool

Reviewed and executed 2026-09-09 on Windows, Chrome 152.0.7977.82.
[ADR-0014](../adr/0014-browser-node-local-encoding-pool.md) owns the selected
design. The observations below belong to that measured baseline;
[status](../status.md) owns current adoption and release state, and
[verification status](../verification-status.md) owns remaining physical limits.

## Result And Scope

An independent local WebRTC producer can supply compatible direct children
without making one real child the encoding authority. Each child's existing
connection retains RTP, ICE, congestion control and recovery. Different weak
demands can require separate local producers; healthy siblings keep their
original producer. There is no ancestor cache or application quality ladder.

The selected Chromium encoded-stream path copies the producer's payload, type
and exposed codec metadata, assigning the outgoing carrier's RTP timestamp.
Native scaling on a source clone bootstraps each carrier. After the first real
producer frame, its existing sender switches to a CPU-resident 16x16 Canvas
track driven by producer events. It does not first warm another full-size
encoder, and there is no independent carrier timer. Unsupported APIs and failed
pooling retain ordinary senders.
The original capture/received track is never replaced by a carrier.

This is one full encode plus small carrier encodes for compatible children,
not literally one encoder or one Encode call. Each producer also has a local
connection and receiver decoder. Browser relay reuses its local encoded output
across direct children; it still decodes/re-encodes its received source.

## Why The Earlier Implementations Were Removed

- Borrowing a real child's encoder couples siblings to that child's adaptation.
  It does not test an independent producer.
- Quiet placeholders omit native sender accounting and do not provide a usable
  clock. They are not a zero-cost product implementation.
- Standard own-frame payload replacement can transmit real pictures, but retains
  carrier metadata. At 1080p, VP8 intermittently stalled. Extra carrier key-type
  rendezvous and a canvas clock did not establish reliable parity.
- The selected complete-frame API removes that Worker and key-type rendezvous.
  It preserves exposed metadata, not every internal native capture timestamp;
  played-audio and source-age measurements remain necessary.
- Starting two full ordinary encoders before pooling caused a transient extra
  encoding load and, in one run, 500-700 ms early played-audio lag. Starting the
  tiny carrier immediately removed that unnecessary warmup; the next VP8
  1080p check measured offsets between about -64 and +42 ms.
- Hand-subtracting audio/repair from available BWE introduced another inaccurate
  allocator. The pool now uses the existing sender's native video payload
  target, bounded by Host settings. This is not the same unit conversion as
  Native's measured RTP-to-codec budget, which remains necessary.
- Scaling the full received H264 track for each tiny carrier retained substantial
  processing cost. Replacing that input with a CPU-resident Canvas, driven only
  by producer frames, reduced the six-second relay fixture from 7.27 to 5.36
  CPU-seconds; ordinary relay used 5.39. Summed relay encoding time fell from
  about 4,840 to 1,177 ms (ordinary: 2,268 ms). This removes the extra cost rather
  than claiming a total CPU win. Picture-age p95 was 124/161 ms versus 43/49 ms
  for ordinary relay; no additional timing controller was added to chase it.
- A waiting member must replan when a shared producer outgrows its allocation.
  An already-available better healthy output must not require its old encoder
  to recover first. Both conditions produced failed startup checks; the fixes
  reuse membership and the existing output comparison, without a new timer.

The replaced experiments and selected original measurements remain recoverable
at Git checkpoint `4e3de79`; runtime code and the runner keep only the selected
implementation. Failed cases are evidence, not acceptance passes.

## Current Executed Evidence

The [selected summaries](./data/browser-local-pool.json) retain exact fixture
hashes, raw artifact names, delivered frames, source ages and limitations.
The actual `HostPeer` and pool are bundled into the fixture; it does not copy
their implementation. All workloads ran serially.

| Actual product path | Observed result |
| --- | --- |
| VP8, 1080p30, 400 kbps constrained A | A reached 480x270 and returned to 1080p; B kept 1080p. A decoded 195 frames in 14 constrained seconds and 981 in 40 recovery seconds. |
| H264, same constraint | A reached 960x540 and returned to 1080p; B kept 1080p. A decoded 366 and 1,165 frames in the corresponding windows. |
| Both codecs, live settings | 720p60, quiet-source 480p30, pause, resume and new source delivered the requested ceilings without replacing the outgoing connections. |
| Producer failure | Both codecs returned to ordinary sending on the existing connections; VP8 delivered 181 frames per child in six seconds, with no retained groups. |
| VP8, late child | Both children shared the existing producer and decoded fresh 1080p, without backward source IDs. |
| VP8, received-track relay | One local producer supplied two children at 1080p; source-age p95 was about 71/122 ms, with played audio present. |
| Actual hidden page | Native fake source continued at its available 20 fps; both receivers decoded 200 frames in ten seconds. The first run had a temporary profile-cleanup failure, recorded separately from media behavior. |

The source generates moving bars and a frame-ID barcode. It is not a game
perceptual-quality benchmark. Played audio is recaptured from the receiving
video element; this is element-level synchronization, not physical speakers
or display scanout. Hidden-page checks use a native fake source because a
background canvas timer is itself throttled. They establish neither real-game
60 fps endurance nor background audio timing.

The constrained runs use a test-only forward UDP bridge with about 250 ms
maximum queued service; reverse feedback is unshaped. They are not a model of
public NAT, geographic RTT or every congestion/loss pattern. Reduced quality
and temporary stalls under real constraints remain possible.

## Cost And Accounting

Before the CPU-carrier refinement, a matched actual-product VP8 1080p30 comparison's ordinary pair made
350 full-size encodes in six seconds, using about 1,201 ms summed encode time.
The pool made 170 full-size and 342 tiny encodes, using about 516 ms summed
encode time. Whole isolated Chrome CPU was 9.23 versus 8.95 CPU-seconds.
The fixture includes source drawing, barcode reads, all receiving pages and the
extra producer receiver; this is not Host-only CPU, GPU or thermal measurement.

Earlier independent-producer comparisons showed a larger whole-fixture VP8
saving, but H264 showed no total CPU win despite fewer full encodes. Do not
generalize one percentage or count dropped frames as an optimization.
The current H264 pair likewise reduced summed encode time from about 1,649 to
927 ms, while whole-fixture CPU increased from 4.17 to 4.56 CPU-seconds over six
seconds (about 0.065 of one CPU core). Less full-resolution encoding does not
guarantee lower overall CPU on hardware codecs.
The owner accepts a uniform path from the first eligible consumer, without
an audience-count threshold. Singleton and hardware costs remain explicit.

Receiver details stay real inbound observations. Sender transport bytes/loss
belong to each connection; dimensions/cadence describe the frames actually
written; native limitation evidence comes from the assigned real producer.
Shared encode counts/total encode time are not duplicated per child.
Retired producer samples keep their latest per-instance report rather than
reverting to an older polling snapshot.

## Reproduction

Use the existing isolated-browser harness and stable executable paths:

```sh
npx tsx scripts/browser-local-pool-probe.ts ordinary --1080 --av --preference=balanced
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --preference=balanced
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --network --auto --rate=400000 --preference=balanced
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --lifecycle
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --av --relay
npx tsx scripts/browser-local-pool-probe.ts carrier --1080 --background
```

Add `--h264`, `--single` or `--late` for the corresponding case. Set
`CHROME_PATH` for another installed Chromium binary. `--auto` extends the
recovery observation; product code owns all adaptation. Results go to ignored
`build/browser-local-pool`; summarize with
`node scripts/browser-local-pool-summary.mjs <result.json>`.
A successful process exit does not establish visual/performance parity.

## Primary References And Remaining Boundaries

- [W3C Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/#stream-processing)
  enforces standard frame owner/order. The selected legacy API is a different
  available API boundary, not a feature flag relaxing those checks.
- [Chromium M152 encoded frame](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.82/third_party/blink/renderer/modules/peerconnection/rtc_encoded_video_frame.cc)
  supports copy construction with validated RTP timestamp metadata.
- [Pinned WebRTC transform delegate](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/rtp_rtcp/source/rtp_sender_video_frame_transformer_delegate.cc)
  reconstructs copied native frames; internal capture/presentation timing is
  not wholly preserved. Current negotiated VP8/H264 connections lack generic
  dependency-descriptor extensions, so no frame-ID mapping was added.
- [LiveKit capability detection](https://github.com/livekit/client-sdk-js/blob/main/src/e2ee/utils.ts)
  recognizes `createEncodedStreams()`; it is not itself a reusable encoding pool.
- [WebRTC stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-targetbitrate)
  distinguishes the video encoder payload target from link bandwidth.
- [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/)
  explains why a JS canvas timer is not a reliable hidden-page media clock.

The future [RTCEncodedSource proposal](https://chromestatus.com/feature/5177374353260544)
is not exposed by the installed M152 Browser. No future API, feature flag, SFU
policy change, Browser cross-level encoded passthrough or public-network
performance guarantee is assumed. Matching Debug/artifact acceptance and
representative game/hardware feedback remain separate from these bounded runs.
