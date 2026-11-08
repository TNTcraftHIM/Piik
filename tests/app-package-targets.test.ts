import { describe, expect, it } from "vitest";

import { androidVersionCode } from "../scripts/app-package-targets.mjs";
import { writeAppPlatformAssets } from "../scripts/app-icons.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("App package targets", () => {
  it("keeps macOS numeric bundle versions separate from the complete candidate identity", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "piik-mac-version-"));
    const options = { packageRoot, target: { goos: "darwin" }, revision: "a".repeat(40), iconPath: "cmd/piik-app/piik.ico" };
    try {
      for (const [version, numeric] of [["development", "0.0.0"], ["v3.0.0", "3.0.0"], ["v3.0.0-beta.4", "3.0.0"]]) {
        writeAppPlatformAssets({ ...options, version });
        const plist = readFileSync(join(packageRoot, "Piik App.app/Contents/Info.plist"), "utf8");
        expect(plist).toContain(`<key>CFBundleVersion</key><string>${numeric}</string>`);
        expect(plist).toContain(`<key>CFBundleShortVersionString</key><string>${numeric}</string>`);
        expect(plist).toContain(`<key>PiikProductVersion</key><string>${version}</string>`);
      }
      for (const version of ["v3.0.0-beta.04", "v3.0.0-", "3.0.0-beta.4"])
        expect(() => writeAppPlatformAssets({ ...options, version })).toThrow("valid build version");
    } finally { rmSync(packageRoot, { recursive: true, force: true }); }
  });
  it("derives monotonically ordered Android codes from the product version", () => {
    expect(["development", "v0.0.1", "v2.0.9", "v2.1.0", "v3.0.0", "v2100.0.0"].map(androidVersionCode))
      .toEqual([1, 1, 2_000_009, 2_001_000, 3_000_000, 2_100_000_000]);
    expect(["v3.0.0-beta.4", "v3.0.0-beta.5", "v3.0.0-rc.1"].map(androidVersionCode)).toEqual([3_000_000, 3_000_000, 3_000_000]);
    for (const version of ["v0.0.0", "v2.1000.0", "v2.0.1000", "v2100.0.1", "v3.0.0-beta.04", "v3.0.0-", "3.0.0-beta.4", "v3.0.0-beta.4+build"])
      expect(() => androidVersionCode(version)).toThrow();
  });
});
