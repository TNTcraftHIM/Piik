import { describe, expect, it } from "vitest";

import {
  defaultNativeCapturePath,
  nativeCaptureTargetKey,
} from "../src/client/native/capture-selection";
import type {
  NativeAdapter,
  NativeCaptureTarget,
} from "../src/client/native/wire";

function target(
  title: string,
  sourceId: string,
): Extract<NativeCaptureTarget, { kind: "window" }> {
  return {
    kind: "window",
    title,
    sourceId,
    pid: 10,
    creationTime: "123456",
  };
}

describe("native capture source selection", () => {
  const game = target("My Game", "1");

  it("uses the complete window identity as the UI key", () => {
    expect(nativeCaptureTargetKey(game)).toBe("window:1:10:123456");
    expect(
      nativeCaptureTargetKey({ ...game, creationTime: "654321" }),
    ).not.toBe(nativeCaptureTargetKey(game));
    expect(
      nativeCaptureTargetKey({
        kind: "display",
        sourceId: "2",
        title: "Display 1",
      }),
    ).toBe("display:2");
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

  it("selects the first complete hardware path for UI capture", () => {
    expect(defaultNativeCapturePath(adapters)).toEqual({
      adapterIndex: 1,
      encoderIndex: 0,
    });
    expect(defaultNativeCapturePath([adapters[0]!])).toBeNull();
  });
});
