# WebRTC VP8 base-QP reader

`prototype/channel-native/src/capture/qp/vp8.rs` is a bounded Rust semantic port
of `modules/video_coding/utility/vp8_header_parser.cc` at WebRTC commit
`3710345e71ad3a7c1f4ed4efef152fd4fc24869a`.

It reads the encoded frame tag, segmentation and loop-filter headers using the
original boolean arithmetic reader, then returns the 7-bit base quantizer
(0..127). It does not decode pixels, retain reference frames or compute an
average block quantizer. Truncation/invalid partition bounds make optional QP
unavailable. The source and upstream quantizer scale remain authoritative;
per-frame segment deltas are not synthesized into another quality statistic.

The port retains the original unsigned arithmetic, two-byte initialization,
header field order and end-of-partition success check. All read probabilities
are 128, so the private bit reader specializes that constant; signed fields
that are skipped still consume their sign bits. Rust slice checks replace
pointer-range checks. Original sources, original QP25/H264 test vectors,
LICENSE, PATENTS and AUTHORS are retained here without upstream changes.

Validation: the actual pinned C++ parser and Rust port returned identical
results for 2,821 cases: upstream known-QP25 encoded frame, 12 existing owned
libvpx key/P-frame fixtures, their prefixes and header-byte mutations. Unit
tests retain upstream known-QP vectors and the unavailable-feedback lifecycle.
The differential harness and its generated logging/include adapters are
temporary ignored artifacts under `build/vp8-qp-feedback-current`.

Primary sources:

- https://webrtc.googlesource.com/src/+/3710345e71ad3a7c1f4ed4efef152fd4fc24869a/modules/video_coding/utility/vp8_header_parser.cc
- https://webrtc.googlesource.com/src/+/3710345e71ad3a7c1f4ed4efef152fd4fc24869a/modules/video_coding/utility/qp_parser_unittest.cc
- https://www.rfc-editor.org/rfc/rfc6386#section-7.3

WebRTC's BSD-3-Clause license and additional PATENTS grant apply to the port
and copied vectors; see the adjacent notices.
