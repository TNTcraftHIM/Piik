import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeClient } from "../src/client/native/client";

import {
  nativeEventSchema,
  nativeHealthSchema,
  nativeCaptureTargetSchema,
  shareStartedResponseSchema,
  shareUpdatedResponseSchema,
  sourcePreviewResponseSchema,
} from "../src/client/native/wire";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native Client private wire", () => {
  it("notifies the owner once on an unexpected close and stays silent on cleanup", async () => {
    const sockets: FakeWebSocket[] = [];
    const token = "a".repeat(43);
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      protocol = `screener-client-v6.${token}`;
      readonly close = vi.fn(() => {
        this.readyState = FakeWebSocket.CLOSING;
      });

      constructor(readonly url: string, readonly protocols: string[]) {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        const request = JSON.parse(payload) as { id: string; type: string };
        if (request.type !== "hello") return;
        queueMicrotask(() => {
          const event = new Event("message");
          Object.defineProperty(event, "data", {
            value: JSON.stringify({
              version: 6,
              id: request.id,
              type: "ready",
            }),
          });
          this.dispatchEvent(event);
        });
      }

      emitUnexpectedClose(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        protocol: 6,
        service: "screener-client",
        port: 39_721,
        instanceToken: token,
        nativeMedia: {
          video: true,
          processAudio: false,
          systemAudio: false,
          hardwareH264: true,
        },
      }), { status: 200 }),
    ));

    const client = await NativeClient.connect();
    expect(client).not.toBeNull();
    const unexpected = vi.fn();
    client!.onClose(unexpected);
    sockets[0]!.emitUnexpectedClose();
    sockets[0]!.emitUnexpectedClose();
    expect(unexpected).toHaveBeenCalledOnce();

    const cleanClient = await NativeClient.connect();
    expect(cleanClient).not.toBeNull();
    const intentional = vi.fn();
    cleanClient!.onClose(intentional);
    cleanClient!.close();
    sockets[1]!.emitUnexpectedClose();
    expect(intentional).not.toHaveBeenCalled();
  });

  it("keeps public discovery capability-only", () => {
    expect(
      nativeHealthSchema.parse({
        protocol: 6,
        service: "screener-client",
        port: 39_721,
        instanceToken: "a".repeat(43),
        nativeMedia: {
          video: true,
          processAudio: false,
          systemAudio: true,
          hardwareH264: true,
        },
      }),
    ).toMatchObject({ nativeMedia: { processAudio: false } });
    expect(
      nativeHealthSchema.safeParse({
        protocol: 6,
        service: "screener-client",
        port: 39_721,
        instanceToken: "a".repeat(43),
        nativeMedia: {
          video: true,
          processAudio: true,
          systemAudio: true,
          hardwareH264: true,
        },
        adapters: ["private"],
      }).success,
    ).toBe(false);
  });

  it("keeps 64-bit Windows identities as exact decimal strings", () => {
    expect(
      nativeCaptureTargetSchema.safeParse({
        kind: "window",
        sourceId: "12345678901234567890",
        pid: 1234,
        creationTime: "134327999999999999",
        title: "Game",
      }).success,
    ).toBe(true);
    expect(
      nativeCaptureTargetSchema.safeParse({
        kind: "window",
        sourceId: 12345678901234567890,
        pid: 1234,
        creationTime: 134327999999999999,
        title: "Game",
      }).success,
    ).toBe(false);
    expect(
      nativeCaptureTargetSchema.safeParse({
        kind: "display",
        sourceId: "65537",
        title: "Display 1",
      }).success,
    ).toBe(true);
  });

  it("fences native events by share and connection identity", () => {
    const event = {
      version: 6,
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

  it("keeps an unavailable preview advisory instead of treating it as media failure", () => {
    const preview = {
      version: 6,
      id: "request_preview",
      type: "source-preview",
      sourceKey: "display:65537",
      mime: "image/bmp",
      data: "",
    };
    expect(sourcePreviewResponseSchema.safeParse(preview).success).toBe(true);
  });

  it("keeps native share lifecycle responses as strict acknowledgements", () => {
    const profile = {
      resolution: "1440p",
      maxFramerate: 60,
      maxBitrate: 12_000_000,
      degradationPreference: "maintain-framerate",
      screenAudioQuality: "very-high",
    };
    expect(shareStartedResponseSchema.safeParse({
      version: 6,
      id: "request_start",
      type: "share-started",
      shareId: "share_123456",
      audio: true,
    }).success).toBe(true);
    expect(shareUpdatedResponseSchema.safeParse({
      version: 6,
      id: "request_update",
      type: "share-updated",
      shareId: "share_123456",
    }).success).toBe(true);
    expect(shareUpdatedResponseSchema.safeParse({
      version: 6,
      id: "request_update",
      type: "share-updated",
      shareId: "share_123456",
      profile,
    }).success).toBe(false);
  });

  it("accepts only internally consistent native quality evidence", () => {
    const event = {
      version: 6,
      type: "edge-quality",
      shareId: "share_123456",
      connectionId: "edge_1234567",
      sampleTimestampMs: 10_000,
      sampleWindowMs: 2_000,
      rtpStatsId: "pc_12345678",
      trackIdentifier: "screen",
      state: "degraded",
      reason: "bandwidth",
      intervalFramesEncoded: 60,
      framesPerSecond: 30,
      bitrateKbps: 3_000,
      availableOutgoingKbps: 1_000,
      width: 1280,
      height: 720,
    };
    expect(nativeEventSchema.safeParse(event).success).toBe(true);
    expect(
      nativeEventSchema.safeParse({ ...event, reason: "none" }).success,
    ).toBe(false);
  });
});
