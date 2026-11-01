import { describe, expect, it } from "vitest";

import { androidVersionCode } from "../scripts/app-package-targets.mjs";

describe("App package targets", () => {
  it("derives monotonically ordered Android codes from the product version", () => {
    expect(["development", "v0.0.1", "v2.0.9", "v2.1.0", "v3.0.0", "v2100.0.0"].map(androidVersionCode))
      .toEqual([1, 1, 2_000_009, 2_001_000, 3_000_000, 2_100_000_000]);
    for (const version of ["v0.0.0", "v2.1000.0", "v2.0.1000", "v2100.0.1", "v2.0.0-rc.1"])
      expect(() => androidVersionCode(version)).toThrow();
  });
});
