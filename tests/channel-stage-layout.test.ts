import { expect, test } from "vitest";
import { fittedStage } from "../src/client/channel/stage-layout";

test("maximizes the contained picture after reserving source controls, without a source-count layout table", () => {
  expect(fittedStage(1541, 655, Array(3).fill(16 / 9), 14, 62, 280, 160).columns).toBe(3);
  expect(fittedStage(1541, 655, Array(4).fill(16 / 9), 14, 62, 280, 160).columns).toBe(2);
  expect(fittedStage(360, 80, Array(4).fill(16 / 9), 14, 54, 280, 160).columns).toBe(1);
  expect(fittedStage(920, 400, [16 / 9], 14, 62, 280, 160).columns).toBe(1);
  expect(fittedStage(1541, 655, [9 / 16, 16 / 9, 9 / 16, 16 / 9], 14, 62, 280, 160).columns).toBe(4);
});

test("keeps pictures usable when the stage needs to scroll", () => {
  const ratios = Array(8).fill(16 / 9);
  const short = fittedStage(500, 121, ratios, 12, 40, 200, 160);
  expect(short.columns).toBe(2);
  expect(short.tiles).toEqual(Array(8).fill({ width: 244, height: 160 }));

  const wide = fittedStage(1500, 121, ratios, 12, 40, 200, 160);
  expect(wide.columns).toBe(4);
  expect(wide.tiles).toHaveLength(8);
  for (const tile of wide.tiles) {
    expect(tile.width).toBeCloseTo(160 * 16 / 9);
    expect(tile.height).toBeCloseTo(160);
  }

  const phone = fittedStage(390, 550, ratios, 4, 36, 200, 160);
  expect(phone.columns).toBe(1);
  expect(phone.tiles.every(tile => tile.width >= 200 && tile.height >= 160)).toBe(true);
});
