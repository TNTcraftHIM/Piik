#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct SilipGamepad SilipGamepad;

SilipGamepad *silip_gamepad_open(const uint8_t *descriptor, size_t descriptor_size,
                               const uint8_t *neutral, size_t report_size,
                               uint32_t *result);
uint32_t silip_gamepad_update(SilipGamepad *device, const uint8_t *report);
uint32_t silip_gamepad_close(SilipGamepad *device, const uint8_t *neutral);
