import { z } from "zod";

import { isCanonicalVideoCodecEvidence } from "./video-codec-evidence.js";

export const MAX_VIEWERS_PER_ROOM_LIMIT = 16;
export const MAX_SIGNAL_BYTES = 64 * 1024;
export const SIGNALING_PROTOCOL = "screener-v1";
export const ROOM_CODE_LENGTH = 12;
export const MAX_MEDIA_ROUTE_REVISION = Number.MAX_SAFE_INTEGER;
export const MAX_SFU_TOKEN_LENGTH = 8 * 1024;
export const MAX_ICE_SERVER_URLS = 8;
export const MAX_VIEWER_QUALITY_EVIDENCE_BYTES = 2 * 1024;
export const VIEWER_QUALITY_EVIDENCE_INTERVAL_MS = 2_000;
export const VIEWER_QUALITY_EVIDENCE_EXPIRY_MS = 5_000;

const opaqueIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const tokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const liveKitWebSocketUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "ws:" || protocol === "wss:";
    } catch {
      return false;
    }
  });

export const roomCodeSchema = z
  .string()
  .min(1)
  .max(ROOM_CODE_LENGTH)
  .regex(/^[1-9]\d*$/);

export const roleSchema = z.enum(["host", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const qualityProfileIdSchema = z.enum([
  "1080p60",
  "1080p30",
  "720p30",
]);
export type QualityProfileId = z.infer<typeof qualityProfileIdSchema>;
export const DEFAULT_QUALITY_PROFILE_ID: QualityProfileId = "1080p60";

export const qualityResolutionSchema = z.enum(["720p", "1080p", "1440p"]);
export type QualityResolution = z.infer<typeof qualityResolutionSchema>;

export const degradationPreferenceSchema = z.enum([
  "maintain-resolution",
  "balanced",
  "maintain-framerate",
]);
export type DegradationPreference = z.infer<
  typeof degradationPreferenceSchema
>;

export const qualitySettingsSchema = z
  .object({
    resolution: qualityResolutionSchema,
    maxFramerate: z.number().int().min(15).max(60),
    maxBitrate: z.number().int().min(2_000_000).max(12_000_000),
    degradationPreference: degradationPreferenceSchema,
  })
  .strict();
export type QualitySettings = z.infer<typeof qualitySettingsSchema>;
export const DEFAULT_QUALITY_SETTINGS = {
  resolution: "1080p",
  maxFramerate: 60,
  maxBitrate: 8_000_000,
  degradationPreference: "maintain-resolution",
} as const satisfies QualitySettings;

export const relayDownstreamEdgesSchema = z.union([
  z.literal(0),
  z.literal(1),
]);
export type RelayDownstreamEdges = z.infer<typeof relayDownstreamEdgesSchema>;

function isValidStunUrl(value: string): boolean {
  const schemeSeparator = value.indexOf(":");
  if (
    schemeSeparator <= 0 ||
    value.slice(0, schemeSeparator).toLowerCase() !== "stun"
  ) {
    return false;
  }

  const authorityText = value.slice(schemeSeparator + 1);
  if (
    !authorityText ||
    /[\\/\s?#]/.test(authorityText) ||
    authorityText.endsWith(":")
  ) {
    return false;
  }

  let authority: URL;
  try {
    authority = new URL(`http://${authorityText}`);
  } catch {
    return false;
  }
  return Boolean(
    authority.hostname &&
      !authority.username &&
      !authority.password &&
      authority.pathname === "/" &&
      !authority.search &&
      !authority.hash &&
      (!authority.port || Number(authority.port) > 0),
  );
}

export const stunUrlSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isValidStunUrl, { message: "Invalid STUN URL" });

const iceServerSchema = z
  .object({
    urls: z.union([
      stunUrlSchema,
      z.array(stunUrlSchema).min(1).max(MAX_ICE_SERVER_URLS),
    ]),
  })
  .strict();

export const iceConfigSchema = z
  .object({
    iceServers: z.array(iceServerSchema).max(8),
  })
  .strict();
export type IceConfig = z.infer<typeof iceConfigSchema>;

const sessionDescriptionSchema = z
  .object({
    type: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(48 * 1024),
  })
  .strict();

const iceCandidateSchema = z
  .object({
    candidate: z.string().max(4096),
    sdpMid: z.string().max(128).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

export const signalPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("description"),
      connectionId: opaqueIdSchema,
      description: sessionDescriptionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("candidate"),
      connectionId: opaqueIdSchema,
      candidate: iceCandidateSchema.nullable(),
    })
    .strict(),
]);
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

export const mediaAssignmentSchema = z
  .object({
    parentPeerId: opaqueIdSchema.nullable(),
    childPeerIds: z.array(opaqueIdSchema).max(2),
  })
  .strict();
