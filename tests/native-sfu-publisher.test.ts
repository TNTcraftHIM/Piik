import { describe, expect, it, vi } from "vitest";
import { NativeSfuPublisher } from "../src/client/native/native-sfu-publisher";
import type { NativeClientEvent } from "../src/client/native/wire";
import type { SfuSignalMessage } from "../src/shared/protocol";

describe("Native SFU publication", () => {
  it("forwards existing Native media with exact identity and bounded signaling replay", async () => {
    const config = {
      revision: 3,
      publicationGeneration: "publication_generation",
      connectionId: "publication_connection",
    };
    let listener: ((event: NativeClientEvent) => void) | null = null;
    const emit = (event: NativeClientEvent) => listener?.(event);
    const media = {
      codec: "vp8" as const,
      layers: [
        { rid: "q", width: 320, height: 180, bitrate: 300_000 },
        { rid: "h", width: 640, height: 360, bitrate: 1_200_000 },
      ],
      audio: true,
      audioBitrate: 64_000,
    };
    const control = {
      preparePublication: vi.fn(async () => {
        emit({
          version: 9,
          type: "publication-candidate",
          shareId: "native_share",
          ...config,
          candidate: {
            candidate: "candidate:1 1 udp 1 127.0.0.1 1234 typ host",
          },
        });
        return {
          description: { type: "offer" as const, sdp: "v=0\r\n" },
          media,
        };
      }),
      publicationMedia: vi.fn(async () => media),
      acceptPublicationSignal: vi.fn(async () => undefined),
      closePublication: vi.fn(async () => undefined),
      onEvent: vi.fn((next: (event: NativeClientEvent) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      }),
    };
    const sent: SfuSignalMessage[] = [];
    let connected = false;
    const onDisconnected = vi.fn();
    const onStats = vi.fn();
    const publisher = new NativeSfuPublisher(
      control,
      "native_share",
      { iceServers: [] },
      {
        send: (message) => {
          if (!connected) return false;
          sent.push(message);
          return true;
        },
        onDisconnected,
        onStats,
      },
    );
    expect(await publisher.connect(config)).toBe(true);
    expect(await publisher.activate()).toBe(true);
    expect(sent).toEqual([]);
    connected = true;
    const routeSlot = { ...config, revision: 4, publisher };
    publisher.updateConfig(routeSlot);
    expect(sent.map(({ kind }) => kind)).toEqual(["description", "candidate"]);
    expect(sent[0]).toMatchObject({ revision: 4, media });
    expect(sent[0]).not.toHaveProperty("publisher");
    expect(() => JSON.stringify(sent)).not.toThrow();
    const demand: SfuSignalMessage = {
      type: "sfu-signal",
      ...config,
      kind: "layers",
      activeCount: 1,
    };
    await publisher.acceptSignal({
      ...demand,
      publicationGeneration: "stale_generation",
    });
    expect(control.acceptPublicationSignal).not.toHaveBeenCalled();
    await publisher.acceptSignal(demand);
    expect(control.acceptPublicationSignal).toHaveBeenCalledWith(
      "native_share",
      demand,
    );
    expect(await publisher.updateProfile()).toBe(true);
    expect(sent.at(-1)).toMatchObject({ kind: "media", media });
    emit({
      version: 9,
      type: "publication-quality",
      shareId: "native_share",
      ...config,
      sampleTimestampMs: 12_000,
      sampleWindowMs: 2_000,
      rtpStatsId: "native_rtp_stats",
      trackIdentifier: "screen",
      codec: "vp8",
      videoEncodingCount: 2,
      activeVideoEncodingCount: 2,
      rid: "h",
      intervalFramesSent: 30,
      framesPerSecond: 15,
      width: 640,
      height: 360,
      bitrateKbps: 1200,
      audioBitrateKbps: 64,
      availableOutgoingKbps: 1600,
      state: "healthy",
      reason: "none",
    });
    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({
        framesPerSecond: 15,
        activeVideoEncodingCount: 2,
        bitrateKbps: 1200,
        intervalFramesSent: 30,
        intervalFramesEncoded: null,
        intervalEncodeMs: null,
        captureFramesPerSecond: null,
        frameWidth: 640,
        frameHeight: 360,
      }),
    );
    emit({
      version: 9,
      type: "publication-state",
      shareId: "native_share",
      ...config,
      state: "failed",
    });
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(control.closePublication).toHaveBeenCalledWith(
      "native_share",
      config.publicationGeneration,
      config.connectionId,
    );
    await publisher.disconnect();
    expect(control.closePublication).toHaveBeenCalledOnce();
  });
});
