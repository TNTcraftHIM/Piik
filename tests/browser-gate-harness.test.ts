import { expect, it } from "vitest";
import { join } from "node:path";
import { launchChrome } from "../scripts/browser-gate-harness";

it("reports a missing browser executable through awaited startup", async () => {
  await expect(launchChrome(join(import.meta.dirname, "missing-browser.exe"), 9222,
    join(import.meta.dirname, "unused-profile"))).rejects.toMatchObject({ code: "ENOENT" });
});
