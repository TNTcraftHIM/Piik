import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bash =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      ].find(existsSync)
    : "/bin/bash";
const testWithBash = bash && existsSync(bash) ? it : it.skip;

describe("application release recovery", () => {
  testWithBash("removes only the unactivated release owned by this run", () => {
    const script = fileURLToPath(
      new URL("./release-app-recovery.sh", import.meta.url),
    );
    const result = spawnSync(bash!, [script], { encoding: "utf8" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
