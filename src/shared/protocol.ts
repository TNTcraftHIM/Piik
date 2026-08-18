import { z } from "zod";

export const MAX_VIEWERS_PER_ROOM_LIMIT = 16;
export const MAX_SIGNAL_BYTES = 64 * 1024;
export const ROOM_CODE_LENGTH = 12;

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

export const roomCodeSchema = z
  .string()
  .min(1)
  .max(ROOM_CODE_LENGTH)
  .regex(/^[1-9]\d*$/);

export const roleSchema = z.enum(["host", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

const iceServerSchema = z
  .object({
    urls: z.union([
      z.string().min(1).max(512),
      z.array(z.string().min(1).max(512)).min(1).max(8),
    ]),
    username: z.string().max(512).optional(),
    credential: z.string().max(512).optional(),
  })
  .strict();

export const iceConfigSchema = z
  .object({
    iceServers: z.array(iceServerSchema).max(8),
    expiresAt: z.string().datetime().nullable(),
    relayAvailable: z.boolean(),
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

const authenticateMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      type: z.literal("authenticate"),
      roomId: roomCodeSchema,
      role: z.literal("host"),
      token: tokenSchema,
      clientId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("authenticate"),
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
      connectionId: opaqueIdSchema,
      rebuild: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("refresh-ice") }).strict(),
  z.object({ type: z.literal("stop-sharing") }).strict(),
  // Kept as a compatibility alias while previously deployed clients age out.
  z.object({ type: z.literal("close-room") }).strict(),
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

export const serverMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("authenticated"),
      role: roleSchema,
      peerId: opaqueIdSchema,
      roomExpiresAt: z.string().datetime().nullable(),
      maxViewers: z.number().int().min(1).max(MAX_VIEWERS_PER_ROOM_LIMIT),
      hostOnline: z.boolean(),
      connectionId: opaqueIdSchema.nullable(),
      viewerPeerIds: z.array(opaqueIdSchema).max(MAX_VIEWERS_PER_ROOM_LIMIT),
      iceConfig: iceConfigSchema,
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
      type: z.literal("ice-config"),
      iceConfig: iceConfigSchema,
    })
    .strict(),
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
