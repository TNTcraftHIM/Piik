import { describe, expect, it } from "vitest";

import {
  APP_PACKAGE_TARGETS,
  androidVersionCode,
  goBuildEnvironment,
} from "../scripts/app-package-targets.mjs";

describe("App package targets", () => {
  it("derives monotonically ordered Android codes from the product version", () => {
    expect(["development", "v0.0.1", "v2.0.9", "v2.1.0", "v3.0.0", "v2100.0.0"].map(androidVersionCode))
      .toEqual([1, 1, 2_000_009, 2_001_000, 3_000_000, 2_100_000_000]);
    for (const version of ["v0.0.0", "v2.1000.0", "v2.0.1000", "v2100.0.1", "v2.0.0-rc.1"])
      expect(() => androidVersionCode(version)).toThrow();
  });
  it("derives build and license discovery from one explicit cgo policy", () => {
    const previous = process.env.CGO_ENABLED;
    try {
      process.env.CGO_ENABLED = "unexpected-inherited-value";
      const settings = APP_PACKAGE_TARGETS.map((target) => {
        const env = goBuildEnvironment(target);
        const pathKey = Object.keys(process.env).find(
          (key) => key.toLowerCase() === "path",
        );
        // Ambient entries survive; only OS, architecture and cgo are explicit.
        if (pathKey) {
          expect(Object.entries(env)).toContainEqual([
            pathKey,
            process.env[pathKey],
          ]);
        }
        expect(process.env.CGO_ENABLED).toBe("unexpected-inherited-value");
        return [target.id, env.GOOS, env.GOARCH, env.CGO_ENABLED];
      });
      expect(settings).toEqual([
        ["windows-amd64", "windows", "amd64", "0"],
        ["linux-amd64", "linux", "amd64", "0"],
        ["linux-arm64", "linux", "arm64", "0"],
        ["darwin-arm64", "darwin", "arm64", "1"],
        ["darwin-amd64", "darwin", "amd64", "1"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.CGO_ENABLED;
      else process.env.CGO_ENABLED = previous;
    }
  });
});
