#pragma once

#include "h264_encoder.h"

#include <functional>
#include <memory>

namespace screener::capture::windows {

struct AdaptiveAccessUnit final {
  EncodedAccessUnit access_unit;
  UINT32 width = 0;
  UINT32 height = 0;
  UINT64 duration100ns = 0;
};

// One complete WebRTC encoding/adaptation pipeline for one shared output.
class AdaptiveEncoder final {
 public:
  using Factory = std::function<std::unique_ptr<VideoEncoder>(const VideoProfile&)>;
  using FrameProducer = std::function<ComPtr<ID3D11Texture2D>(UINT32, UINT32)>;

  AdaptiveEncoder(OutputKind kind, VideoProfile ceiling, ID3D11Device* device,
                  Factory create, std::unique_ptr<VideoEncoder> initial = nullptr,
                  int output_index = -1);
  ~AdaptiveEncoder();
  AdaptiveEncoder(const AdaptiveEncoder&) = delete;
  AdaptiveEncoder& operator=(const AdaptiveEncoder&) = delete;

  std::optional<AdaptiveAccessUnit> Encode(
      FrameProducer produce, UINT32 source_width, UINT32 source_height,
      UINT64 timestamp100ns, bool key_frame, UINT32 bitrate);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace screener::capture::windows
