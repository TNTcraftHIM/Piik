import { describe, expect, it } from "vitest";
import { hostFailureChecks } from "../src/client/pages/host-page-notices";
import { shouldPauseLocalPreview } from "../src/client/components/living/use-host-preview-playback";

describe("sharing troubleshooting", () => {
  it.each([
    ["site/http-403", ["shareHelp.site"]],
    ["room/unknown", ["shareHelp.site"]],
    ["app/start-share/rejected", ["shareHelp.source", "shareHelp.compare"]],
    ["app/start-share/timeout", ["shareHelp.appConnection"]],
    ["app/control/disconnected", ["shareHelp.appConnection"]],
    ["app/prepare-edge/disconnected", ["shareHelp.appConnection"]],
    ["app/prepare-edge/rejected", ["shareHelp.mediaConnection"]],
    ["app/browser-media/connection", ["shareHelp.mediaConnection"]],
    ["app/capture/failed", ["shareHelp.source", "shareHelp.compare"]],
    ["browser/NotAllowedError", ["shareHelp.permission"]],
    ["browser/NotReadableError", ["shareHelp.source"]],
    ["camera/NotAllowedError", ["shareHelp.camera"]],
    ["status/unknown", []],
    ["connection/unknown", []],
    ["quality/unknown", []],
    ["app/update-share/rejected", []],
  ])("keeps troubleshooting relevant to %s", (code, checks) => {
    expect(hostFailureChecks(code as string)).toEqual(checks);
  });
});

describe("shouldPauseLocalPreview", () => {
  it("distinguishes local preview suspension from active focus", () => {
    expect(shouldPauseLocalPreview("hidden", true)).toBe(true);
    expect(shouldPauseLocalPreview("visible", false)).toBe(true);
    expect(shouldPauseLocalPreview("visible", true)).toBe(false);
    expect(shouldPauseLocalPreview("hidden", false, true)).toBe(false);
    expect(shouldPauseLocalPreview("visible", false, false, false)).toBe(false);
    expect(shouldPauseLocalPreview("hidden", false, false, false)).toBe(false);
  });
});
