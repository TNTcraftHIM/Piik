import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { createZip, extractZip } from "../scripts/archive-tool.mjs";

describe("App ZIP distribution", () => {
  it("round-trips hidden files, spaced paths and executable permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-archive-"));
    try {
      const source = join(root, "assembled app");
      const extracted = join(root, "extracted app");
      const archive = join(root, "Piik App.zip");
      const files = {
        "piik-app": "#!/bin/sh\nexit 0\n",
        "Piik App.app/Contents/MacOS/launcher": "#!/bin/sh\nexit 0\n",
        "runtime/.native/画面.txt": "Native capture\n",
        ".release-metadata": "Hidden metadata\n",
      };
      for (const [name, content] of Object.entries(files)) {
        const path = join(source, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      const executables = ["piik-app", "Piik App.app/Contents/MacOS/launcher"];
      for (const name of executables) chmodSync(join(source, name), 0o755);
      createZip(source, archive);
      expect(readFileSync(archive).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      mkdirSync(extracted);
      extractZip(archive, extracted);
      expect(readdirSync(extracted, { recursive: true }).sort()).toEqual(
        readdirSync(source, { recursive: true }).sort(),
      );
      for (const [name, content] of Object.entries(files)) {
        expect(readFileSync(join(extracted, name), "utf8")).toBe(content);
      }
      if (process.platform !== "win32") {
        for (const name of executables) {
          expect(statSync(join(extracted, name)).mode & 0o777).toBe(0o755);
          execFileSync(join(extracted, name), [], { cwd: extracted });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
