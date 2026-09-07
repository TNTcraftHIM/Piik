# Selective Encoding And Decode Probe

Measured: 2026-09-07. Both arms share each encoded output and deliver only the
representation selected by each direct child. This extends the
[Native VP8 cost probe](./node-local-encoding-probe.md), not the production UI.
[Raw component measurements](./data/node-local-browser.json) include all 16 runs
and the exact worker SHA-256.

## Method And Limits

- Isolated Chrome 152.0.7977.82 on Windows, WebCodecs with `prefer-software`,
  realtime latency and constant bitrate requests; VP8 and `avc1.420028` supported.
  The API does not identify the actual backend here. This is not a Native MFT,
  H264 hardware or Browser WebRTC sender benchmark.
- One deterministic moving NV12 input, 1080p30, passed to finite 1080p/540p/270p
  encoder configurations at 5/1.25/0.3125 Mbps. The codec performs any required
  scaling; there is no custom scaler. These remain measurement fixtures.
- Two VideoDecoders consume the selected encoded output. They decode the same
  shared chunk when they request the same layer. Dimensions and timestamps are
  checked for every delivered frame. There is no RTP, network, jitter buffer,
  retransmission, packet pacing, A/V sync or pixel-quality comparison.
- Seven phases of 32 frames: `H/H, H/L, L/L, M/M, H/H, H/L, H/H`. Two rounds
  reverse policy order, for Host and relay, with both codecs. Exact demand
  destroys inactive codecs; envelope keeps all layers through the maximum
  requested level active. This does not emulate LiveKit's demand/debounce loop.
- Relay receives an already encoded H stream prepared outside timing. H passes
  directly to children. Only missing lower output activates one input decoder;
  both arms decode 128 of 224 input frames, not once per child. No lower encoder
  runs in relay H/H phases. An envelope relay with H/L also produces M as a
  fallback; it never re-encodes the received H.
- Demand changes align with upstream keyframes. Receiver configuration changes
  start on a keyframe. This is a best-case local switching fixture, not evidence
  for arbitrary-phase PLI response or weak-network switching.
- Outputs reach their consumers independently; H forwarding does not wait for
  lower encodes. The initial scaffold had an all-encoder delivery barrier; it
  was removed before the recorded run. Each source iteration still waits for
  all work to finish to bound the probe. Per-frame encoder flush simplifies the
  fixture and may differ from a continuously queued production codec.
- Reported times are elapsed local readiness/work intervals, not total CPU
  usage. Parallel encoders can hide additional CPU work behind similar elapsed
  time. Use the Native probe for the separately measured CPU-cycle comparison.

## Results

Means across the two rounds; each consumer decoded all 224 expected frames in
every run, with the requested dimensions and timestamps.

| Codec / role | Exact total processing ms/frame | Envelope total processing ms/frame | Exact / envelope encode-stage readiness ms |
| --- | ---: | ---: | ---: |
| VP8 Host | 6.85 | 6.93 | 2.83 / 2.92 |
| VP8 relay | 6.37 | 6.52 | 0.50 / 0.70 |
| H264 Host | 5.60 | 5.63 | 4.46 / 4.51 |
| H264 relay | 2.27 | 3.27 | 0.92 / 1.93 |

The bookkeeping/configuration-call mean is below 0.02 ms/frame in every arm.
This only bounds the small finite-set implementation tested here; it does not
measure an elaborate adaptive scheduler or all asynchronous codec setup costs.
The extra middle output in relay H/L makes the envelope do more work even though
the child never receives those packets. Across each relay run, exact encoded
96/32/0 L/M/H frames and envelope 128/96/0; H was reused in both.

Host's first H-to-L switch took 4.9-5.4 ms exact versus 4.2-4.3 ms envelope for
VP8, and 3.0-3.2 ms versus 2.2-2.5 ms for H264. That small local difference does
not prove a noticeable playback benefit.

H264 Host's later return to H measured 192-195 ms exact versus 36-38 ms envelope,
repeating with reversed order. Both policies had stopped H during all-low and
middle phases, so this is not simply "H was already encoding". Backend resource
and scheduling effects have not been separated. Record it as an observed
implementation-dependent difference, not an inherent guarantee of the policy.
Both H264 policies also had roughly 90-100 ms middle-layer cold transitions.
An envelope does not eliminate every cold-start delay.

Output reuse did not imply broadcasting every layer. For example, VP8 relay
generated 260,544 versus 583,797 derived bytes, while both policies selected
exactly 4,946,988 total bytes for their two receivers. These are codec payload
counts, not measured network throughput. Extra encoded bytes were unused.

## Implications

The expensive parts are codec work, cold activation and received-frame
decode/scale, not a three-entry demand set. Common finite representations can
support either policy without a second pipeline. The results do not establish
that exact demand always has high overhead, or that always-active layers are
free. Prefer a small framework-style owner and avoid a custom warm resource
manager until evidence requires one.

The [design proposal](./node-local-media-design.md) takes the maximum-demand
envelope as the first integration candidate for an already-needed encoder group,
while preserving zero-transcode relay paths and leaving hardware/network
acceptance explicit. No source runtime, wire, dependency or production change
was made by this probe.

## Reproduction

```text
node scripts/encoded-variants-browser.mjs
```

Open the printed loopback URL in an isolated Chrome and activate its one button.
The bounded worker posts its structured result to
`build/embedded-media/browser-variants-result.json`. Close the browser and stop
the probe server afterward. This is opt-in research, not a new default CI job.
Input is synthetic; it captures no user screen or private media.

Reference: [WebCodecs processing and resource model](https://www.w3.org/TR/webcodecs/).
