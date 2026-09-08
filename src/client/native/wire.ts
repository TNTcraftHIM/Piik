import { z } from "zod";
import { sfuMediaSchema } from "../../shared/protocol";

export const NATIVE_CLIENT_PROTOCOL = 9;
export const NATIVE_CLIENT_PORT_START = 39_721;
export const NATIVE_CLIENT_PORT_END = 39_730;
export const NATIVE_CLIENT_SUBPROTOCOL = "screener-client-v9";

const decimalIdentifierSchema = z.string().regex(/^[1-9]\d{0,19}$/);
const opaqueIdentifierSchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const nativeHealthSchema = z
  .object({
    protocol: z.literal(NATIVE_CLIENT_PROTOCOL),
    service: z.literal("screener-client"),
    port: z
      .number()
      .int()
      .min(NATIVE_CLIENT_PORT_START)
      .max(NATIVE_CLIENT_PORT_END),
    instanceToken: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]+$/),
    nativeMedia: z
      .object({
        video: z.boolean(),
        processAudio: z.boolean(),
        systemAudio: z.boolean(),
        hardwareH264: z.boolean(),
        softwareVP8: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type NativeHealth = z.infer<typeof nativeHealthSchema>;

const nativeWindowTargetSchema = z
  .object({
    kind: z.literal("window"),
    sourceId: decimalIdentifierSchema,
    pid: z.number().int().positive().max(0xffff_ffff),
    creationTime: decimalIdentifierSchema,
    title: z.string().min(1).max(4096),
  })
  .strict();

const nativeDisplayTargetSchema = z
  .object({
    kind: z.literal("display"),
    sourceId: decimalIdentifierSchema,
    title: z.string().min(1).max(4096),
  })
  .strict();

const nativePickerTargetSchema = z
  .object({
    kind: z.literal("picker"),
    sourceId: decimalIdentifierSchema,
    title: z.string().min(1).max(4096),
  })
  .strict();

export const nativeCaptureTargetSchema = z.discriminatedUnion("kind", [
  nativeWindowTargetSchema,
  nativeDisplayTargetSchema,
  nativePickerTargetSchema,
]);
export type NativeCaptureTarget = z.infer<typeof nativeCaptureTargetSchema>;

const nativeEncoderSchema = z
  .object({
    index: z.number().int().nonnegative().max(0xffff_ffff),
    name: z.string().min(1).max(512),
    identity: z.string().min(1).max(512),
  })
  .strict();

const nativeAdapterSchema = z
  .object({
    index: z.number().int().nonnegative().max(0xffff_ffff),
    name: z.string().min(1).max(512),
    identity: z.string().min(1).max(512),
    hardwareH264: z.array(nativeEncoderSchema).max(64),
  })
  .strict();
export type NativeAdapter = z.infer<typeof nativeAdapterSchema>;

const candidateSchema = z
  .object({
    candidate: z.string().max(4096),
    sdpMid: z.string().max(128).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

const responseBase = {
  version: z.literal(NATIVE_CLIENT_PROTOCOL),
  id: opaqueIdentifierSchema,
};

const nativeVideoCodecSchema = z.enum(["h264", "vp8"]);
export type NativeVideoCodec = z.infer<typeof nativeVideoCodecSchema>;

export const readyResponseSchema = z
  .object({ ...responseBase, type: z.literal("ready") })
  .strict();
export const pongResponseSchema = z
  .object({ ...responseBase, type: z.literal("pong") })
  .strict();
export const requestFailedResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("request-failed"),
    code: z.literal("operation-failed"),
  })
  .strict();
export const captureOptionsResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("capture-options"),
    adapters: z.array(nativeAdapterSchema).max(64),
  })
  .strict();
export const sourceListResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("source-list"),
    sources: z.array(nativeCaptureTargetSchema).max(1024),
  })
  .strict();
export const sourcePreviewResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("source-preview"),
    sourceKey: z.string().min(8).max(256),
    mime: z.literal("image/bmp"),
    data: z.string().max(256 * 1024),
  })
  .strict();
export const shareStartedResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("share-started"),
    shareId: opaqueIdentifierSchema,
    audio: z.boolean(),
    codec: nativeVideoCodecSchema,
  })
  .strict();
export const shareUpdatedResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("share-updated"),
    shareId: opaqueIdentifierSchema,
  })
  .strict();
export const shareSourceReplacedResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("share-source-replaced"),
    shareId: opaqueIdentifierSchema,
  })
  .strict();
export const edgeOfferResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("edge-offer"),
    shareId: opaqueIdentifierSchema,
    connectionId: opaqueIdentifierSchema,
    sdp: z
      .string()
      .min(1)
      .max(48 * 1024),
  })
  .strict();
export const receiveAnswerResponseSchema = z
  .object({
    ...responseBase,
    type: z.literal("receive-answer"),
    shareId: opaqueIdentifierSchema,
    connectionId: opaqueIdentifierSchema,
    sdp: z
      .string()
      .min(1)
      .max(48 * 1024),
    audio: z.boolean(),
    codec: nativeVideoCodecSchema,
  })
  .strict();

