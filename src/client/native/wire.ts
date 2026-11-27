import { z } from "zod";
import { watchFormatSchema } from "../../shared/watch-format";

const voiceShortcutStatusSchema = z.enum(["registered", "unavailable", "unbound"]);
export const nativeVoiceShortcutsReportSchema = z.strictObject({
  microphone: voiceShortcutStatusSchema, listening: voiceShortcutStatusSchema,
});
export type NativeVoiceShortcutsReport = z.infer<typeof nativeVoiceShortcutsReportSchema>;

export const nativeVoiceShortcutEventSchema = z.strictObject({
  type: z.literal("voice_shortcut"), action: z.enum(["toggle_microphone", "toggle_listening"]),
  activatedAtMs: z.number().int().positive().safe(),
});

export const unsupportedVideoFormatSchema = z.object({
  codec: z.literal("h264"), profileIdc: z.number().int().min(0).max(255),
  constraintFlags: z.number().int().min(0).max(255), levelIdc: z.number().int().min(0).max(255),
});
export type UnsupportedVideoFormat = z.infer<typeof unsupportedVideoFormatSchema>;

export const nativePageStateSchema = z.object({
  position: z.number().finite().nonnegative(), paused: z.boolean(), rate: z.number().positive().max(16),
  duration: z.number().finite().nonnegative().nullable(), readyState: z.number().int().min(0).max(4), ended: z.boolean(),
  buffered: z.array(z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]).refine(([start, end]) => end >= start)),
}).strict();
const nativePageURLSchema = z.string().url().max(4096).refine(value => /^https?:\/\//.test(value));
export const nativePageCandidateSchema = z.object({ id: z.uuid(), pageURL: nativePageURLSchema.nullable(), title: z.string().max(512).refine(value => [...value].length <= 256), url: nativePageURLSchema.nullable(), duration: z.number().finite().nonnegative().nullable() });
export type NativePageCandidate = z.infer<typeof nativePageCandidateSchema>;
export const nativePageMediaChoiceSchema = z.object({ id: z.uuid(), displayURL: nativePageURLSchema, name: z.string().max(512).refine(value => [...value].length <= 256), format: watchFormatSchema }).strict();
export type NativePageMediaChoice = z.infer<typeof nativePageMediaChoiceSchema>;
export const nativePageMpdCandidateSchema = z.object({
  id: z.uuid(), name: z.string().max(512).refine(value => [...value].length <= 256),
  hostname: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:[\]-]+$/),
}).strict();
export type NativePageMpdCandidate = z.infer<typeof nativePageMpdCandidateSchema>;
const nativePageMpdTrackSchema = z.object({
  id: z.uuid(), kind: z.enum(["video", "audio"]),
  label: z.string(), mimeType: z.string().max(256), codec: z.string().max(128),
  language: z.string().max(256), role: z.string().max(256),
  width: z.number().int().positive().safe().nullable(), height: z.number().int().positive().safe().nullable(),
  bandwidth: z.number().int().positive().safe().nullable(), frameRate: z.number().finite().positive().nullable(),
}).strict();
export const nativePageMpdCatalogSchema = z.object({ sourceId: z.uuid(), tracks: z.array(nativePageMpdTrackSchema).min(1) }).strict();
export type NativePageMpdCatalog = z.infer<typeof nativePageMpdCatalogSchema>;
export const nativePageMpdSelectionSchema = z.object({ sourceId: z.uuid(), videoId: z.uuid(), audioId: z.uuid().optional() })
  .strict().refine(value => value.videoId !== value.audioId);
