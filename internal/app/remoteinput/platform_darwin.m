//go:build darwin && cgo && remotecontrol

#include "platform_darwin.h"
#include <ApplicationServices/ApplicationServices.h>
#import <AppKit/NSEvent.h>
#include <libproc.h>
#include <math.h>
#include <string.h>
#include <time.h>

static bool number(CFDictionaryRef value, CFStringRef key, int64_t *out) {
  CFTypeRef field = CFDictionaryGetValue(value, key);
  return field && CFGetTypeID(field) == CFNumberGetTypeID() &&
         CFNumberGetValue(field, kCFNumberSInt64Type, out);
}

static bool focused_window(uint32_t pid, CGRect rect) {
  AXUIElementRef system = AXUIElementCreateSystemWide();
  if (!system) return false;
  AXUIElementSetMessagingTimeout(system, 0.1f);
  CFTypeRef app = NULL, window = NULL, position = NULL, size = NULL;
  pid_t owner = 0;
  CGPoint origin = CGPointZero;
  CGSize extent = CGSizeZero;
  bool focused = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &app) == kAXErrorSuccess &&
      CFGetTypeID(app) == AXUIElementGetTypeID() &&
      AXUIElementGetPid((AXUIElementRef)app, &owner) == kAXErrorSuccess && owner == pid &&
      AXUIElementCopyAttributeValue((AXUIElementRef)app, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess &&
      CFGetTypeID(window) == AXUIElementGetTypeID() &&
      AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXPositionAttribute, &position) == kAXErrorSuccess &&
      CFGetTypeID(position) == AXValueGetTypeID() && AXValueGetValue(position, kAXValueCGPointType, &origin) &&
      AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXSizeAttribute, &size) == kAXErrorSuccess &&
      CFGetTypeID(size) == AXValueGetTypeID() && AXValueGetValue(size, kAXValueCGSizeType, &extent) &&
      CGRectEqualToRect(rect, (CGRect){origin, extent});
  if (size) CFRelease(size);
  if (position) CFRelease(position);
  if (window) CFRelease(window);
  if (app) CFRelease(app);
  CFRelease(system);
  return focused;
}

bool piik_input_target(bool window, uint32_t id, uint32_t pid, uint64_t created,
                       PiikInputBounds *bounds) {
  CGRect rect = CGRectNull;
  bool focused = true;
  if (!window) {
    if (!CGDisplayIsActive(id)) return false;
    rect = CGDisplayBounds(id);
  } else {
    struct proc_bsdinfo process = {0};
    if (!pid || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process, sizeof(process)) != sizeof(process) ||
        process.pbi_start_tvsec * 1000000ULL + process.pbi_start_tvusec != created) return false;
    CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
    if (!windows) return false;
    for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
      CFDictionaryRef entry = CFArrayGetValueAtIndex(windows, index);
      int64_t current = 0, owner = 0;
      if (!number(entry, kCGWindowNumber, &current)) continue;
      if (current != id || !number(entry, kCGWindowOwnerPID, &owner) || owner != pid) continue;
      CFDictionaryRef geometry = CFDictionaryGetValue(entry, kCGWindowBounds);
      if (geometry) CGRectMakeWithDictionaryRepresentation(geometry, &rect);
    }
    // Public AX has no CGWindowID. Match the actual key window's geometry only
    // when it identifies exactly one window of this process; z-order is not focus.
    unsigned matches = 0;
    for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
      CFDictionaryRef entry = CFArrayGetValueAtIndex(windows, index);
      int64_t owner = 0;
      CGRect candidate = CGRectNull;
      CFDictionaryRef geometry = CFDictionaryGetValue(entry, kCGWindowBounds);
      if (number(entry, kCGWindowOwnerPID, &owner) && owner == pid && geometry &&
          CGRectMakeWithDictionaryRepresentation(geometry, &candidate) && CGRectEqualToRect(candidate, rect)) ++matches;
    }
    focused = matches == 1 && focused_window(pid, rect);
    CFRelease(windows);
  }
  if (CGRectIsNull(rect) || CGRectIsEmpty(rect)) return false;
  *bounds = (PiikInputBounds){rect.origin.x, rect.origin.y, rect.size.width, rect.size.height, focused};
  return true;
}

