import { describe, expect, it } from "vitest";
import { participantMotion, participantMotionPhase } from "../src/client/components/living/participant-motion";

describe("participant gestures", () => {
  const identity = "779594c8-a92c-48d9-918f-a7d0befa46d1";
  it("joins the same UUID's current gesture after a later mount or full cycle", () => {
    const now = 1_800_000_000_000;
    const { duration } = participantMotion(identity);
    const firstView = participantMotionPhase(identity, now);
    const laterView = participantMotionPhase(identity, now + 1357);
    expect(laterView).toBe((firstView + 1357) % duration);
    expect(participantMotionPhase(identity, now + duration * 100)).toBe(firstView);
  });

  it("spreads a full roster across independent, quiet cadences", () => {
    const roster = Array.from({ length: 21 }, (_, index) => participantMotion(`b59ad8e2-30d1-4a67-a01c-${String(index).padStart(12, "0")}`));
    expect(new Set(roster.map(({ duration, offset }) => `${duration}:${offset}`)).size).toBe(21);
    expect(roster.every(({ duration, lean, gaze }) => duration >= 42_000 && duration <= 59_002
      && Math.abs(lean) <= 3 && Math.abs(gaze) <= 1.5)).toBe(true);
    const phases = roster.map(({ duration, offset }) => ((1_800_000_000_000 + offset) % duration) / duration);
    expect(new Set(phases.map((phase) => Math.floor(phase * 10))).size).toBeGreaterThanOrEqual(7);
  });
});
