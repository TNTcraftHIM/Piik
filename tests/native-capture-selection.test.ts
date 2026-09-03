import { describe, expect, it } from "vitest";

import {
  selectNativeCaptureAdapter,
  selectNativeWindowTarget,
} from "../src/client/native/capture-selection";
import type {
  NativeAdapter,
  NativeWindowTarget,
} from "../src/client/native/wire";

function target(title: string, windowHandle: string): NativeWindowTarget {
  return {
    title,
    windowHandle,
    pid: 10,
    creationTime: "123456",
  };
}

describe("native capture window selection", () => {
  const game = target("My Game", "1");
  const chat = target("Friends", "2");
  const screener = target("Screener", "3");

  it("accepts only one unambiguous eligible window", () => {
    expect(selectNativeWindowTarget([screener, game], null)).toBe(game);
    expect(selectNativeWindowTarget([screener], null)).toBeNull();
    expect(selectNativeWindowTarget([game, chat], null)).toBeNull();
  });

  it("requires a requested title to resolve to exactly one window", () => {
    expect(selectNativeWindowTarget([game, chat], "My Game")).toBe(game);
    expect(selectNativeWindowTarget([game, chat], "Missing")).toBeNull();
    expect(
      selectNativeWindowTarget([game, target("My Game - Settings", "4")], "My Game"),
    ).toBeNull();
  });
});

describe("native adapter selection", () => {
  const adapters: NativeAdapter[] = [
    { index: 0, name: "GPU A", identity: "a", hardwareH264: [] },
    {
      index: 1,
      name: "GPU B",
      identity: "b",
      hardwareH264: [{ index: 0, name: "H264", identity: "encoder" }],
    },
  ];

  it("defaults only when no adapter was requested", () => {
    expect(selectNativeCaptureAdapter(adapters, null)).toBe(adapters[1]);
    expect(selectNativeCaptureAdapter(adapters, 0)).toBe(adapters[0]);
    expect(selectNativeCaptureAdapter(adapters, 2)).toBeNull();
  });
});
