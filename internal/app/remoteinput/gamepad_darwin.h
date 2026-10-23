#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct PiikGamepad PiikGamepad;

PiikGamepad *piik_gamepad_open(const uint8_t *descriptor, size_t descriptor_size,
                               const uint8_t *neutral, size_t report_size,
                               uint32_t *result);
uint32_t piik_gamepad_update(PiikGamepad *device, const uint8_t *report);
uint32_t piik_gamepad_close(PiikGamepad *device, const uint8_t *neutral);
