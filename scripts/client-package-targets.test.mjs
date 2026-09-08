import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_PACKAGE_TARGETS, clientGoEnvironment } from "./client-package-targets.mjs";

test("build and license discovery use the same explicit target cgo policy", () => {
  const previous = process.env.CGO_ENABLED;
  try {
    process.env.CGO_ENABLED = "unexpected-inherited-value";
    const settings = CLIENT_PACKAGE_TARGETS.map((target) => {
      const env = clientGoEnvironment(target);
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
      if (pathKey) assert.equal(env[pathKey], process.env[pathKey]);
      assert.equal(process.env.CGO_ENABLED, "unexpected-inherited-value");
      return [target.id, env.GOOS, env.GOARCH, env.CGO_ENABLED];
    });
    assert.deepEqual(settings, [
      ["windows-amd64", "windows", "amd64", "0"],
      ["linux-amd64", "linux", "amd64", "0"],
      ["darwin-arm64", "darwin", "arm64", "1"],
    ]);
  } finally {
    if (previous === undefined) delete process.env.CGO_ENABLED;
    else process.env.CGO_ENABLED = previous;
  }
});
