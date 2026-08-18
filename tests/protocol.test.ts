import { describe, expect, it } from "vitest";

import {
  MAX_VIEWERS_PER_ROOM_LIMIT,
  clientMessageSchema,
  decodeClientMessage,
  serverMessageSchema,
} from "../src/shared/protocol.js";

const token = "a".repeat(43);
const roomId = "123456789012";

describe("client signaling protocol", () => {
  it("accepts a bounded authentication message", () => {
    expect(
      decodeClientMessage(
        JSON.stringify({
          type: "authenticate",
          roomId,
          role: "viewer",
          clientId: "client_12345678",
        }),
      ),
    ).toMatchObject({ type: "authenticate", role: "viewer" });
  });

  it("rejects unknown fields and malformed tokens", () => {
    const result = clientMessageSchema.safeParse({
      type: "authenticate",
      roomId,
      role: "host",
      token: "short",
      clientId: "client_12345678",
      admin: true,
  });

    expect(result.success).toBe(false);
  });

  it("requires a host token and rejects viewer tokens or malformed room codes", () => {
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        roomId,
        role: "host",
        token,
        clientId: "client_12345678",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        roomId,
        role: "viewer",
        token,
        clientId: "client_12345678",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        roomId: "1",
        role: "viewer",
        clientId: "client_12345678",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        roomId: "0123",
        role: "viewer",
        clientId: "client_12345678",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        roomId: "1".repeat(13),
        role: "viewer",
        clientId: "client_12345678",
      }).success,
    ).toBe(false);
  });

  it("bounds SDP before routing it", () => {
    const result = clientMessageSchema.safeParse({
      type: "signal",
      targetPeerId: "viewer_12345678",
      payload: {
        kind: "description",
        connectionId: "connection_12345678",
        description: {
          type: "offer",
          sdp: "v".repeat(48 * 1024 + 1),
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("requires viewers to choose ICE restart or peer rebuild explicitly", () => {
    const restartRequest = {
      type: "restart-request",
      connectionId: "connection_12345678",
      rebuild: true,
    };

    expect(clientMessageSchema.safeParse(restartRequest).success).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: restartRequest.type,
        connectionId: restartRequest.connectionId,
      }).success,
    ).toBe(false);
  });

  it("accepts explicit and legacy sharing-stop messages", () => {
    expect(clientMessageSchema.safeParse({ type: "stop-sharing" }).success).toBe(
      true,
    );
    expect(clientMessageSchema.safeParse({ type: "close-room" }).success).toBe(
      true,
    );
    expect(clientMessageSchema.safeParse({ type: "abandon-room" }).success).toBe(
      true,
    );
    expect(clientMessageSchema.safeParse({ type: "refresh-sfu" }).success).toBe(
      true,
    );
  });
});

describe("server signaling protocol", () => {
  function authenticatedMessage(maxViewers: number, viewerPeerIds: string[] = []) {
    return {
      type: "authenticated",
      role: "host",
      peerId: "host_12345678",
      roomExpiresAt: "2026-08-18T18:00:00.000Z",
      maxViewers,
      hostOnline: true,
      connectionId: null,
      viewerPeerIds,
      mediaMode: "p2p",
      iceConfig: {
        iceServers: [],
        expiresAt: null,
        relayAvailable: false,
      },
    };
  }

  it("accepts dynamic viewer limits within the protocol boundary", () => {
    expect(serverMessageSchema.safeParse(authenticatedMessage(1)).success).toBe(
      true,
    );
    expect(serverMessageSchema.safeParse(authenticatedMessage(8)).success).toBe(
      true,
    );
    expect(
      serverMessageSchema.safeParse(
        authenticatedMessage(MAX_VIEWERS_PER_ROOM_LIMIT),
      ).success,
    ).toBe(true);
  });

  it("represents persistent rooms without a room expiry", () => {
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        roomExpiresAt: null,
      }).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({ type: "sharing-stopped" }).success,
    ).toBe(true);
  });

  it("uses distinct P2P and SFU authentication payloads", () => {
    const p2p = authenticatedMessage(8);
    expect(serverMessageSchema.safeParse(p2p).success).toBe(true);
    const { mediaMode: _mediaMode, ...legacyP2p } = p2p;
    expect(serverMessageSchema.safeParse(legacyP2p).success).toBe(true);
    expect(
      serverMessageSchema.safeParse({ ...p2p, iceConfig: undefined }).success,
    ).toBe(false);

    const { iceConfig: _iceConfig, ...common } = p2p;
    const sfu = { ...common, mediaMode: "sfu" };
    expect(serverMessageSchema.safeParse(sfu).success).toBe(true);
    expect(
      serverMessageSchema.safeParse({ ...sfu, iceConfig: p2p.iceConfig }).success,
    ).toBe(false);
  });

  it("accepts a bounded SFU connection configuration", () => {
    expect(
      serverMessageSchema.safeParse({
        type: "sfu-config",
        url: "wss://livekit.example.test",
        token: "header.payload.signature",
      }).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        type: "sfu-config",
        url: "not-a-url",
        token: "header.payload.signature",
      }).success,
    ).toBe(false);
  });

  it.each([0, 1.5, MAX_VIEWERS_PER_ROOM_LIMIT + 1])(
    "rejects viewer limit %s outside the protocol boundary",
    (maxViewers) => {
      expect(
        serverMessageSchema.safeParse(authenticatedMessage(maxViewers)).success,
      ).toBe(false);
    },
  );

  it("bounds authenticated viewer rosters independently of configured capacity", () => {
    const viewerPeerIds = Array.from(
      { length: MAX_VIEWERS_PER_ROOM_LIMIT },
      (_, index) => `viewer_${index.toString().padStart(8, "0")}`,
    );

    expect(
      serverMessageSchema.safeParse(
        authenticatedMessage(MAX_VIEWERS_PER_ROOM_LIMIT, viewerPeerIds),
      ).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse(
        authenticatedMessage(MAX_VIEWERS_PER_ROOM_LIMIT, [
          ...viewerPeerIds,
          "viewer_overflow",
        ]),
      ).success,
    ).toBe(false);
  });
});