export const publicationResponseSchema = z
  .object({
    ...responseBase,
    type: z.enum(["publication-offer", "publication-media"]),
    shareId: opaqueIdentifierSchema,
    publicationGeneration: opaqueIdentifierSchema,
    connectionId: opaqueIdentifierSchema,
    sdp: z
      .string()
      .max(48 * 1024)
      .optional(),
    media: sfuMediaSchema,
  })
  .strict();

export const nativeAckResponseSchema = z
  .object({
    ...responseBase,
    type: z.enum([
      "edge-answer-accepted",
      "edge-candidate-accepted",
      "edge-closed",
      "receive-candidate-accepted",
      "receiver-closed",
      "receive-stopped",
      "share-stopped",
      "share-paused",
      "publication-answer-accepted",
      "publication-candidate-accepted",
      "publication-layers-accepted",
      "publication-closed",
    ]),
  })
  .strict();

const eventBase = {
  version: z.literal(NATIVE_CLIENT_PROTOCOL),
  shareId: opaqueIdentifierSchema,
};

export const nativeEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBase,
      type: z.literal("publication-quality"),
      publicationGeneration: opaqueIdentifierSchema,
      connectionId: opaqueIdentifierSchema,
      sampleTimestampMs: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      sampleWindowMs: z.number().int().min(1_000).max(5_000),
      rtpStatsId: z.string().min(1).max(256),
      trackIdentifier: z.string().min(1).max(256),
      codec: nativeVideoCodecSchema,
      videoEncodingCount: z.number().int().min(1).max(3),
      activeVideoEncodingCount: z.number().int().min(0).max(3),
      rid: z.string().max(16),
      intervalFramesSent: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      framesPerSecond: z.number().finite().nonnegative().max(240),
      width: z.number().int().nonnegative().max(16_384),
      height: z.number().int().nonnegative().max(16_384),
      bitrateKbps: z.number().finite().nonnegative().max(100_000),
      audioBitrateKbps: z.number().finite().nonnegative().max(1_000),
      availableOutgoingKbps: z
        .number()
        .finite()
        .nonnegative()
        .max(100_000)
        .nullable(),
      state: z.enum(["unknown", "healthy", "degraded"]),
      reason: z.enum(["none", "bandwidth"]).nullable(),
    })
    .strict()
    .refine(({ state, reason }) =>
      state === "unknown"
        ? reason === null
        : state === "healthy"
          ? reason === "none"
          : reason === "bandwidth",
    ),
  z
    .object({
      ...eventBase,
      type: z.literal("publication-candidate"),
      publicationGeneration: opaqueIdentifierSchema,
      connectionId: opaqueIdentifierSchema,
      candidate: candidateSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("publication-state"),
      publicationGeneration: opaqueIdentifierSchema,
      connectionId: opaqueIdentifierSchema,
      state: z.enum([
        "new",
        "connecting",
        "connected",
        "disconnected",
        "failed",
        "closed",
      ]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("capture-state"),
      state: z.enum(["starting", "active"]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("edge-candidate"),
      connectionId: opaqueIdentifierSchema,
      candidate: candidateSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("edge-state"),
      connectionId: opaqueIdentifierSchema,
      state: z.enum([
        "new",
        "connecting",
        "connected",
        "disconnected",
        "failed",
        "closed",
      ]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("edge-path"),
      connectionId: opaqueIdentifierSchema,
      localType: z.enum(["host", "srflx", "prflx", "relay"]),
      remoteType: z.enum(["host", "srflx", "prflx", "relay"]),
      natTraversalPath: z.enum(["unknown", "ordinary", "predicted"]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("edge-quality"),
      connectionId: opaqueIdentifierSchema,
      sampleTimestampMs: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      sampleWindowMs: z.number().int().min(1_000).max(5_000),
      rtpStatsId: z.string().min(1).max(256),
      trackIdentifier: z.string().min(1).max(256),
      state: z.enum(["unknown", "healthy", "degraded"]),
      reason: z.enum(["none", "bandwidth"]).nullable(),
      intervalFramesEncoded: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      framesPerSecond: z.number().finite().nonnegative().max(240),
      bitrateKbps: z.number().finite().nonnegative().max(100_000),
      availableOutgoingKbps: z.number().finite().nonnegative().max(100_000),
      width: z.number().int().nonnegative().max(16_384),
      height: z.number().int().nonnegative().max(16_384),
    })
    .strict()
    .superRefine((event, context) => {
      if (
        (event.state === "unknown" && event.reason !== null) ||
        (event.state === "healthy" && event.reason !== "none") ||
        (event.state === "degraded" && event.reason !== "bandwidth")
      ) {
        context.addIssue({
          code: "custom",
          message: "Native edge quality reason does not match its state",
          path: ["reason"],
        });
      }
    }),
  z
    .object({
      ...eventBase,
      type: z.literal("share-ended"),
      failed: z.boolean(),
    })
    .strict(),
]);
export type NativeClientEvent = z.infer<typeof nativeEventSchema>;

export type NativeIceCandidate = z.infer<typeof candidateSchema>;
