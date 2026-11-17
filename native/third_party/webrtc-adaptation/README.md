# WebRTC quality adaptation

The [Rust capture policy](../../../prototype/channel-native/src/capture/adaptation.rs)
is a semantic port at WebRTC commit
[`3710345e71ad3a7c1f4ed4efef152fd4fc24869a`](https://webrtc.googlesource.com/src/+/3710345e71ad3a7c1f4ed4efef152fd4fc24869a/):

- `modules/video_coding/utility/quality_scaler.{h,cc}` and
  `rtc_base/numerics/{exp_filter,moving_average}.{h,cc}` own QP smoothing,
  drop samples and check timing.
- `call/adaptation/video_stream_adapter.{h,cc}` and
  `rtc_base/experiments/balanced_degradation_settings.{h,cc}` own pixel/FPS
  restrictions, both counters and default balanced behavior.
- `rtc_base/experiments/quality_scaling_experiment.{h,cc}` supplies the non-iOS
  VP8 29/95 and H264 24/37 defaults. The resource manager enables QP adaptation
  for balanced/motion and disables it for maintain-resolution.
- `video/adaptation/quality_scaler_resource.cc` owns optional-QP reporting:
  missing QP supplies no sample, while actual encoder/media-optimization drops
  can still trigger adaptation.
- `video/adaptation/overuse_frame_detector.{h,cc}` and
  `video/adaptation/encode_usage_resource.{h,cc}` own the default software
  processing-usage window, 42/85 thresholds and overuse/recovery hysteresis.
  The Rust port selects SendProcessingUsage1, without field-trial estimator2.

Each Windows/Android encoding worker owns one policy, its applied size/cadence
and real encoder feedback. Synchronous Windows software H264/VP8 workers also
measure admitted encode work through successful completion, before output waits;
conversion/readback and downstream waiting are outside that interval. One policy
combines QP and processing restrictions; each worker drops its timing state at
retirement. Maintain-framerate adjusts pixels, maintain-resolution adjusts FPS,
and balanced uses the same upstream restriction rules. Hardware/other asynchronous
encoders do not provide processing-usage feedback. The existing FrameDropper remains the byte-budget
owner. User settings, transport allocations and capture/source timestamps retain
their existing owners; QP and automatic restrictions do not make a new IPC loop.

The port selects those defaults explicitly and uses a monotonic caller tick in
place of TaskQueue scheduling. It omits field-trial parsing, unused QP arithmetic
averages/media-only drop windows, encoder-specific bitrate-limit tables and the
general ResourceAdaptationProcessor. Software usage checks are due after 100 ms,
then every 5 s, on the existing worker's admission/completion callbacks; blocked
workers do not synthesize catch-up checks. Upstream balanced defaults and recovery
hysteresis are retained. This is not the complete WebRTC sender pipeline.

The pinned C++ implementation and Rust candidate matched across VP8/H264,
balanced/motion, disabled detail, threshold/drop boundaries, delayed size changes,
both counters, initial cadence and full restoration. The maintained Rust tests
retain representative upstream result vectors and the source-FPS hint boundary;
runtime/platform evidence remains with the existing verification owner.

Original copyright notices, [LICENSE](LICENSE), [PATENTS](PATENTS) and
[AUTHORS](AUTHORS) are retained. App/Android packaging includes these texts through
the existing [license collector](../../../scripts/package-licenses.mjs).
