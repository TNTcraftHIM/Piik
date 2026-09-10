import { describe, expect, it } from "vitest";

import {
  CLIENT_PACKAGE_TARGETS,
  clientGoEnvironment,
} from "../scripts/client-package-targets.mjs";

describe("client package targets", () => {
  it("derives build and license discovery from one explicit cgo policy", () => {
    const previous = process.env.CGO_ENABLED;
    try {
      process.env.CGO_ENABLED = "unexpected-inherited-value";
      const settings = CLIENT_PACKAGE_TARGETS.map((target) => {
        const env = clientGoEnvironment(target);
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
        ["darwin-arm64", "darwin", "arm64", "1"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.CGO_ENABLED;
      else process.env.CGO_ENABLED = previous;
    }
  });
});