export type NativePageMpdSelection = z.infer<typeof nativePageMpdSelectionSchema>;
export const NATIVE_PAGE_READ_BYTES = 64 * 1024;
export const NATIVE_PAGE_METADATA_PREFIX_BYTES = 1024 * 1024;
export const nativePageIndexedCandidateSchema = z.object({
  id: z.uuid(), name: z.string().max(512).refine(value => [...value].length <= 256), hostname: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:[\]-]+$/),
  mimeType: z.string().max(256), totalSize: z.number().int().positive().safe(),
}).strict();
export type NativePageIndexedCandidate = z.infer<typeof nativePageIndexedCandidateSchema>;
export const nativePageMetadataReadSchema = z.object({
  choiceId: z.uuid(), offset: z.number().int().nonnegative().safe(),
  length: z.number().int().positive().max(NATIVE_PAGE_READ_BYTES),
}).strict().refine(value => value.offset + value.length <= NATIVE_PAGE_METADATA_PREFIX_BYTES);
const nativePageBase64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const nativePageMetadataResultSchema = z.object({
  mimeType: z.string().max(256), totalSize: z.number().int().positive().safe(),
  bytesBase64: nativePageBase64Schema.max(4 * Math.ceil(NATIVE_PAGE_READ_BYTES / 3)),
}).strict();
export const nativePageResourceReadSchema = z.object({
  sourceId: z.uuid(), resourceId: z.uuid(), offset: z.number().int().nonnegative().safe(),
  length: z.number().int().positive().max(NATIVE_PAGE_READ_BYTES),
}).strict().refine(value => Number.isSafeInteger(value.offset + value.length));
export const nativePageResourceResultSchema = z.object({
  mimeType: z.string().max(256), totalSize: z.number().int().nonnegative().safe().nullable(), eof: z.boolean(),
  bytesBase64: nativePageBase64Schema.max(4 * Math.ceil(NATIVE_PAGE_READ_BYTES / 3)),
}).strict();
export const nativePageIndexedTrackRecipeSchema = z.object({
  choiceId: z.uuid(), totalSize: z.number().int().positive().safe(),
  codec: z.string().min(1).max(128).regex(/^[!#$%&'*+\-.^_`{|}~0-9A-Za-z]+$/),
  timescale: z.number().int().positive().max(0xffffffff), mediaOffset: z.number().int().nonnegative().safe(),
  initBase64: nativePageBase64Schema.min(4).max(4 * Math.ceil(NATIVE_PAGE_METADATA_PREFIX_BYTES / 3)),
  // SIDX uses u16 reference_count, u31 referenced_size and u32 subsegment_duration.
  segments: z.array(z.tuple([z.number().int().positive().max(0x7fffffff), z.number().int().positive().max(0xffffffff)])).min(1).max(0xffff),
}).strict().refine(value => {
  let end = value.mediaOffset, ticks = 0;
  for (const [length, duration] of value.segments) {
    end += length; ticks += duration;
    if (!Number.isSafeInteger(end) || end > value.totalSize || !Number.isSafeInteger(ticks)) return false;
  }
  return true;
});
export type NativePageIndexedTrackRecipe = z.infer<typeof nativePageIndexedTrackRecipeSchema>;
export const nativePageIndexedSelectionSchema = z.object({
  video: nativePageIndexedTrackRecipeSchema, audio: nativePageIndexedTrackRecipeSchema.optional(),
}).strict().refine(value => value.video.choiceId !== value.audio?.choiceId);
export type NativePageIndexedSelection = z.infer<typeof nativePageIndexedSelectionSchema>;
export const nativePageEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_media_changed"), pageId: z.uuid() }).strict(),
  z.object({ type: z.literal("page_selection_lost"), pageId: z.uuid(), candidateId: z.uuid() }).strict(),
  z.object({ type: z.literal("page_candidates"), pageId: z.uuid(), url: nativePageURLSchema, candidates: z.array(nativePageCandidateSchema).max(64) }),
  z.object({ type: z.literal("page_sample"), pageId: z.uuid(), candidateId: z.uuid(), event: z.enum(["emptied", "loadedmetadata", "loadeddata", "play", "playing", "pause", "seeked", "ratechange", "ended", "waiting", "error"]) }).strict(),
  z.object({ type: z.literal("page_share_requested"), pageId: z.uuid() }).strict(),
  z.object({ type: z.literal("page_closed"), pageId: z.uuid() }).strict(),
  z.object({ type: z.literal("page_blocked"), pageId: z.uuid(), candidateId: z.uuid() }).strict(),
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
}).strict();

export type RemoteControlRequest = z.infer<typeof remoteControlRequestSchema>;

export const remoteControlStateSchema = z.object({ mode: remoteControlModeSchema, platform: remoteInputPlatformSchema, requests: z.array(remoteControlRequestSchema), gamepad: z.boolean().optional(), simultaneous: z.boolean().optional() });
