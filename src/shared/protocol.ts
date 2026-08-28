import { z } from "zod";

import { MAX_ENDPOINT_MEDIA_COPY_CAPACITY } from "./media-copy-accounting.js";
import { isCanonicalVideoCodecEvidence } from "./video-codec-evidence.js";

export const MAX_VIEWERS_PER_ROOM_LIMIT = 20;
export const MAX_PARTICIPANTS_PER_ROOM_LIMIT = MAX_VIEWERS_PER_ROOM_LIMIT + 1;
export const MAX_SIGNAL_BYTES = 64 * 1024;
export const SIGNALING_PROTOCOL = "screener-v16";
export const SIGNAL_CLOSE_CODES = {
  serviceRestart: 1012,
  sessionReplaced: 4001,
  clientReconnect: 4002,
  authenticationFailed: 4003,
  viewerAccessRevoked: 4004,
} as const;
export const ROOM_CODE_LENGTH = 4;
export const MAX_MEDIA_ROUTE_REVISION = Number.MAX_SAFE_INTEGER;
export const MAX_SFU_TOKEN_LENGTH = 8 * 1024;
export const MAX_ICE_SERVER_URLS = 8;
export const MAX_VIEWER_QUALITY_EVIDENCE_BYTES = 2 * 1024;
export const VIEWER_QUALITY_EVIDENCE_INTERVAL_MS = 2_000;
export const VIEWER_QUALITY_EVIDENCE_EXPIRY_MS = 5_000;
export const PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS = 3;
export const MAX_DISPLAY_NAME_CODE_POINTS = 24;
export const DEFAULT_VIEWER_DISPLAY_NAME = "访客";
export const DEFAULT_HOST_DISPLAY_NAME_PREFIX = "分享者";
export const MIN_VIEWER_PASSWORD_LENGTH = 1;
export const MAX_VIEWER_PASSWORD_LENGTH = 64;

const FORBIDDEN_DISPLAY_NAME_CHARACTERS =
  /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

export function normalizeDisplayName(value: string): string | null {
  if (FORBIDDEN_DISPLAY_NAME_CHARACTERS.test(value)) {
    return null;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return null;
    }
  }

  const normalized = value.normalize("NFC").trim().replace(/\p{Zs}+/gu, " ");
  const codePointCount = Array.from(normalized).length;
  return codePointCount >= 1 && codePointCount <= MAX_DISPLAY_NAME_CODE_POINTS
    ? normalized
    : null;
}

export const displayNameSchema = z
  .string()
  .min(1)
  .max(MAX_DISPLAY_NAME_CODE_POINTS * 4)
  .refine((value) => normalizeDisplayName(value) === value, {
    message: "Display name must be canonical",
  });
export type DisplayName = z.infer<typeof displayNameSchema>;

const opaqueIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const noMediaRouteUpstreamSchema = z
  .object({ kind: z.literal("none") })
  .strict();
const peerMediaRouteUpstreamSchema = z
  .object({
    kind: z.literal("peer"),
    peerId: opaqueIdSchema,
  })
  .strict();
const sfuMediaRouteUpstreamSchema = z
  .object({ kind: z.literal("sfu") })
  .strict();

export const mediaRouteUpstreamSchema = z.discriminatedUnion("kind", [
  noMediaRouteUpstreamSchema,
  peerMediaRouteUpstreamSchema,
  sfuMediaRouteUpstreamSchema,
]);
export type MediaRouteUpstream = z.infer<typeof mediaRouteUpstreamSchema>;

const activeMediaRouteUpstreamSchema = z.discriminatedUnion("kind", [
  peerMediaRouteUpstreamSchema,
  sfuMediaRouteUpstreamSchema,
]);

export const participantPresenceEntrySchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("host"),
      peerId: opaqueIdSchema,
      displayName: displayNameSchema,
      upstream: z.object({ kind: z.literal("none") }).strict(),
    })
    .strict(),
  z
    .object({
      role: z.literal("viewer"),
      peerId: opaqueIdSchema,
      displayName: displayNameSchema,
      upstream: mediaRouteUpstreamSchema,
      mediaReady: z.literal(true).optional(),
    })
    .strict(),
]);
export type ParticipantPresenceEntry = z.infer<
  typeof participantPresenceEntrySchema
