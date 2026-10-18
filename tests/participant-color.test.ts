import { describe, expect, it } from "vitest";
import { participantColor } from "../src/client/components/living/participant-color";

describe("participant identity colours", () => {
  it("separates identities that collided in the eight-colour palette, independently of roster order", () => {
    const ids = [
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000008",
      "00000000-0000-4000-8000-000000000011",
    ];
    const colours = ids.map(participantColor);
    expect(new Set(colours).size).toBe(ids.length);
    const hues = colours.map(colour => Number(colour.slice(colour.lastIndexOf(" ") + 1, -1))).sort((a, b) => a - b);
    expect(Math.min(hues[1]! - hues[0]!, hues[2]! - hues[1]!)).toBeGreaterThan(15);
    expect(ids.toReversed().map(participantColor)).toEqual(colours.toReversed());
  });
});
