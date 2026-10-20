#pragma once

#include <CoreGraphics/CoreGraphics.h>
#include <stdint.h>

// Geometry is in Quartz display points, not Retina capture pixels.
typedef struct {
  int32_t left, top, width, height;
  bool focused;
} PiikInputBounds;

typedef struct {
  double time, x, y;
  int64_t count;
} PiikInputClick;

bool piik_input_target(bool window, uint32_t id, uint32_t pid, uint64_t created,
                       PiikInputBounds *bounds);
bool piik_input_key(CGEventSourceRef source, uint16_t code, bool down,
                    uint64_t flags, bool repeat);
bool piik_input_pointer(CGEventSourceRef source, double x, double y,
                        int button, bool down, int drag, bool relative,
                        uint64_t flags, PiikInputClick *click);
bool piik_input_scroll(CGEventSourceRef source, int32_t delta, uint64_t flags);
bool piik_input_text(CGEventSourceRef source, const uint16_t *text, size_t length);
bool piik_input_stop_pressed(uint16_t key);