static bool post(CGEventRef event, uint64_t flags) {
  if (!event) return false;
  CGEventSetFlags(event, flags);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

bool piik_input_key(CGEventSourceRef source, uint16_t code, bool down,
                    uint64_t flags, bool repeat) {
  CGEventRef event = CGEventCreateKeyboardEvent(source, code, down);
  if (event) {
    if (code >= 54 && code <= 62) CGEventSetType(event, kCGEventFlagsChanged);
    else if (repeat) CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, 1);
  }
  return post(event, flags);
}

bool piik_input_pointer(CGEventSourceRef source, double x, double y,
                        int button, bool down, int drag, bool relative,
                        uint64_t flags, PiikInputClick *click) {
  CGEventRef current = CGEventCreate(NULL);
  if (!current) return false;
  CGPoint point = CGEventGetLocation(current);
  CFRelease(current);
  CGEventType type;
  if (button < 0) {
    point = relative ? CGPointMake(point.x + x, point.y + y) : CGPointMake(x, y);
    type = drag < 0 ? kCGEventMouseMoved : drag == 0 ? kCGEventLeftMouseDragged :
           drag == 1 ? kCGEventRightMouseDragged : kCGEventOtherMouseDragged;
    button = drag < 0 ? 0 : drag;
  } else {
    type = button == 0 ? (down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp) :
           button == 1 ? (down ? kCGEventRightMouseDown : kCGEventRightMouseUp) :
                         (down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp);
  }
  CGEventRef event = CGEventCreateMouseEvent(source, type, point, button);
  if (event && click) {
    if (down) {
      struct timespec clock;
      clock_gettime(CLOCK_MONOTONIC, &clock);
      double now = clock.tv_sec + clock.tv_nsec / 1e9;
      // Quartz requires an explicit click count. Use the Host's double-click
      // interval and keep distinct positions/buttons from becoming double-clicks.
      click->count = now - click->time <= [NSEvent doubleClickInterval] &&
          hypot(point.x - click->x, point.y - click->y) <= 4 ? click->count + 1 : 1;
      click->time = now; click->x = point.x; click->y = point.y;
    }
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, click->count);
  }
  if (event && relative) {
    CGEventSetIntegerValueField(event, kCGMouseEventDeltaX, (int64_t)x);
    CGEventSetIntegerValueField(event, kCGMouseEventDeltaY, (int64_t)y);
  }
  return post(event, flags);
}

bool piik_input_scroll(CGEventSourceRef source, int32_t delta, uint64_t flags) {
  // The shared input session already normalizes wheel deltas to positive up.
  return post(CGEventCreateScrollWheelEvent(source, kCGScrollEventUnitPixel, 1, delta), flags);
}

bool piik_input_text(CGEventSourceRef source, const uint16_t *text, size_t length) {
  CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
  CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
  if (!down || !up) {
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return false;
  }
  CGEventKeyboardSetUnicodeString(down, length, text);
  CGEventKeyboardSetUnicodeString(up, length, text);
  return post(down, 0) && post(up, 0);
}

bool piik_input_stop_pressed(void) {
  // Inspect only the local emergency chord; no event tap or key log.
  CGEventSourceStateID state = kCGEventSourceStateHIDSystemState;
  return (CGEventSourceKeyState(state, 59) || CGEventSourceKeyState(state, 62)) &&
         (CGEventSourceKeyState(state, 58) || CGEventSourceKeyState(state, 61)) &&
         CGEventSourceKeyState(state, 109); // Control + Option + F10
}
