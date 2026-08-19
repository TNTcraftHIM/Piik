import { describe, expect, it } from "vitest";

import {
  MAX_MEDIA_ROUTE_REVISION,
  MAX_SFU_TOKEN_LENGTH,
  MAX_VIEWERS_PER_ROOM_LIMIT,
  clientMessageSchema,
  decodeClientMessage,
  participantRouteAssignmentSchema,
  serverMessageSchema,
} from "../src/shared/protocol.js";

const token = "a".repeat(43);
const roomId = "123456789012";
const qualitySettings = {
  resolution: "1080p",
  maxFramerate: 60,
  maxBitrate: 8_000_000,
  degradationPreference: "maintain-resolution",
} as const;

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
    expect(
      clientMessageSchema.safeParse({
        type: "stop-sharing",
        shareGeneration: "share_generation_12345678",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        roomId,
        role: "host",
        token,
        clientId: "client_12345678",
        shareGeneration: "share_generation_12345678",
      }).success,
    ).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "close-room" }).success).toBe(
      true,
    );
    expect(clientMessageSchema.safeParse({ type: "abandon-room" }).success).toBe(
      true,
    );
  });

  it("accepts only strict, bounded quality settings", () => {
    expect(
      clientMessageSchema.safeParse({
        type: "set-quality-settings",
        qualitySettings,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...qualitySettings, resolution: "2160p" },
      { ...qualitySettings, maxFramerate: 14 },
      { ...qualitySettings, maxFramerate: 61 },
      { ...qualitySettings, maxFramerate: 30.5 },
      { ...qualitySettings, maxBitrate: 1_999_999 },
      { ...qualitySettings, maxBitrate: 12_000_001 },
      { ...qualitySettings, maxBitrate: 5_000_000.5 },
      { ...qualitySettings, degradationPreference: "automatic" },
      { ...qualitySettings, codec: "video/VP9" },
    ]) {
      expect(
        clientMessageSchema.safeParse({
          type: "set-quality-settings",
          qualitySettings: invalid,
        }).success,
      ).toBe(false);
    }
    const { maxFramerate: _missing, ...missingField } = qualitySettings;
    expect(
      clientMessageSchema.safeParse({
        type: "set-quality-settings",
        qualitySettings: missingField,
      }).success,
    ).toBe(false);
  });

  it("accepts only a binary browser relay capacity", () => {
    expect(
      clientMessageSchema.safeParse({
        type: "relay-capacity",
        downstreamEdges: 0,
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "relay-capacity",
        downstreamEdges: 1,
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "relay-capacity",
        downstreamEdges: 2,
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "relay-capacity",
        downstreamEdges: 1,
        score: 100,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded route acknowledgements, failures, and SFU refreshes", () => {
    expect(
      clientMessageSchema.safeParse({
        type: "route-ready",
        revision: 7,
        phase: "prepare",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "route-failed",
        revision: 7,
        phase: "active",
        connectionId: null,
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "refresh-sfu",
        revision: MAX_MEDIA_ROUTE_REVISION,
      }).success,
    ).toBe(true);

    expect(
      clientMessageSchema.safeParse({
        type: "route-ready",
        revision: -1,
        phase: "prepare",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "route-failed",
        revision: 7,
        phase: "active",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "refresh-sfu",
        revision: 1.5,
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
      routeRevision: 0,
      routeAssignment: {
        upstream: { kind: "none" },
        childPeerIds: ["viewer_12345678", "viewer_87654321"],
        sfuPublicationGeneration: null,
      },
      qualitySettings,
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
        routeRevision: 0,
        routeAssignment: peerAssisted.routeAssignment,
        qualitySettings,
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        mediaMode: "peer-assisted",
        mediaAssignment: peerAssisted.mediaAssignment,
        routeRevision: 0,
        routeAssignment: peerAssisted.routeAssignment,
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
        qualitySettings: { ...qualitySettings, maxBitrate: 20_000_000 },
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        qualitySettings,
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        type: "quality-settings",
        qualitySettings: {
          resolution: "720p",
          maxFramerate: 30,
          maxBitrate: 3_000_000,
          degradationPreference: "balanced",
        },
      }).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        type: "quality-settings",
        qualitySettings: { ...qualitySettings, maxFramerate: 0 },
      }).success,
    ).toBe(false);
  });

  it("keeps hybrid route messages strict and separate from ordinary P2P auth", () => {
    const assignment = {
      upstream: { kind: "peer", peerId: "parent_12345678" },
      childPeerIds: ["child_12345678", "child_87654321"],
      sfuPublicationGeneration: null,
    };

    expect(participantRouteAssignmentSchema.safeParse(assignment).success).toBe(
      true,
    );
    expect(
      serverMessageSchema.safeParse({
        type: "route-update",
        revision: 9,
        phase: "prepare",
        assignment,
      }).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        type: "sfu-config",
        revision: 9,
        url: "wss://sfu.example.com",
        token: "header.payload.signature",
      }).success,
    ).toBe(true);

    expect(
      participantRouteAssignmentSchema.safeParse({
        ...assignment,
        childPeerIds: [
          "child_12345678",
          "child_87654321",
          "child_overflow",
        ],
      }).success,
    ).toBe(false);
    expect(
      participantRouteAssignmentSchema.safeParse({
        ...assignment,
        childPeerIds: ["child_12345678", "child_12345678"],
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        type: "route-update",
        revision: 9,
        phase: "prepare",
        assignment,
        roomAssignments: [],
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        type: "sfu-config",
        revision: 9,
        url: "wss://sfu.example.com",
        token: "x".repeat(MAX_SFU_TOKEN_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        routeRevision: 9,
      }).success,
    ).toBe(false);
  });

  it("accepts every bounded hybrid upstream shape", () => {
    for (const upstream of [
      { kind: "none" },
      { kind: "peer", peerId: "parent_12345678" },
      { kind: "sfu" },
    ]) {
      expect(
        participantRouteAssignmentSchema.safeParse({
          upstream,
          childPeerIds: [],
          sfuPublicationGeneration:
            upstream.kind === "none" ? "generation_12345678" : null,
        }).success,
      ).toBe(true);
    }
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