>;

export const viewerPresenceEntrySchema = z
  .object({
    role: z.literal("viewer"),
    peerId: opaqueIdSchema,
    displayName: displayNameSchema,
    upstream: mediaRouteUpstreamSchema,
    mediaReady: z.literal(true).optional(),
  })
  .strict();
export type ViewerPresenceEntry = z.infer<typeof viewerPresenceEntrySchema>;

const tokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const viewerGrantSchema = z
  .string()
  .length(22)
  .regex(/^[A-Za-z0-9_-]{21}[AQgw]$/);

export const viewerPasswordSchema = z
  .string()
  .min(MIN_VIEWER_PASSWORD_LENGTH)
  .max(MAX_VIEWER_PASSWORD_LENGTH)
  .regex(/^[\x21-\x7e]+$/);

export const codeEntryPolicySchema = z.enum(["open", "private"]);
export type CodeEntryPolicy = z.infer<typeof codeEntryPolicySchema>;

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
  .length(ROOM_CODE_LENGTH)
  .max(ROOM_CODE_LENGTH)
  .regex(/^[1-9]\d*$/);

export const roleSchema = z.enum(["host", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const qualityProfileIdSchema = z.enum([
  "720p30",
  "1080p30",
  "1080p60",
]);
export type QualityProfileId = z.infer<typeof qualityProfileIdSchema>;

export const qualityResolutionSchema = z.enum([
  "480p",
  "720p",
  "1080p",
  "1440p",
]);
export type QualityResolution = z.infer<typeof qualityResolutionSchema>;

export const degradationPreferenceSchema = z.enum([
  "maintain-resolution",
  "balanced",
  "maintain-framerate",
]);
export type DegradationPreference = z.infer<
  typeof degradationPreferenceSchema
>;

export const screenAudioQualitySchema = z.enum([
  "saver",
  "music",
  "very-high",
]);
export type ScreenAudioQuality = z.infer<typeof screenAudioQualitySchema>;

export const qualitySettingsSchema = z
  .object({
    resolution: qualityResolutionSchema,
    maxFramerate: z.number().int().min(15).max(60),
    maxBitrate: z.number().int().min(2_000_000).max(12_000_000),
    degradationPreference: degradationPreferenceSchema,
    screenAudioQuality: screenAudioQualitySchema.optional(),
  })
  .strict();
export type QualitySettings = z.infer<typeof qualitySettingsSchema>;
export const DEFAULT_QUALITY_SETTINGS = {
  resolution: "1080p",
  maxFramerate: 30,
  maxBitrate: 5_000_000,
  degradationPreference: "balanced",
  screenAudioQuality: "music",
} as const satisfies QualitySettings;

export const routePolicySchema = z
  .object({
    peerOnly: z.boolean(),
    topologyOptimization: z.boolean(),
  })
  .strict();
export type RoutePolicy = z.infer<typeof routePolicySchema>;
export const DEFAULT_ROUTE_POLICY = {
  peerOnly: false,
  topologyOptimization: true,
} as const satisfies RoutePolicy;

export const relayDownstreamEdgesSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_ENDPOINT_MEDIA_COPY_CAPACITY);
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

export const preparedRouteCandidateSchema = z
  .object({
    childPeerId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    transport: z.enum(["direct", "sfu"]),
    qualityProbe: z.boolean(),
  })
  .strict();
export type PreparedRouteCandidate = z.infer<
  typeof preparedRouteCandidateSchema
>;

export const mediaRouteRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_MEDIA_ROUTE_REVISION);

export const mediaRoutePhaseSchema = z.enum(["prepare", "active"]);
export type MediaRoutePhase = z.infer<typeof mediaRoutePhaseSchema>;

