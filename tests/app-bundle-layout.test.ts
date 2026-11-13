import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { assertAppBundleLayout, collectAppBundleLayout } from "../scripts/app-bundle-layout.mjs";
import { appPackageTarget } from "../scripts/app-package-targets.mjs";

function fixture() {
  const temporaryRoot = resolve("build", "bundle-layout-tests");
  mkdirSync(temporaryRoot, { recursive: true });
  return mkdtempSync(join(temporaryRoot, "package-"));
}

describe("App bundle layout", () => {
  it("embeds the complete deterministic package tree and detects later changes", () => {
    const root = fixture();
    const entrypoint = appPackageTarget("windows-amd64")!.appName;
    try {
      mkdirSync(join(root, "web", "empty"), { recursive: true });
      writeFileSync(join(root, "web", ".hidden"), "hidden resource");
      writeFileSync(join(root, "web", "index.html"), "web");
      writeFileSync(join(root, "REVISION"), "a".repeat(40));
      const layout = collectAppBundleLayout(root, entrypoint, { pendingEntrypoint: true });
      expect(layout).toEqual({ schema: 1, entrypoint, entries: [
        { path: "REVISION", kind: "file" },
        { path: entrypoint, kind: "file" },
        { path: "web", kind: "directory" },
        { path: "web/.hidden", kind: "file" },
        { path: "web/empty", kind: "directory" },
        { path: "web/index.html", kind: "file" },
      ] });
      expect(JSON.stringify(layout)).not.toContain(root);
      expect(() => assertAppBundleLayout(root, layout)).toThrow("entrypoint must be a file");
      writeFileSync(join(root, entrypoint), "executable");
      expect(() => assertAppBundleLayout(root, layout)).not.toThrow();
      writeFileSync(join(root, ".extra"), "late resource");
      expect(() => assertAppBundleLayout(root, layout)).toThrow("entries changed");
      rmSync(join(root, ".extra"));
      rmSync(join(root, "web", ".hidden"));
      expect(() => assertAppBundleLayout(root, layout)).toThrow("entries changed");
      rmSync(join(root, entrypoint));
      mkdirSync(join(root, entrypoint));
      expect(() => collectAppBundleLayout(root, entrypoint, { pendingEntrypoint: true }))
        .toThrow("entrypoint must be a file");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects directory links without following them outside the package", () => {
    const root = fixture();
    const outside = fixture();
    try {
      writeFileSync(join(outside, "private.txt"), "not bundled");
      symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      expect(() => collectAppBundleLayout(root, "piik-app.exe", { pendingEntrypoint: true }))
        .toThrow("must not contain links");
      expect(() => collectAppBundleLayout(join(root, "linked"), "piik-app.exe", { pendingEntrypoint: true }))
        .toThrow("must not contain links");
      if (process.platform !== "win32") {
        rmSync(join(root, "linked"));
        symlinkSync(join(outside, "private.txt"), join(root, "file-link"));
        expect(() => collectAppBundleLayout(root, "piik-app.exe", { pendingEntrypoint: true }))
          .toThrow("must not contain links");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
