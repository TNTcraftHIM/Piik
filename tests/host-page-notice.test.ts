import { describe, expect, it } from "vitest";
import { shouldPauseLocalPreview } from "../src/client/components/living/use-host-preview-playback";

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
