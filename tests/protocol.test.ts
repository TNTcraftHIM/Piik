import { describe, expect, it } from "vitest";

import {
  MAX_VIEWERS,
  clientMessageSchema,
  decodeClientMessage,
  serverMessageSchema,
} from "../src/shared/protocol.js";

const token = "a".repeat(43);

describe("client signaling protocol", () => {
  it("accepts a bounded authentication message", () => {
    expect(
      decodeClientMessage(
        JSON.stringify({
          type: "authenticate",
          roomId: "room_12345678",
          role: "viewer",
          token,
          clientId: "client_12345678",
        }),
      ),
    ).toMatchObject({ type: "authenticate", role: "viewer" });
  });

  it("rejects unknown fields and malformed tokens", () => {
    const result = clientMessageSchema.safeParse({
      type: "authenticate",
      roomId: "room_12345678",
      role: "host",
      token: "short",
      clientId: "client_12345678",
      admin: true,
    });

    expect(result.success).toBe(false);
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
});

describe("server signaling protocol", () => {
  it("keeps the viewer limit in the wire contract", () => {
    const result = serverMessageSchema.safeParse({
      type: "authenticated",
      role: "host",
      peerId: "host_12345678",
      roomExpiresAt: "2026-08-18T18:00:00.000Z",
      maxViewers: MAX_VIEWERS,
      hostOnline: true,
      connectionId: null,
      viewerPeerIds: [],
      iceConfig: {
        iceServers: [],
        expiresAt: null,
        relayAvailable: false,
      },
    });

    expect(result.success).toBe(true);
  });
});
