import { expect, test } from "vitest";
import { stageColumns } from "../src/client/channel/stage-layout";

test("maximizes the contained picture after reserving source controls, without a source-count layout table", () => {
  expect(stageColumns(1541, 655, Array(3).fill(16 / 9), 14, 62, 280)).toBe(3);
  expect(stageColumns(1541, 655, Array(4).fill(16 / 9), 14, 62, 280)).toBe(2);
  expect(stageColumns(360, 80, Array(4).fill(16 / 9), 14, 54, 280)).toBe(1);
  expect(stageColumns(920, 400, [16 / 9], 14, 62, 280)).toBe(1);
  expect(stageColumns(1541, 655, [9 / 16, 16 / 9, 9 / 16, 16 / 9], 14, 62, 280)).toBe(4);
});
