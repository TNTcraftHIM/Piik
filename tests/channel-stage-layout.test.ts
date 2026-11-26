import { expect, test } from "vitest";
import { stageColumns, stageLayout } from "../src/client/channel/stage-layout";

test("maximizes the contained picture after reserving source controls, without a source-count layout table", () => {
  expect(stageColumns(1541, 655, Array(3).fill(16 / 9), 14, 62, 280)).toBe(3);
  expect(stageColumns(1541, 655, Array(4).fill(16 / 9), 14, 62, 280)).toBe(2);
  expect(stageColumns(360, 80, Array(4).fill(16 / 9), 14, 54, 280)).toBe(1);
  expect(stageColumns(920, 400, [16 / 9], 14, 62, 280)).toBe(1);
  expect(stageColumns(1541, 655, [9 / 16, 16 / 9, 9 / 16, 16 / 9], 14, 62, 280)).toBe(4);
});

test("natural television rows must fit at their actual aspect ratio, independently of the previous layout", () => {
  const natural = { ratio: 16 / 9, insetX: 10, insetY: 14, minHeight: 160 };
  const sources = Array(3).fill(16 / 9);
  expect(stageColumns(966, 942, sources, 14, 2, 280)).toBe(1);
  expect(stageColumns(966, 942, sources, 14, 2, 280, natural)).toBe(2);
  expect(stageColumns(966, 726, sources, 14, 2, 280, natural)).toBe(2);
  expect(stageColumns(360, 700, sources, 14, 2, 280, natural)).toBe(1);
});

test("sizes each picture at its own aspect, with the column count that draws the most picture", () => {
  const one = stageLayout([16 / 9], 728, 560, 12, 40);
  expect(one.columns).toBe(1);
  expect(one.tiles[0].width).toBeCloseTo(728);
  expect(one.tiles[0].height).toBeCloseTo(409.5);
  // Height-bound: the picture keeps its aspect and is narrower than its cell.
  const short = stageLayout([16 / 9], 900, 300, 12, 40);
  expect(short.tiles[0].height).toBeCloseTo(260);
  expect(short.tiles[0].width).toBeCloseTo(260 * 16 / 9);
  expect(stageLayout(Array(2).fill(16 / 9), 728, 560, 12, 40).columns).toBe(1);
  expect(stageLayout(Array(2).fill(16 / 9), 1100, 560, 12, 40).columns).toBe(2);
  expect(stageLayout(Array(4).fill(16 / 9), 1100, 560, 12, 40).columns).toBe(2);
  const mixed = stageLayout([9 / 16, 16 / 9], 1100, 560, 12, 40);
  expect(mixed.columns).toBe(2);
  expect(mixed.tiles[0].width / mixed.tiles[0].height).toBeCloseTo(9 / 16);
  expect(mixed.tiles[1].width / mixed.tiles[1].height).toBeCloseTo(16 / 9);
  for (const tile of mixed.tiles) expect(tile.height).toBeLessThanOrEqual(520 + 1e-6);
});

test("an unbounded height stacks pictures at full width, and no room leaves empty tiles", () => {
  const stacked = stageLayout(Array(3).fill(16 / 9), 374, Infinity, 8, 36);
  expect(stacked.columns).toBe(1);
  expect(stacked.tiles.every(tile => Math.abs(tile.width - 374) < 1e-6)).toBe(true);
  expect(stageLayout([16 / 9], 0, 400, 12, 40).tiles[0]).toEqual({ width: 0, height: 0 });
  expect(stageLayout([], 800, 400, 12, 40)).toEqual({ columns: 1, rows: 0, tiles: [] });
});

test("a column narrower than the minimum is not considered", () => {
  expect(stageLayout(Array(4).fill(16 / 9), 600, 180, 12, 40).columns).toBe(4);
  const short = stageLayout(Array(4).fill(16 / 9), 600, 180, 12, 40, 160);
  expect(short.columns).toBe(2);
  expect(short.tiles[0].height).toBeCloseTo(44);
  expect(stageLayout([16 / 9], 120, 418, 12, 42, 160).columns).toBe(1);
});