export const routeDemandReasonSchema = z.enum([
  "join",
  "edge-unavailable",
  "parent-departed",
  "capacity-reduction",
  "sfu-bootstrap",
  "direct-convergence",
  "quality-convergence",
  "root-convergence",
]);
export type RouteDemandReason = z.infer<typeof routeDemandReasonSchema>;

export const routeDiagnosticFinalRouteSchema = z.enum([
  "direct",
  "sfu",
  "waiting",
  "failed",
]);
export type RouteDiagnosticFinalRoute = z.infer<
  typeof routeDiagnosticFinalRouteSchema
>;

export const routeDiagnosticRejectionBucketSchema = z.enum([
  "none",
  "stale",
  "endpoint-capacity",
  "sfu-admission",
  "candidate-failed",
  "first-frame-timeout",
  "operation-deadline",
  "aborted",
]);
export type RouteDiagnosticRejectionBucket = z.infer<
  typeof routeDiagnosticRejectionBucketSchema
>;

const routeDiagnosticDurationSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const routeDiagnosticOrdinalSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_VIEWERS_PER_ROOM_LIMIT);
const routeDiagnosticParentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("host") }).strict(),
  z.object({ kind: z.literal("sfu") }).strict(),
  z
    .object({
      kind: z.literal("viewer"),
      ordinal: routeDiagnosticOrdinalSchema,
    })
    .strict(),
]);
const routeDiagnosticQualityValueSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const routeDiagnosticQualitySchema = z
  .object({
    eligibleWindows: routeDiagnosticQualityValueSchema,
    eligibleDurationMs: routeDiagnosticQualityValueSchema,
    freezeWindows: routeDiagnosticQualityValueSchema,
    freezeCount: routeDiagnosticQualityValueSchema,
    freezeDurationMs: routeDiagnosticQualityValueSchema,
    pauseCount: routeDiagnosticQualityValueSchema,
    pauseDurationMs: routeDiagnosticQualityValueSchema,
  })
  .strict();
const routeDiagnosticChildSchema = z
  .object({
    ordinal: routeDiagnosticOrdinalSchema,
    parent: routeDiagnosticParentSchema,
    effectiveCapacity: z
      .number()
      .int()
      .min(0)
      .max(MAX_ENDPOINT_MEDIA_COPY_CAPACITY),
    childCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_ENDPOINT_MEDIA_COPY_CAPACITY),
    demandAgeMs: routeDiagnosticDurationSchema,
    queueWaitMs: routeDiagnosticDurationSchema,
    candidateStartMs: routeDiagnosticDurationSchema,
    firstDecodedFrameMs: routeDiagnosticDurationSchema,
    finalMs: routeDiagnosticDurationSchema,
    finalRoute: routeDiagnosticFinalRouteSchema,
    rejectionBucket: routeDiagnosticRejectionBucketSchema,
    quality: routeDiagnosticQualitySchema.nullable(),
  })
  .strict();
const routeDiagnosticOperationSchema = z
  .object({
    childOrdinal: routeDiagnosticOrdinalSchema,
    reason: routeDemandReasonSchema,
    stage: z.enum(["admission", "first-frame", "quality-proof"]),
    cursor: z.number().int().min(0).max(MAX_VIEWERS_PER_ROOM_LIMIT),
    candidateCount: z.number().int().min(1).max(MAX_VIEWERS_PER_ROOM_LIMIT + 1),
  })
  .strict();

export const routeDiagnosticSnapshotSchema = z
  .object({
    children: z
      .array(routeDiagnosticChildSchema)
      .max(MAX_VIEWERS_PER_ROOM_LIMIT),
    operation: routeDiagnosticOperationSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const ordinals = new Set(snapshot.children.map((child) => child.ordinal));
    if (ordinals.size !== snapshot.children.length) {
      context.addIssue({
        code: "custom",
        message: "Route diagnostic ordinals must be unique",
        path: ["children"],
      });
      return;
    }
    for (const [index, child] of snapshot.children.entries()) {
      if (
        child.parent.kind === "viewer" &&
        (!ordinals.has(child.parent.ordinal) ||
          child.parent.ordinal === child.ordinal)
      ) {
        context.addIssue({
          code: "custom",
          message: "Route diagnostic parent ordinal is invalid",
          path: ["children", index, "parent"],
        });
      }
    }
    if (
      snapshot.operation &&
      (!ordinals.has(snapshot.operation.childOrdinal) ||
        snapshot.operation.cursor >= snapshot.operation.candidateCount)
    ) {
      context.addIssue({
        code: "custom",
        message: "Route diagnostic operation is invalid",
        path: ["operation"],
      });
    }
  });
