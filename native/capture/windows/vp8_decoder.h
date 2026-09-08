#pragma once

#include <vpx/vp8dx.h>
#include <vpx/vpx_decoder.h>

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace screener::capture {

// Decoder image storage belongs to libvpx until the next Decode call. A single
// NV12 copy is shared by all derived-output workers after upload.
class Vp8Decoder final {
 public:
  struct Image final {
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<uint8_t> nv12;
  };

  Vp8Decoder() {
    vpx_codec_dec_cfg_t config{};
    config.threads = 2;
    if (vpx_codec_dec_init(&codec_, vpx_codec_vp8_dx(), &config, 0) != VPX_CODEC_OK) {
      throw std::runtime_error("VP8 decoder initialization failed");
    }
  }
  ~Vp8Decoder() { vpx_codec_destroy(&codec_); }
  Vp8Decoder(const Vp8Decoder&) = delete;
  Vp8Decoder& operator=(const Vp8Decoder&) = delete;

  Image Decode(const std::vector<uint8_t>& data) {
    if (data.empty() || data.size() > 4 * 1024 * 1024) throw std::runtime_error("Invalid VP8 decoder input size");
    if (!(data[0] & 1)) {
      vpx_codec_stream_info_t info{};
      info.sz = sizeof(info);
      if (vpx_codec_peek_stream_info(vpx_codec_vp8_dx(), data.data(), static_cast<unsigned int>(data.size()), &info) != VPX_CODEC_OK ||
          info.w < 2 || info.h < 2 || info.w > 2560 || info.h > 1440 || (info.w & 1) || (info.h & 1)) {
        throw std::runtime_error("VP8 decoder input dimensions exceed the source bound");
      }
    }
    if (vpx_codec_decode(&codec_, data.data(), static_cast<unsigned int>(data.size()), nullptr, 0) != VPX_CODEC_OK) {
      throw std::runtime_error("VP8 decoder rejected its input");
    }
    vpx_codec_iter_t iterator = nullptr;
    const auto* image = vpx_codec_get_frame(&codec_, &iterator);
    if (!image) return {};
    const uint32_t width = image->d_w, height = image->d_h;
    if (width < 2 || height < 2 || width > 2560 || height > 1440 || (width & 1) || (height & 1) ||
        image->fmt != VPX_IMG_FMT_I420 || image->stride[0] < static_cast<int>(width) ||
        image->stride[1] < static_cast<int>(width / 2) || image->stride[2] < static_cast<int>(width / 2)) {
      throw std::runtime_error("VP8 decoder output format is unsupported");
    }
    Image result{width, height, std::vector<uint8_t>(static_cast<size_t>(width) * height * 3 / 2)};
    for (uint32_t row = 0; row < height; ++row) {
      std::copy_n(image->planes[0] + row * image->stride[0], width, result.nv12.data() + row * width);
    }
    auto* chroma = result.nv12.data() + static_cast<size_t>(width) * height;
    for (uint32_t row = 0; row < height / 2; ++row) {
      for (uint32_t column = 0; column < width / 2; ++column) {
        chroma[row * width + 2 * column] = image->planes[1][row * image->stride[1] + column];
        chroma[row * width + 2 * column + 1] = image->planes[2][row * image->stride[2] + column];
      }
    }
    if (vpx_codec_get_frame(&codec_, &iterator)) throw std::runtime_error("VP8 decoder emitted multiple frames for one access unit");
    return result;
  }

 private:
  vpx_codec_ctx_t codec_{};
};

}  // namespace screener::capture
