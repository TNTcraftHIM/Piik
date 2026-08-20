import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWER_DISPLAY_NAME,
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_HOST_CLAIM_TTL_SECONDS,
  MAX_MEDIA_ROUTE_REVISION,
  MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES,
  MAX_SFU_TOKEN_LENGTH,
  MAX_VIEWER_QUALITY_EVIDENCE_BYTES,
  MAX_VIEWERS_PER_ROOM_LIMIT,
  SIGNALING_PROTOCOL,
  clientMessageSchema,
  createRoomRequestSchema,
  decodeClientMessage,
  normalizeDisplayName,
  participantRouteAssignmentSchema,
  serverMessageSchema,
} from "../src/shared/protocol.js";

const token = "a".repeat(43);
const roomId = "123456789012";
const viewerGrant = `g1.${roomId}.1787076000.${"b".repeat(43)}`;
const qualitySettings = {
  resolution: "1080p",
  maxFramerate: 60,
  maxBitrate: 8_000_000,
  degradationPreference: "maintain-resolution",
} as const;

const qualityEvidence = {
  type: "viewer-quality-evidence",
  guard: {
    connectionId: "connection_12345678",
    routeRevision: 0,
  },
  sequence: 0,
  windowMs: 2_000,
  metrics: {
    width: 1_920,
    height: 1_080,
    framesPerSecond: 59.8,
    bitrateKbps: 7_500,
    packetsReceivedDelta: 1_500,
    packetsLostDelta: 2,
    jitterMs: 3.5,
    framesDecodedDelta: 120,
    framesDroppedDelta: 1,
    decodeMsPerFrame: 2.4,
    freezeCountDelta: 0,
    freezeDurationMsDelta: 0,
    codec: "video/H264",
    codecProfile: "profile-level-id=42e01f",
    codecParameters:
      "packetization-mode=1; level-asymmetry-allowed=1",
  },
} as const;

const parentEdgeQualityEvidence = {
  type: "parent-edge-quality-evidence",
  viewerPeerId: "viewer_12345678",
  guard: qualityEvidence.guard,
  viewerSequence: qualityEvidence.sequence,
  proof: { kind: "sending", packetsSentDelta: 1_500 },
} as const;

