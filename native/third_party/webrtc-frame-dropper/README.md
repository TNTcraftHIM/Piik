# WebRTC encoder frame dropping

The [Rust encoder utility](../../../prototype/channel-native/src/capture/frame_dropper.rs)
is a semantic port of WebRTC's `modules/video_coding/utility/frame_dropper.{h,cc}`
and `rtc_base/numerics/exp_filter.{h,cc}` at commit
[`6f37672d358475cd17544121a12494da454d85fb`](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/).

Windows and Android encoder workers use it before frame submission when encoded
output exceeds its allocation. It does not choose resolution, codec, media routes
or transport budgets. Unused reset/enable entry points are omitted; input timing
remains in the producer's cadence module.

The port retains the upstream copyright. [LICENSE](LICENSE) and [PATENTS](PATENTS)
remain here for source attribution and the existing [package notices](../../../licenses/README.md).
