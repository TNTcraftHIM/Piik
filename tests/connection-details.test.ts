import { describe, expect, it } from "vitest";

import {
  formatPacketLossPercent,
} from "../src/client/components/connection-details.ts";
describe("progressive connection details", () => {
  it("formats interval packet loss without inventing unknown values", () => {
    expect(formatPacketLossPercent(1.25, "未知")).toBe("1.3%");
    expect(formatPacketLossPercent(0, "未知")).toBe("0.0%");
    expect(formatPacketLossPercent(null, "未知")).toBe("未知");
    expect(formatPacketLossPercent(Number.NaN, "未知")).toBe("未知");
  });
});
