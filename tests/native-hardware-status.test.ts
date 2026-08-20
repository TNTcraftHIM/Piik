import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HARDWARE_PREFERENCE,
  retainsHardwarePreference,
} from "../native/sender/internal/app/ui/hardware-status.js";

const senderUI = readFileSync(
  join(import.meta.dirname, "../native/sender/internal/app/ui/app.js"),
  "utf8",
);
const senderServer = readFileSync(
  join(import.meta.dirname, "../native/sender/internal/app/server.go"),
  "utf8",
);

describe("native sender hardware preference contract", () => {
  it("accepts only a retained prefer-hardware capability result", () => {
    expect(retainsHardwarePreference({
      supported: true,
      config: { hardwareAcceleration: HARDWARE_PREFERENCE },
    })).toBe(true);
    expect(retainsHardwarePreference({ supported: true, config: {} })).toBe(false);
    expect(retainsHardwarePreference({ supported: false, config: {
      hardwareAcceleration: HARDWARE_PREFERENCE,
    } })).toBe(false);
    expect(retainsHardwarePreference(null)).toBe(false);
  });

  it("keeps VP8, one encoder, and an explicit unverified hardware boundary", () => {
    expect(senderUI).toContain('codec: "vp8"');
    expect(senderUI).toContain("encoderInstances: 1");
    expect(senderUI).toContain("HARDWARE_STATUS.PREFERENCE_ACCEPTED");
    expect(senderUI).toContain("HARDWARE_STATUS.FALLBACK");
    expect(senderUI).toContain("HARDWARE_STATUS.UNVERIFIED");
    expect(senderUI).toContain("delete fallback.hardwareAcceleration");
    expect(senderUI).not.toContain('hardwareAcceleration: "prefer-software"');
    expect(senderServer).toContain("ui/hardware-status.js");
    expect(senderServer).toContain("/hardware-status.js");
  });
});
