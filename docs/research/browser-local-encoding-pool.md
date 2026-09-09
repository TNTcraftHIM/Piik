# Browser Node-Local Encoding Pool

Reviewed and executed 2026-09-09 on Windows, Chrome 152.0.7977.82. This is a
research continuation of [encoded fanout](./advanced-peer-distribution.md), not
a deployed media adapter. The complete Debug supplement remains separate.

## Question And Current Answer

An independent local encoder can feed two Browser senders without choosing one
real downstream connection as the encoding authority. A standard-transform
prototype now delivers this composition. Therefore the earlier A-limited/B-low
result does not reject the owner's node-local cache model.

The viable tested carrier encodes tiny changing 16x16 frames at the required
cadence, then replaces each carrier's own encoded payload with the shared real
video. It preserves standard frame ownership. It is one full-size encode plus
two cheap encodes, not literally one encoder or one total Encode invocation.
No Browser feature flag enables this data replacement.

The prototype also creates a separate local low-budget encoding group when a
child cannot afford the original. The child's existing PeerConnection remains;
only its assigned encoded source changes. Stock WebRTC inside the local group
adapts real picture dimensions/FPS. This is closer to the Client model than the
earlier cross-sender frame-copy test, but Browser's feedback and carrier
bookkeeping are not the same native-library integration.

## Composition And Reference Boundaries

```text
original canvas/raw input -> independent local P encoder -> current encoded output
                                    |                       |              |
                              local receiver         A own-frame     B own-frame
                                                     carrier         carrier
                                                        |               |
                                                   real child A    real child B

when A needs less: original input -> local L encoder -> A carrier
                  P output continues unchanged    -> B carrier
```

Only direct children participate. No ancestor query, tree-wide cache discovery,
DataChannel media protocol, server forwarding dependency or codec-family change
was introduced. P and L currently have ordinary local PeerConnections, including
their local receiver decode cost. All such work is counted.

