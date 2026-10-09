#pragma once

#include <cstdint>

namespace piik::capture {

inline constexpr uint32_t kMaxVideoDimension = 3840;
inline constexpr uint64_t kMaxVideoPixels = 3840 * 2160;
// H.264 Level 5.1 coded storage, including padding outside the visible crop.
inline constexpr uint32_t kMaxCodedVideoDimension = 4096;
inline constexpr uint64_t kMaxCodedVideoPixels = 36'864 * 16 * 16;

inline bool ValidVideoSize(uint32_t width, uint32_t height) {
  return width >= 2 && width <= kMaxVideoDimension && !(width & 1) &&
         height >= 2 && height <= kMaxVideoDimension && !(height & 1) &&
         static_cast<uint64_t>(width) * height <= kMaxVideoPixels;
}

inline bool ValidVideoFormat(uint32_t width, uint32_t height, uint32_t fps) {
  return ValidVideoSize(width, height) && fps >= 1 && fps <= 60 &&
         static_cast<uint64_t>((width + 15) / 16) * ((height + 15) / 16) * fps <= 983'040;
}

inline bool ValidCodedVideoSize(uint32_t width, uint32_t height) {
  return width >= 2 && width <= kMaxCodedVideoDimension && !(width & 1) &&
         height >= 2 && height <= kMaxCodedVideoDimension && !(height & 1) &&
         static_cast<uint64_t>(width) * height <= kMaxCodedVideoPixels;
}

}  // namespace piik::capture