export type RouteDiagnosticSnapshot = z.infer<
  typeof routeDiagnosticSnapshotSchema
>;

export const sfuPublicationGenerationSchema = opaqueIdSchema;

export const participantRouteAssignmentSchema = z
  .object({
    upstream: mediaRouteUpstreamSchema,
    childPeerIds: z
      .array(opaqueIdSchema)
      .max(MAX_ENDPOINT_MEDIA_COPY_CAPACITY)
      .refine((peerIds) => new Set(peerIds).size === peerIds.length),
    sfuPublicationGeneration: sfuPublicationGenerationSchema.nullable(),
  })
  .strict()
  .superRefine((assignment, context) => {
    if (
      assignment.upstream.kind === "sfu" &&
      assignment.sfuPublicationGeneration === null
    ) {
      context.addIssue({
        code: "custom",
        message: "An SFU upstream requires its publication generation",
        path: ["sfuPublicationGeneration"],
      });
    }
    if (
      assignment.upstream.kind === "peer" &&
      assignment.sfuPublicationGeneration !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A peer upstream cannot own an SFU publication generation",
        path: ["sfuPublicationGeneration"],
      });
    }
  });
export type ParticipantRouteAssignment = z.infer<
  typeof participantRouteAssignmentSchema
>;

const nullableEvidenceNumber = (maximum: number) =>
  z.number().finite().min(0).max(maximum).nullable();

const nullableSignedEvidenceNumber = (absoluteMaximum: number) =>
  z.number().finite().min(-absoluteMaximum).max(absoluteMaximum).nullable();

const nullableEvidenceInteger = (maximum: number) =>
  z.number().int().min(0).max(maximum).nullable();

const nullableSafeEvidenceNumber = z
  .number()
  .finite()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

const nullableSafeEvidenceInteger = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