The [W3C stream-processing rules](https://www.w3.org/TR/webrtc-encoded-transform/#stream-processing)
reject foreign owners and reordered/replayed frame counters. They permit
modifying an existing frame's data. [LiveKit's frame cryptor](https://github.com/livekit/client-sdk-js/blob/main/src/e2ee/worker/FrameCryptor.ts)
is a mature example of same-frame payload transformation, not an existing
complete encoding pool. No mature, independently audited pool satisfying all
Screener's quality/recovery obligations was found in this review.

Pinned Chromium/WebRTC retains pre-transform payload size and frame type in
its [transform delegate](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/rtp_rtcp/source/rtp_sender_video_frame_transformer_delegate.cc).
Added payload is accounted as post-encode overhead by the
[RTP sender](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/call/rtp_video_sender.cc).
Consequently the dummy encoder's dimensions, QP and limitation state are not
evidence about the borrowed real picture. Restored sender reports do not prove
complete A/V synchronization or correct Screener quality-convergence evidence.

## Executed Comparisons

The [runner](../../scripts/browser-local-pool-probe.ts) owns an isolated Chrome,
loopback page server and cleanup. [Page fixture](../../scripts/browser-local-pool-page.js)
generates a moving source with a frame-ID barcode. Receiver callbacks read that
ID to measure freshness/age and detect repeated/backward IDs; this is not a
pixel-quality or perceptual benchmark. A single FIFO per output plus the latest
available own carrier avoids serially blocking A on B. Recovery discards obsolete
queued frames only at a valid keyframe boundary; key/delta carrier types are
aligned through existing keyframe requests.

For network cases, a [test-only UDP bridge](../../scripts/browser-pool-shaper.mjs)
replaces both A ICE candidate descriptions with its loopback sockets. It limits
forward traffic to 120 kbps with at most about 250 ms queued service, then releases
the limit. Reverse feedback remains unshaped. Current artifacts retain nominated
pair references, proxy ports and per-phase byte/drop observations. This is real
packet shaping on a local path, not a public-NAT or Internet congestion model.

The [selected results](./data/browser-local-pool.json) retain limitations as well
as successes. Runtime completion and process cleanup do not mean product
acceptance. Earlier development runs without code hashes are labeled; later
reports include the exact page-fixture SHA-256. No media payload, user session or
real invitation is retained.

Run one physical workload at a time from the repository root:

```sh
npx tsx scripts/browser-local-pool-probe.ts ordinary --1080
npx tsx scripts/browser-local-pool-probe.ts carrier --1080
npx tsx scripts/browser-local-pool-probe.ts carrier --h264 --late
npx tsx scripts/browser-local-pool-probe.ts ordinary --network
npx tsx scripts/browser-local-pool-probe.ts carrier --network --auto
```

Set `CHROME_PATH` on non-Windows hosts or when using another Chromium binary.
Add `--h264` for the second codec. `quiet` and `live` select the legacy-copy
controls; `carrier` uses standard own-frame data replacement. `--weak` is a
sender-parameter constraint, while `--network` uses the packet bridge.
`--derive` selects the known-budget split control; `--feedback` then applies
the observed budget without automatic rejoining. `--split` is the ordinary-sender
fallback control. The failed no-local-decode ablation is explicit via
`--no-local-decode --no-local-pli`. Outputs are unique files under
`build/browser-local-pool`; summarize them with
`node scripts/browser-local-pool-summary.mjs <result.json> ...`.

### Healthy Work

Two six-second 1080p30 VP8 comparisons gave:

| Measure | Ordinary two real senders | Independent P + two carriers |
| --- | ---: | ---: |
| Full-size encoded frames | 366 / 364 total | 183 / 182 |
| Tiny carrier frames | 0 | 366 / 364 total |
| Summed encode time | 1320 / 1284 ms | 497 / 477 ms including carriers |
| Whole isolated Chrome CPU time | 9.382 / 9.383 CPU-seconds | 7.486 / 7.712 CPU-seconds |
| Received picture | Both 1920x1080 | Both 1920x1080 |

Whole-Chrome CPU time includes the extra local decode and transport, both real
test receivers and barcode observations. These two short runs suggest roughly
18-20% lower whole-fixture CPU cost; they are not Host-only CPU, GPU utilization,
thermal or perceptual-quality measurements. Output bitrate differed between
runs, and encode time is not CPU time. Do not generalize the percentage.

H264 is materially different. The paired 1080p check reduced summed encode time
from 2168 ms to 905 ms including carriers, but whole Chrome CPU was 4.454 versus
4.531 CPU-seconds: no measured total CPU win. Both receivers decoded 182 frames.
A later keyframe-queue cleanup retained that cadence and lowered picture-age
p95 from about 100/107 ms to 70/78 ms, still above the ordinary 41/49 ms result.
This preserves the owner's overhead concern; H264 adoption cannot be justified
by counting encoders alone.

### Weak-Path Isolation And Recovery

Quiet placeholders isolate P from A but retain missing sender accounting.
Live standard carriers restore reports and frame counts; simply replacing their
payload does not automatically fit the real video to the available budget.
With a 50 kbps parameter ceiling, one carrier still sent about 455 kbps. Under
actual 120 kbps shaping, unadapted sharing gave A only 27 decoded frames during
14 seconds, with multi-second stale playback, while B remained healthy.

Creating a separate 80 kbps local L group demonstrates the missing ownership
boundary: A received roughly 30 fps at 320x180 and B retained 640x360. This
manual split uses a known test budget and is not evidence of automatic detection.
Immediately reconnecting A to P when the shaper releases causes about 1.4 seconds
of stale playback; a link-capacity change is not a safe rejoin signal.

The automatic arm reads the existing candidate-pair bandwidth estimate every
two seconds, applies it as the L sender's bitrate ceiling and waits for L's
full-size/non-limited output plus sufficient budget before rejoining P. The
split decision compares that estimate with measured P output bitrate. These
are explicit experimental membership/budget bridges, not a claim that stock
WebRTC already wires feedback between the senders or an accepted product rule.
No second congestion estimator was written.

Both VP8 and H264 automatic arms split and rejoined once in their final traces,
with B retaining high resolution. VP8 recovered sustained fresh output with
about 243 ms p95 source age during the forty-second release window. H264 did
the same with about 424 ms p95. The constrained transitions are still worse than
ordinary senders: VP8's first split includes a 1.4-second render gap; H264's
limited interval reaches about 1.42-second p95 age versus about 486 ms in its
ordinary control. Release-window lengths differ, so compare their raw phase
boundaries before treating aggregate percentiles as a performance ranking.

An H264 late-join check also delivers fresh source frames after joining and
keyframe alignment. Frame-ID order checks do not establish bit-exact decoder
reference correctness or A/V synchronization. Those remain required.

### Ablations And Measurement Corrections

- Flashing the entire tiny H264 source black/white caused repeated keyframes.
  Moving one dim pixel supplies fresh frames without that scene-change workload.
- An async transform sink that waits for each producer frame can accumulate old
  carrier timestamps. The current middle layer keeps one latest carrier and
  consumes the producer FIFO independently; this reduced avoidable latency.
- Serialized sender parameter operations eliminate keyframe/rate update races.
  Adding a parameter await before installing the transform caused one failed
  startup experiment that delivered only 16x16 placeholders; it is excluded
  from performance claims.
- Dropping local receiver frames avoids decoding but causes repeated PLI and
  keyframe work. Removing PLI/FIR from that local offer did not eliminate the
  observed requests. This arm is not selected as a cost optimization.
- Retired encoder counters retain their final values; missing counters must not
  subtract earlier work. Sender-report counts use report deltas, not the number
  of stats objects. The prototype's key realignment counter is not a decoder
  corruption counter.

## Next Engineering Boundary

Continue this candidate; do not reject Browser pooling on the older experiment.
Before any product adapter, resolve these concrete obligations:

1. Integrate demand sampling with existing media-stat ownership, and compare
   faster event/feedback options against the measured weak-entry gap. No blind
   immediate rejoin, room-wide minimum or periodic topology controller.
2. Keep source, carrier, actual egress and receiver evidence distinct. Feed
   quality convergence trustworthy actual-media evidence; never overwrite native
   stats to make a dummy appear to be the real encoder.
3. Verify recovery dependency metadata, synchronized audio/video, pause/source
   replacement, producer failure and bounded queues under longer lossy runs.
4. Measure Host process/GPU cost on representative game content. Use the existing
   ordinary sender path when reuse does not improve the agreed cost/experience;
   do not ship H264 merely because VP8's short CPU comparison improved.

The experimental [RTCEncodedSource proposal](https://chromestatus.com/feature/5177374353260544)
may eventually remove carrier plumbing, but installed Chrome 152 does not expose
it. It is a separate future lead, not a prerequisite for investigating the
standard same-frame carrier prototype already demonstrated here.
