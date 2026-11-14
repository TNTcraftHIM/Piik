import { z } from "zod";

export const nativePageStateSchema = z.object({
  position: z.number().finite().nonnegative(), paused: z.boolean(), rate: z.number().positive().max(16),
  duration: z.number().finite().nonnegative().nullable(), readyState: z.number().int().min(0).max(4), ended: z.boolean(),
}).strict();
const nativePageURLSchema = z.string().url().max(4096).refine(value => /^https?:\/\//.test(value));
export const nativePageCandidateSchema = z.object({ id: z.uuid(), title: z.string().max(512).refine(value => [...value].length <= 256), url: nativePageURLSchema.nullable(), duration: z.number().finite().nonnegative().nullable() }).strict();
export type NativePageCandidate = z.infer<typeof nativePageCandidateSchema>;
export const nativePageMediaChoiceSchema = z.object({ id: z.uuid(), displayURL: nativePageURLSchema, name: z.string().max(512).refine(value => [...value].length <= 256), format: z.enum(["file", "hls"]) }).strict();
export type NativePageMediaChoice = z.infer<typeof nativePageMediaChoiceSchema>;
export const nativePageEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_candidates"), pageId: z.uuid(), url: nativePageURLSchema, candidates: z.array(nativePageCandidateSchema).max(64) }).strict(),
  z.object({ type: z.literal("page_sample"), pageId: z.uuid(), event: z.enum(["loadedmetadata", "loadeddata", "play", "playing", "pause", "seeked", "ratechange", "ended", "waiting", "error"]) }).strict(),
  z.object({ type: z.literal("page_closed"), pageId: z.uuid() }).strict(),
  z.object({ type: z.literal("page_blocked"), pageId: z.uuid() }).strict(),
]);
import { remoteControlModeSchema, remoteInputPlatformSchema, remoteShortcutKeySchema } from "../remote-control/protocol";

const decimalIdentifierSchema = z.string().regex(/^[1-9]\d{0,19}$/);

const opaqueIdentifierSchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

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
    sourceId: decimalIdentifierSchema.or(z.literal("0")),
    title: z.string().min(1).max(4096),
  })
  .strict();

export const nativeCaptureTargetSchema = z.discriminatedUnion("kind", [
  nativeWindowTargetSchema,
  nativeDisplayTargetSchema,
  nativePickerTargetSchema,
]);

export type NativeCaptureTarget = z.infer<typeof nativeCaptureTargetSchema>;

export const remoteStopShortcutSchema = z.object({ key: remoteShortcutKeySchema, available: z.boolean() });

export type RemoteStopShortcut = z.infer<typeof remoteStopShortcutSchema>;

export type EncodingExecution = "auto" | "software";

export const nativeVideoCodecSchema = z.enum(["h264", "vp8"]);

const remoteControlRequestSchema = z.object({
  id: opaqueIdentifierSchema,
  peerId: opaqueIdentifierSchema,
  state: z.enum(["pending", "active", "suspended"]),
  endpointId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
}).strict();

export type RemoteControlRequest = z.infer<typeof remoteControlRequestSchema>;

export const remoteControlStateSchema = z.object({ mode: remoteControlModeSchema, platform: remoteInputPlatformSchema, requests: z.array(remoteControlRequestSchema), coPlay: z.boolean().optional(), gamepad: z.boolean().optional(), simultaneous: z.boolean().optional() });
