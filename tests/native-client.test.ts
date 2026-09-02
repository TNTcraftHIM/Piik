import { describe, expect, it } from "vitest";

import {
  nativeEventSchema,
  nativeHealthSchema,
  nativeWindowTargetSchema,
} from "../src/client/native/wire";

describe("native Client private wire", () => {
  it("keeps public discovery capability-only", () => {
    expect(
      nativeHealthSchema.parse({
        protocol: 2,
        service: "screener-client",
        port: 39_721,
        instanceToken: "a".repeat(43),
        nativeMedia: {
          windowVideo: true,
          processAudio: false,
          hardwareH264: true,
        },
      }),
    ).toMatchObject({ nativeMedia: { processAudio: false } });
    expect(
      nativeHealthSchema.safeParse({
        protocol: 2,
        service: "screener-client",
        port: 39_721,
        instanceToken: "a".repeat(43),
        nativeMedia: {
          windowVideo: true,
          processAudio: true,
          hardwareH264: true,
        },
        adapters: ["private"],
      }).success,
    ).toBe(false);
  });

  it("keeps 64-bit Windows identities as exact decimal strings", () => {
    expect(
      nativeWindowTargetSchema.safeParse({
        windowHandle: "12345678901234567890",
        pid: 1234,
        creationTime: "134327999999999999",
        title: "Game",
      }).success,
    ).toBe(true);
    expect(
      nativeWindowTargetSchema.safeParse({
        windowHandle: 12345678901234567890,
        pid: 1234,
        creationTime: 134327999999999999,
        title: "Game",
      }).success,
    ).toBe(false);
  });

  it("fences native events by share and connection identity", () => {
    const event = {
      version: 2,
      type: "edge-state",
      shareId: "share_123456",
      connectionId: "edge_1234567",
      state: "connected",
    };
    expect(nativeEventSchema.safeParse(event).success).toBe(true);
    expect(
      nativeEventSchema.safeParse({ ...event, connectionId: "short" }).success,
    ).toBe(false);
    expect(
      nativeEventSchema.safeParse({ ...event, routeRevision: 1 }).success,
    ).toBe(false);
  });
});
