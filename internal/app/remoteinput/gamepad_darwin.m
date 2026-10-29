//go:build darwin && !ios && cgo

#include "gamepad_darwin.h"
#import <Foundation/Foundation.h>
#include <IOKit/hidsystem/IOHIDUserDevice.h>
#include <Security/SecTask.h>
#include <dispatch/dispatch.h>
#include <mach/mach_time.h>
#include <stdlib.h>
#include <string.h>

struct SilipGamepad {
  IOHIDUserDeviceRef device;
  dispatch_queue_t queue;
  size_t report_size;
  uint8_t *report;
};

static bool entitled(void) {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) return false;
  CFTypeRef value = SecTaskCopyValueForEntitlement(task,
      CFSTR("com.apple.developer.hid.virtual.device"), NULL);
  bool allowed = value && CFEqual(value, kCFBooleanTrue);
  if (value) CFRelease(value);
  CFRelease(task);
  return allowed;
}

SilipGamepad *silip_gamepad_open(const uint8_t *descriptor, size_t descriptor_size,
                               const uint8_t *neutral, size_t report_size,
                               uint32_t *result) {
  @autoreleasepool {
    *result = kIOReturnNoMemory;
    SilipGamepad *pad = calloc(1, sizeof(*pad));
    if (!pad) return NULL;
    pad->report = malloc(report_size);
    if (!pad->report) { free(pad); return NULL; }
    pad->report_size = report_size;
    memcpy(pad->report, neutral, report_size);
    NSDictionary *properties = @{
      @kIOHIDReportDescriptorKey: [NSData dataWithBytes:descriptor length:descriptor_size],
      @kIOHIDVendorIDKey: @0,
      @kIOHIDProductIDKey: @1,
      @kIOHIDProductKey: @"Silip Remote Gamepad",
      @kIOHIDManufacturerKey: @"Silip",
      @kIOHIDTransportKey: @"Virtual",
      @kIOHIDSerialNumberKey: [[NSUUID UUID] UUIDString]
    };
    pad->device = IOHIDUserDeviceCreateWithProperties(kCFAllocatorDefault,
        (CFDictionaryRef)properties, IOHIDUserDeviceOptionsCreateOnActivate);
    if (!pad->device) {
      // Do not treat Accessibility permission or an installed SDK as authority
      // to create a device; this entitlement is a separate Apple signing grant.
      *result = entitled() ? kIOReturnError : kIOReturnNotPermitted;
      free(pad->report);
      free(pad);
      return NULL;
    }
    pad->queue = dispatch_queue_create("io.github.p4aaaul.silip.remote-gamepad", DISPATCH_QUEUE_SERIAL);
    if (!pad->queue) {
      CFRelease(pad->device);
      free(pad->report);
      free(pad);
      return NULL;
    }
    IOHIDUserDeviceSetDispatchQueue(pad->device, pad->queue);
    IOHIDUserDeviceRegisterGetReportBlock(pad->device,
        ^IOReturn(IOHIDReportType type, uint32_t reportID, uint8_t *report, CFIndex *length) {
          if (type != kIOHIDReportTypeInput || reportID != 0) return kIOReturnUnsupported;
          if (*length < (CFIndex)pad->report_size) return kIOReturnNoSpace;
          memcpy(report, pad->report, pad->report_size);
          *length = pad->report_size;
          return kIOReturnSuccess;
        });
    IOHIDUserDeviceRegisterSetReportBlock(pad->device,
        ^IOReturn(IOHIDReportType type, uint32_t reportID, const uint8_t *report, CFIndex length) {
          return kIOReturnUnsupported; // descriptor advertises input only
        });
    IOHIDUserDeviceSetCancelHandler(pad->device, ^{
      // Apple's API requires cancellation completion before the final release.
      CFRelease(pad->device);
      dispatch_release(pad->queue);
      free(pad->report);
      free(pad);
    });
    IOHIDUserDeviceActivate(pad->device);
    *result = silip_gamepad_update(pad, neutral);
    if (*result != kIOReturnSuccess) {
      IOHIDUserDeviceCancel(pad->device);
      return NULL;
    }
    return pad;
  }
}

uint32_t silip_gamepad_update(SilipGamepad *pad, const uint8_t *report) {
  __block IOReturn result;
  dispatch_sync(pad->queue, ^{
    result = IOHIDUserDeviceHandleReportWithTimeStamp(pad->device,
        mach_absolute_time(), report, pad->report_size);
    if (result == kIOReturnSuccess) memcpy(pad->report, report, pad->report_size);
  });
  return result;
}

uint32_t silip_gamepad_close(SilipGamepad *pad, const uint8_t *neutral) {
  uint32_t result = silip_gamepad_update(pad, neutral);
  IOHIDUserDeviceCancel(pad->device);
  return result;
}
