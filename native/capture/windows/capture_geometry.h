#pragma once

#include "video_bounds.h"

#include <windows.h>

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace piik::capture {

inline SIZE DisplayedFrameSize(SIZE captured, SIZE desktop, SIZE target,
                               DISPLAYCONFIG_SCALING scaling,
                               DISPLAYCONFIG_ROTATION rotation) {
  if (scaling != DISPLAYCONFIG_SCALING_STRETCHED ||
      captured.cx != desktop.cx || captured.cy != desktop.cy ||
      target.cx <= 0 || target.cy <= 0 ||
      target.cx > 16'384 || target.cy > 16'384) {
    return captured;
  }
  switch (rotation) {
    case DISPLAYCONFIG_ROTATION_IDENTITY:
    case DISPLAYCONFIG_ROTATION_ROTATE180:
      return target;
    case DISPLAYCONFIG_ROTATION_ROTATE90:
    case DISPLAYCONFIG_ROTATION_ROTATE270:
      return {target.cy, target.cx};
    default:
      return captured;
  }
}

inline RECT FitFrameRect(SIZE content, SIZE output) {
  const double scale = std::min(static_cast<double>(output.cx) / content.cx,
                                static_cast<double>(output.cy) / content.cy);
  const LONG width = std::min(output.cx, std::max<LONG>(
      2, static_cast<LONG>(std::llround(content.cx * scale)) & ~1L));
  const LONG height = std::min(output.cy, std::max<LONG>(
      2, static_cast<LONG>(std::llround(content.cy * scale)) & ~1L));
  const LONG left = (output.cx - width) / 2;
  const LONG top = (output.cy - height) / 2;
  return {left, top, left + width, top + height};
}

// A quality profile is an output ceiling, not a canvas to pad or upscale into.
// Keep even dimensions for NV12; WebRTC can further adapt this bounded source.
inline SIZE BoundedFrameSize(SIZE content, SIZE ceiling) {
  if (content.cx <= 0 || content.cy <= 0 || ceiling.cx < 2 || ceiling.cy < 2)
    throw std::invalid_argument("Invalid capture presentation dimensions");
  const double scale = std::min({1.0,
      static_cast<double>(ceiling.cx) / content.cx,
      static_cast<double>(ceiling.cy) / content.cy});
  return {
      std::max<LONG>(2, static_cast<LONG>(content.cx * scale) & ~1L),
      std::max<LONG>(2, static_cast<LONG>(content.cy * scale) & ~1L),
  };
}

}  // namespace piik::capture
