#pragma once

#include <cstdint>

namespace piik::capture {

inline constexpr uint32_t kMaxVideoDimension = 8192;
inline constexpr uint64_t kMaxVideoPixels = 36'864 * 16 * 16;
inline constexpr uint32_t kMaxVideoFramerate = 240;
inline constexpr uint32_t kMaxVideoBitrate = 240'000'000;
// H.264 Level 5.2 coded storage, including padding outside the visible crop.
inline constexpr uint32_t kMaxCodedVideoDimension = 8192;
inline constexpr uint64_t kMaxCodedVideoPixels = 36'864 * 16 * 16;

inline bool ValidVideoSize(uint32_t width, uint32_t height) {
  return width >= 2 && width <= kMaxVideoDimension && !(width & 1) &&
         height >= 2 && height <= kMaxVideoDimension && !(height & 1) &&
         static_cast<uint64_t>((width + 15) / 16) * ((height + 15) / 16) * 256 <= kMaxVideoPixels;
}

inline bool ValidVideoFormat(uint32_t width, uint32_t height, uint32_t fps) {
  return ValidVideoSize(width, height) && fps >= 1 && fps <= kMaxVideoFramerate &&
         static_cast<uint64_t>((width + 15) / 16) * ((height + 15) / 16) * fps <= 2'073'600;
}

inline bool ValidCodedVideoSize(uint32_t width, uint32_t height) {
  return width >= 2 && width <= kMaxCodedVideoDimension && !(width & 1) &&
         height >= 2 && height <= kMaxCodedVideoDimension && !(height & 1) &&
         static_cast<uint64_t>(width) * height <= kMaxCodedVideoPixels;
}

}  // namespace piik::capture