export const viewerQualityEvidenceMetricsSchema = z
  .object({
    width: z.number().int().min(1).max(16_384).nullable(),
    height: z.number().int().min(1).max(16_384).nullable(),
    framesPerSecond: nullableEvidenceNumber(240),
    bitrateKbps: nullableEvidenceNumber(100_000),
    packetsReceivedDelta: nullableEvidenceInteger(1_000_000),
    packetsLostDelta: nullableEvidenceInteger(1_000_000),
    rttMs: nullableEvidenceNumber(60_000),
    jitterMs: nullableEvidenceNumber(60_000),
    framesDecodedDelta: nullableEvidenceInteger(10_000),
    framesDroppedDelta: nullableEvidenceInteger(10_000),
    decodeMsPerFrame: nullableEvidenceNumber(60_000),
    freezeCountDelta: nullableSafeEvidenceInteger,
    freezeDurationMsDelta: nullableSafeEvidenceNumber,
    pauseCountDelta: nullableSafeEvidenceInteger,
    pauseDurationMsDelta: nullableSafeEvidenceNumber,
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
    audioBitrateKbps: nullableEvidenceNumber(10_000),
    audioPacketLossPercent: nullableEvidenceNumber(100),
    audioJitterMs: nullableEvidenceNumber(60_000),
    audioVideoPlayoutDeltaMs: nullableSignedEvidenceNumber(60_000),
    videoJitterBufferDelayMs: nullableEvidenceNumber(60_000),
    audioJitterBufferDelayMs: nullableEvidenceNumber(60_000),
    audioConcealedSamplesPercent: nullableEvidenceNumber(100),
    audioConcealmentEventsDelta: nullableEvidenceInteger(10_000),
    audioCodec: z
      .string()
      .max(64)
      .regex(/^audio\/[A-Za-z0-9.+-]{1,32}$/i)
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
    presentationEpoch: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const viewerQualityEvidenceWindowShape = {
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  windowMs: z.number().int().min(1_000).max(5_000),
  metrics: viewerQualityEvidenceMetricsSchema,
};

const senderQualityDiagnosticsSchema = z
  .object({
    reason: z.enum(["none", "bandwidth", "cpu"]).nullable(),
    framesPerSecond: nullableEvidenceNumber(240),
    bitrateKbps: nullableEvidenceNumber(100_000),
    captureFramesPerSecond: nullableEvidenceNumber(240).optional(),
    mediaSourceFramesPerSecond: nullableEvidenceNumber(240).optional(),
    width: nullableEvidenceInteger(16_384).optional(),
    height: nullableEvidenceInteger(16_384).optional(),
    availableOutgoingKbps: nullableEvidenceNumber(100_000).optional(),
    rttMs: nullableEvidenceNumber(60_000).optional(),
    packetLossPercent: nullableEvidenceNumber(100).optional(),
  })
  .strict();

export const viewerQualityEvidenceMessageSchema = z
  .object({
    type: z.literal("viewer-quality-evidence"),
    guard: viewerQualityEvidenceGuardSchema,
    ...viewerQualityEvidenceWindowShape,
  })
  .strict();

export const senderQualityEvidenceMessageSchema = z
  .object({
    type: z.literal("sender-quality-evidence"),
    childPeerId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    rtpStatsId: z.string().min(1).max(256).nullable(),
    trackIdentifier: z.string().min(1).max(256).nullable(),
    sampleTimestampMs: z
      .number()
      .finite()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    routeRevision: mediaRouteRevisionSchema,
    state: z.enum(["unknown", "healthy", "degraded"]),
    diagnostics: senderQualityDiagnosticsSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (
      (message.state !== "unknown" &&
        (message.rtpStatsId === null ||
          message.trackIdentifier === null ||
          message.sampleTimestampMs === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Known sender quality needs exact RTP identity",
        path: ["rtpStatsId"],
      });
    }
    const reason = message.diagnostics.reason;
    if (
      (message.state === "healthy" && reason !== "none") ||
      (message.state === "degraded" &&
        reason !== "bandwidth" &&
        reason !== "cpu") ||
      (message.state === "unknown" && reason !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Sender quality reason must match its native state",
        path: ["diagnostics", "reason"],
      });
    }
  });

export const sfuPublisherQualityEvidenceMessageSchema = z
  .object({
    type: z.literal("sfu-publisher-quality-evidence"),
    publicationGeneration: opaqueIdSchema,
    routeRevision: mediaRouteRevisionSchema,
    state: z.enum(["unknown", "healthy", "degraded"]),
    sampleTimestampMs: z
      .number()
      .finite()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    diagnostics: senderQualityDiagnosticsSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.state !== "unknown" && message.sampleTimestampMs === null) {
      context.addIssue({
        code: "custom",
        message: "Known SFU publisher quality needs an exact sample",
        path: ["sampleTimestampMs"],
      });
    }
    const reason = message.diagnostics.reason;
    if (
      (message.state === "healthy" && reason !== "none") ||
      (message.state === "degraded" &&
        reason !== "bandwidth" &&
        reason !== "cpu") ||
      (message.state === "unknown" && reason !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "SFU publisher reason must match its native state",
        path: ["diagnostics", "reason"],
      });
    }
  });

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
      sharingPaused: z.boolean().optional(),
      qualitySettings: qualitySettingsSchema.optional(),
      routePolicy: routePolicySchema.default(DEFAULT_ROUTE_POLICY),
      viewerPresence: z.literal(true).optional(),
      displayName: displayNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authenticate"),
      protocol: z.literal(SIGNALING_PROTOCOL),
      roomId: roomCodeSchema,
      role: z.literal("viewer"),
      clientId: opaqueIdSchema,
      viewerGrant: viewerGrantSchema.optional(),
      viewerPassword: viewerPasswordSchema.optional(),
      displayName: displayNameSchema.optional(),
      viewerPresence: z.literal(true).optional(),
    })
    .strict(),
]);

const signalingChallengeSequenceSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const clientMessageSchema = z.union([
  authenticateMessageSchema,
  z
    .object({
      type: z.literal("signaling-challenge"),
      sequence: signalingChallengeSequenceSchema,
    })
    .strict(),
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
      qualityApproved: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("route-transport-connected"),
      revision: mediaRouteRevisionSchema,
      connectionId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("route-media-unavailable"),
      revision: mediaRouteRevisionSchema,
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
  z.object({ type: z.literal("request-route-diagnostic") }).strict(),
  viewerQualityEvidenceMessageSchema,
  senderQualityEvidenceMessageSchema,
  sfuPublisherQualityEvidenceMessageSchema,
  z.object({ type: z.literal("reset-sender-quality") }).strict(),
  z
    .object({
      type: z.literal("set-display-name"),
      displayName: displayNameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set-sharing-paused"),
      shareGeneration: opaqueIdSchema,
      paused: z.boolean(),
    })
    .strict(),
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
  "ROOM_ACCESS_DENIED",
  "ROOM_NOT_FOUND",
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
  peerId: opaqueIdSchema,
  roomExpiresAt: z.string().datetime().nullable(),
  maxViewers: z.number().int().min(1).max(MAX_VIEWERS_PER_ROOM_LIMIT),
  endpointMediaCopyCapacity: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENDPOINT_MEDIA_COPY_CAPACITY),
  hostOnline: z.boolean(),
  hostPaused: z.boolean().optional(),
  connectionId: opaqueIdSchema.nullable(),
  viewerPeerIds: z.array(opaqueIdSchema).max(MAX_VIEWERS_PER_ROOM_LIMIT),
  iceConfig: iceConfigSchema,
  codeEntryPolicy: codeEntryPolicySchema,
  viewerAuthorizationGeneration: opaqueIdSchema,
};

const authenticatedHostMessageShape = {
  ...authenticatedMessageShape,
  role: z.literal("host"),
  viewerPasswordEnabled: z.boolean(),
};

const authenticatedViewerMessageShape = {
  ...authenticatedMessageShape,
  role: z.literal("viewer"),
};

const peerAssistedAuthenticatedShape = {
  mediaMode: z.literal("peer-assisted"),
  shareGeneration: opaqueIdSchema.nullable(),
  routeRevision: mediaRouteRevisionSchema,
  routeAssignment: participantRouteAssignmentSchema,
  qualitySettings: qualitySettingsSchema,
  routePolicy: routePolicySchema,
  sfuStandbyUrl: liveKitWebSocketUrlSchema.optional(),
};

const authenticatedMessageSchema = z.union([
  z.object(authenticatedHostMessageShape).strict(),
  z.object(authenticatedViewerMessageShape).strict(),
  z
    .object({
      ...authenticatedHostMessageShape,
      ...peerAssistedAuthenticatedShape,
    })
    .strict(),
  z
    .object({
      ...authenticatedViewerMessageShape,
      ...peerAssistedAuthenticatedShape,
    })
    .strict(),
]);

