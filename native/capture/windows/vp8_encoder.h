#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include <vpx/vpx_encoder.h>

namespace screener::capture {

struct Vp8Frame final {
  bool key_frame = false;
  std::vector<uint8_t> bytes;
};

class Vp8Encoder final {
 public:
  Vp8Encoder(uint32_t width, uint32_t height, uint32_t frame_rate,
             uint32_t bit_rate);
  ~Vp8Encoder();
  Vp8Encoder(const Vp8Encoder&) = delete;
  Vp8Encoder& operator=(const Vp8Encoder&) = delete;

  Vp8Frame Encode(uint8_t* nv12, size_t row_pitch, uint64_t timestamp100ns,
                  bool key_frame);
  static const char* Version();

 private:
  vpx_codec_ctx_t codec_{};
  uint32_t width_;
  uint32_t height_;
  unsigned long duration100ns_;
};

}  // namespace screener::capture