export type MediaAssignment = z.infer<typeof mediaAssignmentSchema>;

export const mediaRouteRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_MEDIA_ROUTE_REVISION);

export const mediaRoutePhaseSchema = z.enum(["prepare", "active"]);
export type MediaRoutePhase = z.infer<typeof mediaRoutePhaseSchema>;

export const mediaRouteUpstreamSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("peer"),
      peerId: opaqueIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("sfu") }).strict(),
]);
export type MediaRouteUpstream = z.infer<typeof mediaRouteUpstreamSchema>;

export const sfuPublicationGenerationSchema = opaqueIdSchema;

export const participantRouteAssignmentSchema = z
  .object({
    upstream: mediaRouteUpstreamSchema,
    childPeerIds: z
      .array(opaqueIdSchema)
      .max(2)
      .refine((peerIds) => new Set(peerIds).size === peerIds.length),
    sfuPublicationGeneration: sfuPublicationGenerationSchema.nullable(),
  })
  .strict();
export type ParticipantRouteAssignment = z.infer<
  typeof participantRouteAssignmentSchema
>;

const nullableEvidenceNumber = (maximum: number) =>
  z.number().finite().min(0).max(maximum).nullable();

const nullableEvidenceInteger = (maximum: number) =>
  z.number().int().min(0).max(maximum).nullable();

export const viewerQualityEvidenceMetricsSchema = z
  .object({
    width: z.number().int().min(1).max(16_384).nullable(),
    height: z.number().int().min(1).max(16_384).nullable(),
    framesPerSecond: nullableEvidenceNumber(240),
    bitrateKbps: nullableEvidenceNumber(100_000),
    packetsReceivedDelta: nullableEvidenceInteger(1_000_000),
    packetsLostDelta: nullableEvidenceInteger(1_000_000),
    jitterMs: nullableEvidenceNumber(60_000),
    framesDecodedDelta: nullableEvidenceInteger(10_000),
    framesDroppedDelta: nullableEvidenceInteger(10_000),
    decodeMsPerFrame: nullableEvidenceNumber(60_000),
    freezeCountDelta: nullableEvidenceInteger(10_000),
    freezeDurationMsDelta: nullableEvidenceNumber(5_000),
    codec: z
      .string()
      .max(64)
      .regex(/^video\/[A-Za-z0-9.+-]{1,32}$/i)
      .nullable(),
    codecProfile: z
      .string()
      .max(64)
      .regex(/^[a-z0-9-]+=[a-z0-9]+$/)
      .nullable(),
    codecParameters: z
      .string()
      .max(128)
      .regex(/^[a-z0-9-]+=[a-z0-9]+(?:; [a-z0-9-]+=[a-z0-9]+)*$/)
      .nullable(),
  })
  .strict()
  .refine(
    (metrics) =>
      (metrics.width === null && metrics.height === null) ||
      (metrics.width !== null && metrics.height !== null),
    { message: "Viewer quality dimensions must be present together" },
  )
  .refine(isCanonicalVideoCodecEvidence, {
    message: "Viewer codec evidence is not canonical",
    path: ["codecParameters"],
  });
export type ViewerQualityEvidenceMetrics = z.infer<
  typeof viewerQualityEvidenceMetricsSchema
>;

const viewerQualityEvidenceGuardSchema = z
  .object({
    connectionId: opaqueIdSchema,
    routeRevision: mediaRouteRevisionSchema,
  })
  .strict();

const viewerQualityEvidenceWindowShape = {
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  windowMs: z.number().int().min(1_000).max(5_000),
  metrics: viewerQualityEvidenceMetricsSchema,
};

function freezeFitsEvidenceWindow(value: {
  windowMs: number;
  metrics: ViewerQualityEvidenceMetrics;
}): boolean {
  return (
    value.metrics.freezeDurationMsDelta === null ||
    value.metrics.freezeDurationMsDelta <= value.windowMs
  );
}

export const viewerQualityEvidenceMessageSchema = z
  .object({
    type: z.literal("viewer-quality-evidence"),
    guard: viewerQualityEvidenceGuardSchema,
    ...viewerQualityEvidenceWindowShape,
  })
  .strict()
  .refine(freezeFitsEvidenceWindow, {
    message: "Viewer freeze duration exceeds its evidence window",
  });
export type ViewerQualityEvidenceMessage = z.infer<
  typeof viewerQualityEvidenceMessageSchema
>;

const authenticateMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      type: z.literal("authenticate"),
      protocol: z.literal(SIGNALING_PROTOCOL),
      roomId: roomCodeSchema,
      role: z.literal("host"),
      token: tokenSchema,
      clientId: opaqueIdSchema,
      shareGeneration: opaqueIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authenticate"),
      protocol: z.literal(SIGNALING_PROTOCOL),
      roomId: roomCodeSchema,
      role: z.literal("viewer"),
      clientId: opaqueIdSchema,
    })
    .strict(),
]);

