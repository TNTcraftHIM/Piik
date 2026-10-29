# WebRTC encoder frame dropping

These four unmodified upstream source files come from WebRTC commit
`6f37672d358475cd17544121a12494da454d85fb`, the existing SDK pin in
[webrtc-dependencies.json](../../capture/windows/webrtc-dependencies.json).
Source: https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/

Android reuses FrameDropper and its ExpFilter dependency before encoder Surface
submission when a platform encoder exceeds its allocation. They do not choose
resolution, codec, media routes or transport budgets. The Android renderer owns
one instance per physical encoder. Keep upstream code unchanged when updating
the shared pin; LICENSE and PATENTS accompany this subset.

The isolated [Rust producer](../../../prototype/channel-native/src/capture/frame_dropper.rs)
ports this same algorithm, with unused reset/enable entry points removed.
Its source retains the upstream copyright and uses this directory's LICENSE
and PATENTS; input timing remains in the producer's cadence module.
