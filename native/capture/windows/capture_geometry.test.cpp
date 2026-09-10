#define NOMINMAX
#include "capture_geometry.h"

#include <cassert>
#include <iostream>

int main() {
  using namespace piik::capture;
  const SIZE captured{1280, 960};
  const SIZE monitor{1920, 1080};
  const auto presentation = [&](DISPLAYCONFIG_SCALING scaling,
                                DISPLAYCONFIG_ROTATION rotation =
                                    DISPLAYCONFIG_ROTATION_IDENTITY) {
    return DisplayedFrameSize(captured, captured, monitor, scaling, rotation);
  };
  const auto expect_rect = [&](SIZE content, RECT expected) {
    const RECT actual = FitFrameRect(content, monitor);
    assert(EqualRect(&actual, &expected));
  };

  expect_rect(presentation(DISPLAYCONFIG_SCALING_STRETCHED), {0, 0, 1920, 1080});
  for (const auto scaling : {DISPLAYCONFIG_SCALING_IDENTITY,
                            DISPLAYCONFIG_SCALING_CENTERED,
                            DISPLAYCONFIG_SCALING_ASPECTRATIOCENTEREDMAX,
                            DISPLAYCONFIG_SCALING_CUSTOM,
                            DISPLAYCONFIG_SCALING_PREFERRED}) {
    expect_rect(presentation(scaling), {240, 0, 1680, 1080});
  }
  // A window/texture that is not the desktop raster must not inherit its stretch.
  expect_rect(DisplayedFrameSize(captured, monitor, monitor,
                                 DISPLAYCONFIG_SCALING_STRETCHED,
                                 DISPLAYCONFIG_ROTATION_IDENTITY),
              {240, 0, 1680, 1080});
  expect_rect(DisplayedFrameSize(monitor, captured, monitor,
                                 DISPLAYCONFIG_SCALING_STRETCHED,
                                 DISPLAYCONFIG_ROTATION_IDENTITY),
              {0, 0, 1920, 1080});
  for (const auto rotation : {DISPLAYCONFIG_ROTATION_ROTATE90,
                              DISPLAYCONFIG_ROTATION_ROTATE270}) {
    const SIZE rotated = presentation(DISPLAYCONFIG_SCALING_STRETCHED, rotation);
    assert(rotated.cx == 1080 && rotated.cy == 1920);
  }
  expect_rect(presentation(DISPLAYCONFIG_SCALING_STRETCHED,
                            DISPLAYCONFIG_ROTATION_ROTATE180),
              {0, 0, 1920, 1080});
  expect_rect(DisplayedFrameSize(captured, captured, {},
                                 DISPLAYCONFIG_SCALING_STRETCHED,
                                 DISPLAYCONFIG_ROTATION_IDENTITY),
              {240, 0, 1680, 1080});
  const RECT wide = FitFrameRect({2560, 1080}, monitor);
  assert(wide.left == 0 && wide.right == 1920 && wide.top > 0 && wide.bottom < 1080);
  std::cout << "Windows capture presentation geometry passed.\n";
}
