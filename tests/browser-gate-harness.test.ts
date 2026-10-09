import { expect, it } from "vitest";
import { join } from "node:path";
import { launchChrome } from "../scripts/browser-gate-harness";
import { parseVideoGateSize } from "../scripts/media-gate-geometry";

it("accepts bounded numeric gate sizes and rejects malformed or oversized sources", () => {
  expect(parseVideoGateSize("3840x2160")).toEqual({ width: 3840, height: 2160 });
  expect(parseVideoGateSize("2160x3840")).toEqual({ width: 2160, height: 3840 });
  expect(parseVideoGateSize("960x600")).toEqual({ width: 960, height: 600 });
  for (const value of ["", "1920", "1920x1080x2", "4.5x4", "0x1080", "1921x1080", "3840x3840", "8192x8192"]) {
    expect(() => parseVideoGateSize(value)).toThrow("30 fps capture limits");
  }
});

it("reports a missing browser executable through awaited startup", async () => {
  await expect(launchChrome(join(import.meta.dirname, "missing-browser.exe"), 9222,
    join(import.meta.dirname, "unused-profile"))).rejects.toMatchObject({ code: "ENOENT" });
});
