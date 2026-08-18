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
        ...restartRequest,
        targetPeerId: "parent_12345678",
      }).success,
    ).toBe(true);
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
  });

  it("accepts only a bounded quality profile update", () => {
    expect(
      clientMessageSchema.safeParse({
        type: "set-quality-profile",
        qualityProfileId: "1080p30",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "set-quality-profile",
        qualityProfileId: "1440p60",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "set-quality-profile",
        qualityProfileId: "1080p30",
        bitrate: 5_000_000,
      }).success,
    ).toBe(false);
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

  it("requires a complete bounded peer-assisted assignment", () => {
    const peerAssisted = {
      ...authenticatedMessage(8),
      mediaMode: "peer-assisted",
      mediaAssignment: {
        parentPeerId: null,
        childPeerIds: ["viewer_12345678", "viewer_87654321"],
      },
      qualityProfileId: "1080p60",
    };

    expect(serverMessageSchema.safeParse(peerAssisted).success).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        type: "media-assignment",
        mediaAssignment: peerAssisted.mediaAssignment,
      }).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        mediaMode: "peer-assisted",
        qualityProfileId: "1080p60",
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        mediaMode: "peer-assisted",
        mediaAssignment: peerAssisted.mediaAssignment,
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...peerAssisted,
        mediaAssignment: {
          parentPeerId: null,
          childPeerIds: [
            "viewer_12345678",
            "viewer_87654321",
            "viewer_overflow",
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...peerAssisted,
        qualityProfileId: "1440p60",
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        qualityProfileId: "1080p60",
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        type: "quality-profile",
        qualityProfileId: "720p30",
      }).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        type: "quality-profile",
        qualityProfileId: "1440p60",
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
