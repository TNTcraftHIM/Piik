#pragma once

#include <windows.h>

#include <algorithm>
#include <cmath>

namespace screener::capture {

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

}  // namespace screener::capture
