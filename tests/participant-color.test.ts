import { describe, expect, it } from "vitest";
import { participantColor } from "../src/client/components/living/participant-color";

describe("participant identity colours", () => {
  it("keeps identity colours valid in sRGB and independent of roster order", () => {
    const ids = [
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000008",
      "00000000-0000-4000-8000-000000000011",
      "participant-1", // Its assigned OKLCH colour is outside sRGB.
    ];
    const colours = ids.map(participantColor);
    expect(new Set(colours).size).toBe(ids.length);
    for (const colour of colours) {
      expect(colour).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
      const channels = colour.match(/\d+/g)!.map(Number);
      expect(channels.every(channel => channel >= 0 && channel <= 255)).toBe(true);
      expect(channels.some(channel => channel > 0)).toBe(true);
    }
    expect(ids.toReversed().map(participantColor)).toEqual(colours.toReversed());
  });
});
