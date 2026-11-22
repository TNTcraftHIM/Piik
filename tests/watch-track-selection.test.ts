import { expect, test } from "vitest";
import { resolveWatchTrack } from "../src/client/channel/components/WatchIndexedTrackPicker";

test("a live catalog defaults only a unique track and retains an explicit track by ID", () => {
  const a = { id: "aac-a" }, b = { id: "aac-b" }, c = { id: "aac-c" };
  expect(resolveWatchTrack([a], null)).toBe(a);
  expect(resolveWatchTrack([a, b], null)).toBeUndefined();
  expect(resolveWatchTrack([c, { ...b }, a], b.id)).toEqual(b);
  expect(resolveWatchTrack([a], b.id)).toBeUndefined();
  expect(resolveWatchTrack([], b.id)).toBeUndefined();
});
