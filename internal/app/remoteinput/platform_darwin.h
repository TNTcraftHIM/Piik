#pragma once

#include <CoreGraphics/CoreGraphics.h>
#include <stdint.h>

// Geometry is in Quartz display points, not Retina capture pixels.
typedef struct {
  int32_t left, top, width, height;
  bool focused;
} SilipInputBounds;

typedef struct {
  double time, x, y;
  int64_t count;
} SilipInputClick;

typedef enum {
  SilipInputTargetUnavailable,
  SilipInputTargetInvalid,
  SilipInputTargetReady
} SilipInputTargetResult;

SilipInputTargetResult silip_input_target(bool window, uint32_t id, uint32_t pid, uint64_t created,
                       SilipInputBounds *bounds);
bool silip_input_key(CGEventSourceRef source, uint16_t code, bool down,
                    uint64_t flags, bool repeat);
bool silip_input_pointer(CGEventSourceRef source, double x, double y,
                        int button, bool down, int drag, bool relative,
                        uint64_t flags, SilipInputClick *click);
bool silip_input_scroll(CGEventSourceRef source, int32_t delta, uint64_t flags);
bool silip_input_text(CGEventSourceRef source, const uint16_t *text, size_t length);
bool silip_input_stop_pressed(uint16_t key);
