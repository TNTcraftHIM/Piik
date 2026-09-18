// Private, development-only wire. Production room/media contracts are unchanged.
import { z } from "zod";

export const ROOM_LIMIT = 21;
export const SIGNAL_PATH = "/__interaction-signal";
export const propKeys = ["tomato", "poop", "heart"] as const;
const sourceKind = z.enum(["display", "camera"]);
export type SourceKind = z.infer<typeof sourceKind>;
const id = z.string().uuid();
const name = z.string().trim().min(1).max(24);
export const roomCode = z.string().regex(/^\d{4}$/);
const signal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("description"), type: z.enum(["offer", "answer"]), sdp: z.string().max(40_000) }),
  z.object({ kind: z.literal("candidate"), candidate: z.string().max(2_000),
    sdpMid: z.string().max(64).nullable(), sdpMLineIndex: z.number().int().min(0).max(16).nullable() }),
]);
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), room: roomCode, name }),
  z.object({ type: z.literal("prop"), target: id, prop: z.enum(propKeys) }),
  z.object({ type: z.literal("devices"), mic: z.boolean(), source: sourceKind.nullable() }),
  z.object({ type: z.literal("signal"), to: id, signal }),
]);
export type Command = z.infer<typeof commandSchema>;
const memberSchema = z.object({ id, name, role: z.enum(["host", "viewer"]), mic: z.boolean(), source: sourceKind.nullable() });
export type Member = z.infer<typeof memberSchema>;
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), self: id }),
  z.object({ type: z.literal("members"), members: z.array(memberSchema).max(ROOM_LIMIT) }),
  z.object({ type: z.literal("prop"), id, from: id, target: id, prop: z.enum(propKeys) }),
  z.object({ type: z.literal("signal"), from: id, signal }),
  z.object({ type: z.literal("error"), code: z.enum(["room-full", "host-only", "host-left", "not-sharing", "slow-down", "invalid", "target-left"]) }),
]);
export type RoomEvent = z.infer<typeof eventSchema>;
export type PropEvent = Extract<RoomEvent, { type: "prop" }>;
export type SignalEvent = Extract<RoomEvent, { type: "signal" }>;
