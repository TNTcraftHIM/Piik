import { expect, test } from "vitest";
import { stageColumns } from "../src/client/channel/stage-layout";

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
