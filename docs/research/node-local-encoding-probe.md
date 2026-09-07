# Node-Local Encoding Cost Probe

Measured: 2026-09-07. This is a component experiment, not a media-policy decision.
[Node-local adaptive reuse](./node-local-adaptation.md) owns the design model.
[Full measurement data](./data/node-local-vp8.json) includes both rounds, phase
counts, timings, keyframe sizes and measured source digests.

## Method

- Windows 11 build 26200, Ryzen 7 9700X, 16 logical CPUs; existing libvpx 1.17.0
  and unmodified `Vp8Encoder`, four threads per encoder, realtime CBR, no GPU.
- Synthetic NV12 texture at 30 fps: mostly static with a small changing patch,
  or scrolling detail. Each size uses the same deterministic scene. Input
  preparation, scaling, decoding, capture and network are excluded.
- Fixture outputs are 1920x1080 at 5 Mbps, 960x540 at 1.25 Mbps and 480x270 at
  0.312 Mbps. These half/quarter-size fixtures are not a production ladder.
- Steady arms run four seconds, excluding the first second. Serial scheduling
  isolates encoding work; two passes reverse scenario order. This is not a
  comparison against actual Browser WebRTC senders or hardware simulcast.
- Trace arms replay two direct children for two seconds per phase:
  `H/H -> H/L -> L/L -> M/M -> H/H -> H/L -> H/H`. A new requested output needs
  an encoded keyframe, even if that layer was already being encoded.
- `envelope` encodes all outputs at or below the maximum scripted demand.
  `exact-cold` encodes only demanded outputs and destroys inactive codecs.
  `exact-warm` retains at most three codec objects through the 14-second trace,
  without encoding inactive outputs. No LiveKit BWE or debounce is emulated.
- Elapsed work uses a monotonic clock. Whole-window process CPU cycles include
  worker activity. `GetProcessTimes` is also retained but varied considerably in
  these short windows; conclusions below use cycles and elapsed work, not its
  apparent CPU percentage. Resident-memory deltas are not leak/peak-memory proof.

## Steady Results

Means across two rounds. CPU work is relative process cycles per source frame,
normalized to one high encode within the same scene, not whole-machine usage.

| Active encodings | Mostly static ms/frame | Motion ms/frame | Relative CPU work, static / motion |
| --- | ---: | ---: | ---: |
| High | 4.26 | 6.52 | 1.00 / 1.00 |
| Two independent high encodes | 8.47 | 12.93 | 1.95 / 1.95 |
| High plus low | 4.68 | 7.11 | 1.09 / 1.09 |
| High, middle and low | 5.84 | 8.71 | 1.35 / 1.32 |
| Middle plus low | 1.69 | 2.35 | 0.39 / 0.36 |
| Low | 0.45 | 0.65 | 0.09 / 0.10 |

Three outputs cost about 31-32% fewer CPU cycles than two full-size outputs in
this fixture, but 32-35% more than one. Lower outputs are not free. The three
sizes contain 1.3125 times the high output's pixels, so this does not establish
special multi-resolution work sharing: the current library build has
`CONFIG_MULTI_RES_ENCODING=0` and uses separate encoder contexts.

Steady high output produced 90 measured frames and the same total output bytes
across the high-containing arms. This is a count/size check, not a bitwise or
perceptual-quality proof. Two-high motion had one work sample over 33.3 ms in
each round; the other steady arms had none. This is not a Viewer freeze count.
Motion resident-memory deltas were about 70 MiB for high, 93 MiB for three outputs
and 138 MiB for two high encodes, excluding the prebuilt input allocation.

## Demand And Resume

The envelope used about 26% more CPU cycles than exact-cold on the scripted
trace. The extra output counts were visible: low/middle/high encoded
420/360/300 frames versus 180/60/300 for exact demand. Two children requesting
the same low output did not double its encode count. Stopping high output in
the all-low phase did not discard the input fixture.

Naive warm retention saved only about 5 ms of total codec initialization across
14 seconds, compared with cold recreation, and retained about 23 MiB more
resident memory at trace end. It also changed resumed output substantially:

| High resumes at frame 240 | Keyframe bytes, both rounds identical | Ready time, two rounds |
| --- | ---: | --- |
| Fresh codec after pause | 32,268 | 22.79 / 19.76 ms |
| Retained codec, original source timestamps | 228,469 | 21.79 / 21.56 ms |
| Retained codec, timestamp-gap ablation | 31,079 | 13.24 / 12.90 ms |

The ablation changes only the encoder PTS to count active encoded frames while
retaining the same input pictures. It isolates the timestamp-gap effect; it is
not an accepted replacement for source timestamps, RTP timing or A/V sync.
No network was measured, so the larger keyframe is evidence of burst risk, not
a demonstrated network stall.

The pinned libvpx source derives an internal frame rate from input timestamps.
Its multi-resolution path explicitly uses the lowest active layer's frame rate
to avoid a paused upper layer misreading the timestamp gap. That is a mature
reuse lead, not a reason to implement an application clock workaround. The
current probe did not enable or validate that multi-resolution implementation.

## Decision And Next Evidence

Keep the maximum-demand envelope as a serious, simpler candidate. This result
does not prove that exact demand is worth a custom retention controller, nor
that the envelope switches receivers faster. Serial high-first scheduling and
keyframe work still affect its local readiness time. Do not add a warm pool or
timing workaround to production from this experiment.

Next compare the library's coordinated multi-resolution behavior, then measure
H264 hardware cost and actual decode/forward switching under bounded congestion.
Relay decode, scaling, surface copies, output reuse and inherited-low-input
recovery are separate remaining costs. Blindly starting lower encoders at every
healthy forwarding relay would violate the one-encode reuse objective.

## Reproduction

Use the existing pinned libvpx build produced by the Windows Client build. From
a Visual Studio x64 developer shell, with `VPX_INCLUDE` and `VPX_LIBRARY` pointing
to that build:

```bat
cl /nologo /std:c++20 /EHsc /O2 /MT /W4 /WX /external:I "%VPX_INCLUDE%" /external:W0 native/capture/windows/encoded_variants.probe.cpp native/capture/windows/vp8_encoder.cpp /Fo:build/embedded-media/ /Fe:build/embedded-media/encoded-variants.probe.exe "%VPX_LIBRARY%" /link /LTCG psapi.lib
node scripts/encoded-variants-probe.mjs
```

Create the `build/embedded-media` directory first. The Node entry runs 32 bounded
processes sequentially with frame/count checks and writes its report under that
directory. No default CI, application dependency, capture, room or production
configuration was changed. All generated executables stay in this stable build
path. The clock-ablation arm exists only to reproduce the observed pause effect.

## Primary Sources

- [Pinned libvpx timestamp and multi-resolution handling](https://github.com/webmproject/libvpx/blob/6df3ec34557879fff673706f4a1d9fbd0f3a6f0e/vp8/encoder/onyx_if.c#L4946-L5010)
- [libvpx multi-resolution example](https://github.com/webmproject/libvpx/blob/6df3ec34557879fff673706f4a1d9fbd0f3a6f0e/examples/vp8_multi_resolution_encoder.c)
- [Windows process cycle measurement](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryprocesscycletime)