export const clientMessageSchema = z.union([
  authenticateMessageSchema,
  z
    .object({
      type: z.literal("signal"),
      targetPeerId: opaqueIdSchema.optional(),
      payload: signalPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("restart-request"),
      targetPeerId: opaqueIdSchema.optional(),
      connectionId: opaqueIdSchema,
      rebuild: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set-quality-settings"),
      qualitySettings: qualitySettingsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("relay-capacity"),
      downstreamEdges: relayDownstreamEdgesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("route-ready"),
      revision: mediaRouteRevisionSchema,
      phase: mediaRoutePhaseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("route-failed"),
      revision: mediaRouteRevisionSchema,
      phase: mediaRoutePhaseSchema,
      connectionId: opaqueIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("refresh-sfu"),
      revision: mediaRouteRevisionSchema,
    })
    .strict(),
  viewerQualityEvidenceMessageSchema,
  z
    .object({
      type: z.literal("stop-sharing"),
      shareGeneration: opaqueIdSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("abandon-room") }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

const errorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "INVALID_MESSAGE",
  "INVALID_TOKEN",
  "ROOM_EXPIRED",
  "ROOM_FULL",
  "HOST_ALREADY_CONNECTED",
  "PEER_NOT_FOUND",
  "FORBIDDEN",
  "SERVER_ERROR",
]);

const authenticatedMessageShape = {
  type: z.literal("authenticated"),
  protocol: z.literal(SIGNALING_PROTOCOL),
  role: roleSchema,
  peerId: opaqueIdSchema,
  roomExpiresAt: z.string().datetime().nullable(),
  maxViewers: z.number().int().min(1).max(MAX_VIEWERS_PER_ROOM_LIMIT),
  hostOnline: z.boolean(),
  connectionId: opaqueIdSchema.nullable(),
  viewerPeerIds: z.array(opaqueIdSchema).max(MAX_VIEWERS_PER_ROOM_LIMIT),
  iceConfig: iceConfigSchema,
};

const authenticatedMessageSchema = z.union([
  z.object(authenticatedMessageShape).strict(),
  z
    .object({
      ...authenticatedMessageShape,
      mediaMode: z.literal("peer-assisted"),
      mediaAssignment: mediaAssignmentSchema,
      routeRevision: mediaRouteRevisionSchema,
      routeAssignment: participantRouteAssignmentSchema,
      qualitySettings: qualitySettingsSchema,
      sfuStandbyUrl: liveKitWebSocketUrlSchema.optional(),
    })
    .strict(),
]);

export const serverMessageSchema = z.union([
  authenticatedMessageSchema,
  z
    .object({
      type: z.literal("peer-joined"),
      peerId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("peer-left"),
      peerId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("signal"),
      fromPeerId: opaqueIdSchema,
      payload: signalPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("restart-request"),
      fromPeerId: opaqueIdSchema,
      connectionId: opaqueIdSchema,
      rebuild: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("media-assignment"),
      mediaAssignment: mediaAssignmentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("route-update"),
      revision: mediaRouteRevisionSchema,
      phase: mediaRoutePhaseSchema,
      assignment: participantRouteAssignmentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("sfu-config"),
      revision: mediaRouteRevisionSchema,
      url: liveKitWebSocketUrlSchema,
      token: z.string().min(1).max(MAX_SFU_TOKEN_LENGTH),
    })
    .strict(),
  z
    .object({
      type: z.literal("quality-settings"),
      qualitySettings: qualitySettingsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("viewer-quality-evidence"),
      viewerPeerId: opaqueIdSchema,
      parentPeerId: opaqueIdSchema,
      guard: viewerQualityEvidenceGuardSchema,
      ...viewerQualityEvidenceWindowShape,
    })
    .strict()
     .refine(freezeFitsEvidenceWindow, {
       message: "Viewer freeze duration exceeds its evidence window",
     }),
   z
     .object({
       type: z.literal("host-status"),
      online: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("sharing-stopped") }).strict(),
  z
    .object({
      type: z.literal("room-closed"),
      reason: z.enum(["host-ended", "expired"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: errorCodeSchema,
      message: z.string().min(1).max(256),
    })
    .strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const createRoomResponseSchema = z
  .object({
    roomId: roomCodeSchema,
    hostToken: tokenSchema,
    inviteUrl: z.string().url().max(2048),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

export function decodeClientMessage(value: string): ClientMessage {
  return clientMessageSchema.parse(JSON.parse(value));
}

export function decodeServerMessage(value: string): ServerMessage {
  return serverMessageSchema.parse(JSON.parse(value));
}