export const serverMessageSchema = z.union([
  authenticatedMessageSchema,
  z
    .object({
      type: z.literal("signaling-challenge-response"),
      sequence: signalingChallengeSequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("peer-joined"),
      peerId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("peer-waiting"),
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
  z.discriminatedUnion("phase", [
    z
      .object({
        type: z.literal("route-update"),
        revision: mediaRouteRevisionSchema,
        phase: z.literal("prepare"),
        assignment: participantRouteAssignmentSchema,
        candidate: preparedRouteCandidateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("route-update"),
        revision: mediaRouteRevisionSchema,
        phase: z.literal("active"),
        assignment: participantRouteAssignmentSchema,
      })
      .strict(),
  ]),
  z.discriminatedUnion("state", [
    z
      .object({
        type: z.literal("route-status"),
        revision: mediaRouteRevisionSchema,
        state: z.literal("waiting"),
        reason: z.literal("sfu-admission"),
      })
      .strict(),
    z
      .object({
        type: z.literal("route-status"),
        revision: mediaRouteRevisionSchema,
        state: z.literal("failed"),
        reason: z.literal("route-exhausted"),
      })
      .strict(),
  ]),
  z
    .object({
      type: z.literal("route-diagnostic-snapshot"),
      snapshot: routeDiagnosticSnapshotSchema,
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
      type: z.literal("route-policy"),
      shareGeneration: opaqueIdSchema,
      routePolicy: routePolicySchema,
      sfuStandbyUrl: liveKitWebSocketUrlSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("pause-sharing-source"),
      shareGeneration: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("viewer-quality-evidence"),
      viewerPeerId: opaqueIdSchema,
      upstream: activeMediaRouteUpstreamSchema,
      guard: viewerQualityEvidenceGuardSchema,
      ...viewerQualityEvidenceWindowShape,
    })
    .strict(),
  z
    .object({
      type: z.literal("host-status"),
      online: z.boolean(),
      paused: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("viewer-presence"),
      viewers: z
        .array(participantPresenceEntrySchema)
        .max(MAX_PARTICIPANTS_PER_ROOM_LIMIT),
    })
    .strict()
    .superRefine((message, context) => {
      const peerIds = new Set<string>();
      for (const viewer of message.viewers) {
        if (peerIds.has(viewer.peerId)) {
          context.addIssue({
            code: "custom",
            message: "Viewer presence peer IDs must be unique",
            path: ["viewers"],
          });
          return;
        }
        peerIds.add(viewer.peerId);
      }
    }),
  z
    .object({
      type: z.literal("viewer-grant-revoked"),
      viewerAuthorizationGeneration: opaqueIdSchema,
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
    codeEntryPolicy: codeEntryPolicySchema,
    expiresAt: z.string().datetime().nullable(),
    roomLeaseSeconds: z.number().int().positive(),
  })
  .strict();
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

export const createRoomRequestSchema = z
  .object({
    codeEntryPolicy: codeEntryPolicySchema,
    roomPassword: viewerPasswordSchema.nullable().optional(),
    preferredRoomId: roomCodeSchema.optional(),
  })
  .strict();

export const replaceRoomRequestSchema = z
  .object({
    codeEntryPolicy: codeEntryPolicySchema,
    roomPassword: viewerPasswordSchema.nullable().optional(),
  })
  .strict();
export type ReplaceRoomRequest = z.infer<typeof replaceRoomRequestSchema>;

export const roomAccessUpdateRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set-code-entry-policy"),
      policy: codeEntryPolicySchema,
    })
    .strict(),
  z.object({ action: z.literal("rotate-viewer-grant") }).strict(),
  z.object({ action: z.literal("revoke-viewer-grant") }).strict(),
  z
    .object({
      action: z.literal("set-viewer-password"),
      password: viewerPasswordSchema.nullable(),
    })
    .strict(),
]);
export type RoomAccessUpdateRequest = z.infer<
  typeof roomAccessUpdateRequestSchema
>;

export const roomAccessUpdateResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("code-entry-policy-updated"),
      codeEntryPolicy: codeEntryPolicySchema,
      viewerPasswordEnabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("viewer-grant-updated"),
      viewerAuthorizationGeneration: opaqueIdSchema,
      inviteUrl: z.string().url().max(2048).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("viewer-password-updated"),
      enabled: z.boolean(),
    })
    .strict(),
]);
export type RoomAccessUpdateResponse = z.infer<
  typeof roomAccessUpdateResponseSchema
>;

export function decodeClientMessage(value: string): ClientMessage {
  return clientMessageSchema.parse(JSON.parse(value));
}

export function decodeServerMessage(value: string): ServerMessage {
  return serverMessageSchema.parse(JSON.parse(value));
}
