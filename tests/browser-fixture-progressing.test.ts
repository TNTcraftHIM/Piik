import { expect, test } from "vitest";
import { fixture } from "../prototype/channel-server/browser-fixture.mjs";

test("progressing requires new frames after replacing a prewarmed player", async () => {
  const sample = (id: string, frames: number, time: number) => ({
    received: true, live: true, elementId: id, trackObjectId: id, frames, time,
  });
  const samples = [sample("old", 10, 1), sample("new", 45, 4), sample("new", 45, 4), sample("new", 75, 7)];
  let index = 0;
  const { progressing } = fixture(async () => ({
    result: JSON.stringify(samples[Math.min(index++, samples.length - 1)]),
  }));

  expect(await progressing(0, "publication", undefined, 30)).toEqual(samples[3]);
  expect(index).toBe(4);
});