describe("client signaling protocol", () => {
  it("accepts only the fixed provisional Host lease", () => {
    expect(
      createRoomRequestSchema.parse({ viewerPolicy: "private-link" }),
    ).toEqual({ viewerPolicy: "private-link" });
    expect(
      createRoomRequestSchema.parse({
        viewerPolicy: "private-link",
        hostClaimTtlSeconds: MAX_HOST_CLAIM_TTL_SECONDS,
      }),
    ).toEqual({
      viewerPolicy: "private-link",
      hostClaimTtlSeconds: MAX_HOST_CLAIM_TTL_SECONDS,
    });
    for (const hostClaimTtlSeconds of [0, 1, 299, 301, 1.5]) {
      expect(
        createRoomRequestSchema.safeParse({
          viewerPolicy: "private-link",
          hostClaimTtlSeconds,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects the removed all-room ICE refresh request", () => {
    expect(clientMessageSchema.safeParse({ type: "refresh-ice" }).success).toBe(
      false,
    );
  });

  it("accepts a bounded authentication message", () => {
    expect(
      decodeClientMessage(
        JSON.stringify({
          type: "authenticate",
          protocol: SIGNALING_PROTOCOL,
          roomId,
          role: "viewer",
          clientId: "client_12345678",
        }),
      ),
    ).toMatchObject({ type: "authenticate", role: "viewer" });
    expect(
      decodeClientMessage(
        JSON.stringify({
          type: "authenticate",
          protocol: SIGNALING_PROTOCOL,
          roomId,
          role: "viewer",
          viewerGrant,
          clientId: "client_12345678",
        }),
      ),
    ).toMatchObject({ viewerGrant });
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        roomId,
        role: "viewer",
        clientId: "client_12345678",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        protocol: "screener-v0",
        roomId,
        role: "viewer",
        clientId: "client_12345678",
      }).success,
    ).toBe(false);
  });

  it("normalizes display names and rejects misleading Unicode boundaries", () => {
    expect(normalizeDisplayName("  Cafe\u0301\u00a0朋友  ")).toBe("Café 朋友");
    expect(normalizeDisplayName("玩家 👩‍💻")).toBe("玩家 👩‍💻");
    expect(normalizeDisplayName("名".repeat(MAX_DISPLAY_NAME_CODE_POINTS))).toBe(
      "名".repeat(MAX_DISPLAY_NAME_CODE_POINTS),
    );
    expect(
      normalizeDisplayName("名".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1)),
    ).toBeNull();
    for (const invalid of ["a\nb", "a\u202eb", "a\ufeffb", "a\ud800b"]) {
      expect(normalizeDisplayName(invalid)).toBeNull();
    }

    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId,
        role: "viewer",
        clientId: "client_12345678",
        displayName: "小明",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId,
        role: "host",
        token,
        clientId: "client_12345678",
        viewerPresence: true,
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "set-display-name",
        displayName: " Cafe\u0301 ",
      }).success,
    ).toBe(false);
    expect(DEFAULT_VIEWER_DISPLAY_NAME).toBe("访客");
  });

  it("accepts only canonical bounded Viewer grants and access actions", () => {
    for (const malformedGrant of [
      `g0.${roomId}.1787076000.${"b".repeat(43)}`,
      `g1.${roomId}.0.${"b".repeat(43)}`,
      `g1.${roomId}.1787076000.${"b".repeat(42)}`,
      `${viewerGrant}.extra`,
    ]) {
      expect(
        clientMessageSchema.safeParse({
          type: "authenticate",
          protocol: SIGNALING_PROTOCOL,
          roomId,
          role: "viewer",
          viewerGrant: malformedGrant,
          clientId: "client_12345678",
        }).success,
      ).toBe(false);
    }
    for (const action of ["public-watch", "rotate", "revoke"]) {
      expect(
        clientMessageSchema.safeParse({
          type: "set-viewer-access",
          action,
        }).success,
      ).toBe(true);
    }
    expect(
      clientMessageSchema.safeParse({
        type: "set-viewer-access",
        action: "private-link",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields and malformed tokens", () => {
    const result = clientMessageSchema.safeParse({
      type: "authenticate",
      protocol: SIGNALING_PROTOCOL,
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
        protocol: SIGNALING_PROTOCOL,
        roomId,
        role: "host",
        token,
        clientId: "client_12345678",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId,
        role: "viewer",
        token,
        clientId: "client_12345678",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: "1",
        role: "viewer",
        clientId: "client_12345678",
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: "0123",
        role: "viewer",
        clientId: "client_12345678",
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
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

  it("accepts explicit sharing-stop and abandonment messages", () => {
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
        protocol: SIGNALING_PROTOCOL,
        roomId,
        role: "host",
        token,
        clientId: "client_12345678",
        shareGeneration: "share_generation_12345678",
      }).success,
    ).toBe(true);
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

  it("accepts only strict, bounded viewer quality evidence", () => {
    expect(clientMessageSchema.safeParse(qualityEvidence).success).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(qualityEvidence), "utf8"),
    ).toBeLessThanOrEqual(MAX_VIEWER_QUALITY_EVIDENCE_BYTES);

    for (const invalid of [
      { ...qualityEvidence, roomId },
      {
        ...qualityEvidence,
        guard: { ...qualityEvidence.guard, peerId: "viewer_12345678" },
      },
      { ...qualityEvidence, windowMs: 999 },
      { ...qualityEvidence, sequence: -1 },
      {
        ...qualityEvidence,
        metrics: { ...qualityEvidence.metrics, width: null },
      },
      {
        ...qualityEvidence,
        metrics: { ...qualityEvidence.metrics, bitrateKbps: Number.POSITIVE_INFINITY },
      },
      {
        ...qualityEvidence,
        metrics: { ...qualityEvidence.metrics, freezeDurationMsDelta: 2_001 },
      },
      {
        ...qualityEvidence,
        metrics: {
          ...qualityEvidence.metrics,
          codecParameters: "sprop-parameter-sets=deadbeef",
        },
      },
      {
        ...qualityEvidence,
        metrics: {
          ...qualityEvidence.metrics,
          codecProfile: "device-id=deadbeef",
        },
      },
      {
        ...qualityEvidence,
        metrics: {
          ...qualityEvidence.metrics,
          scalabilityMode: "DEVICE_ABC123",
        },
      },
      {
        ...qualityEvidence,
        metrics: {
          ...qualityEvidence.metrics,
          decoderImplementation: "device-specific-decoder",
        },
      },
    ]) {
      expect(clientMessageSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts only strict, bounded parent edge quality proof", () => {
    expect(
      clientMessageSchema.safeParse(parentEdgeQualityEvidence).success,
    ).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(parentEdgeQualityEvidence), "utf8"),
    ).toBeLessThanOrEqual(MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES);
    for (const reason of ["cpu", "bandwidth"] as const) {
      expect(
        clientMessageSchema.safeParse({
          ...parentEdgeQualityEvidence,
          proof: {
            kind: "sender-limited",
            packetsSentDelta: 1_500,
            reason,
          },
        }).success,
      ).toBe(true);
    }

    for (const invalid of [
      { ...parentEdgeQualityEvidence, roomId },
      { ...parentEdgeQualityEvidence, viewerSequence: -1 },
      {
        ...parentEdgeQualityEvidence,
        proof: { kind: "sending", packetsSentDelta: 0 },
      },
      {
        ...parentEdgeQualityEvidence,
        proof: {
          kind: "remote-loss",
          packetsSentDelta: 1_500,
          remotePacketsLostDelta: null,
        },
      },
      {
        ...parentEdgeQualityEvidence,
        proof: {
          kind: "sender-limited",
          packetsSentDelta: 1_500,
          reason: "other",
        },
      },
      {
        ...parentEdgeQualityEvidence,
        proof: {
          kind: "sender-limited",
          packetsSentDelta: 1_500,
          reason: "cpu",
          score: 1,
        },
      },
    ]) {
      expect(clientMessageSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each([
    ["video/VP8", null, "max-fr=60; max-fs=8160"],
    ["video/VP9", "profile-id=2", "max-fs=8160"],
    ["video/AV1", "profile=1", "level-idx=31; tier=0"],
    ["video/unknown", null, null],
  ])(
    "accepts canonical viewer codec evidence for %s",
    (codec, codecProfile, codecParameters) => {
      expect(
        clientMessageSchema.safeParse({
          ...qualityEvidence,
          metrics: {
            ...qualityEvidence.metrics,
            codec,
            codecProfile,
            codecParameters,
          },
        }).success,
      ).toBe(true);
    },
  );

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
  it("rejects the removed all-room TURN credential wire", () => {
    expect(
      serverMessageSchema.safeParse({
        type: "ice-config",
        iceConfig: { iceServers: [] },
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        iceConfig: {
          iceServers: [
            {
              urls: "turn:relay.example.test:3478",
              username: "expires:viewer_12345678",
              credential: "credential",
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        iceConfig: {
          iceServers: [{ urls: "turn:relay.example.test:3478" }],
        },
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...authenticatedMessage(8),
        iceConfig: {
          iceServers: [{ urls: "stuns:stun.example.test:5349" }],
        },
      }).success,
    ).toBe(false);
  });

  function authenticatedMessage(maxViewers: number, viewerPeerIds: string[] = []) {
    return {
      type: "authenticated",
      protocol: SIGNALING_PROTOCOL,
      role: "host",
      peerId: "host_12345678",
      roomExpiresAt: "2026-08-18T18:00:00.000Z",
      maxViewers,
      hostOnline: true,
      connectionId: null,
      viewerPeerIds,
      viewerPolicy: "private-link",
      viewerAuthorizationGeneration: "viewer_generation_12345678",
      iceConfig: {
        iceServers: [],
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

  it("accepts a strict, unique and bounded Viewer presence snapshot", () => {
    const viewer = {
      peerId: "viewer_12345678",
      displayName: "小明",
      mediaTopology: "peer-relay",
    } as const;
    expect(
      serverMessageSchema.safeParse({
        type: "viewer-presence",
        viewers: [viewer],
      }).success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        type: "viewer-presence",
        viewers: [viewer, viewer],
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        type: "viewer-presence",
        viewers: [{ ...viewer, ip: "203.0.113.1" }],
      }).success,
    ).toBe(false);
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
        ...peerAssisted,
        sfuStandbyUrl: "wss://sfu.example.com",
      }).success,
    ).toBe(true);
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
        ...authenticatedMessage(8),
        sfuStandbyUrl: "wss://sfu.example.com",
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...peerAssisted,
        sfuStandbyUrl: "https://sfu.example.com",
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

  it("accepts only canonical server-derived viewer evidence envelopes", () => {
    const forwarded = {
      ...qualityEvidence,
      viewerPeerId: "viewer_12345678",
      parentPeerId: "host_12345678",
    };
    expect(serverMessageSchema.safeParse(forwarded).success).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(forwarded), "utf8"),
    ).toBeLessThanOrEqual(MAX_VIEWER_QUALITY_EVIDENCE_BYTES);
    expect(
      serverMessageSchema.safeParse({ ...forwarded, roomId }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        ...qualityEvidence,
        viewerPeerId: "viewer_12345678",
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
