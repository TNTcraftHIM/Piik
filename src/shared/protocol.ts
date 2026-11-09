import { z } from "zod";
import { MAX_CHAT_CODE_POINTS, normalizeChatText, REACTION_IDS, isThrow } from "./room-interactions.js";

export const MAX_VIEWERS_PER_ROOM_LIMIT = 20;
export const VIEWER_QUALITY_EVIDENCE_INTERVAL_MS = 2_000;
export const PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS = 3;

const opaqueIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const chatPayloadSchema = z.object({ kind: z.literal("chat"),
  text: z.string().min(1).max(MAX_CHAT_CODE_POINTS * 2)
    .refine(value => normalizeChatText(value) === value) }).strict();
const reactionPayloadSchema = z.object({ kind: z.literal("reaction"),
  reaction: z.string().min(1).max(32).regex(/^[a-z][a-z0-9-]*$/),
  targetPeerId: opaqueIdSchema.optional() }).strict()
  .refine(payload => !isThrow(payload.reaction) || !!payload.targetPeerId,
  { message: "Throwing a prop requires a participant" });
// Commands require a registered effect; received events may carry a future
// display-only identifier. Identity, payload shape and target bounds stay strict.
export const interactionPayloadSchema = z.discriminatedUnion("kind", [
  chatPayloadSchema, reactionPayloadSchema.safeExtend({ reaction: z.enum(REACTION_IDS) }),
]);
export type InteractionPayload = z.infer<typeof interactionPayloadSchema>;

// Describes a requested ceiling, not encoder availability or an allocation.
// WebRTC uses unsigned-long dimensions/bitrates and a double frame rate.
// Alignment, usable ranges and allocation budgets belong to the media adapter.
export const positiveUint32Schema = z.number().int().positive().max(0xffff_ffff);
export const qualityResolutionSchema = z.object({
  width: positiveUint32Schema,
  height: positiveUint32Schema,
}).strict();
export type QualityResolution = z.infer<typeof qualityResolutionSchema>;

export const degradationPreferenceSchema = z.enum([
  "maintain-resolution",
  "balanced",
  "maintain-framerate",
]);
export type DegradationPreference = z.infer<
  typeof degradationPreferenceSchema
>;

export const MIN_AUDIO_BITRATE = 6_000;
export const MAX_AUDIO_BITRATE = 510_000;
export const maxAudioBitrateSchema = z.number().int().min(MIN_AUDIO_BITRATE).max(MAX_AUDIO_BITRATE);

export const qualitySettingsSchema = z
  .object({
    resolution: qualityResolutionSchema,
    maxFramerate: z.number().positive().max(Number.MAX_SAFE_INTEGER),
    maxBitrate: positiveUint32Schema,
    degradationPreference: degradationPreferenceSchema,
    maxAudioBitrate: maxAudioBitrateSchema.optional(),
  })
  .strict();
export type QualitySettings = z.infer<typeof qualitySettingsSchema>;
export const videoCeilingSchema = qualitySettingsSchema.pick({ resolution: true, maxFramerate: true, maxBitrate: true });
export type VideoCeiling = z.infer<typeof videoCeilingSchema>;
export const videoSettingsSchema = z.object({ ceiling: videoCeilingSchema, degradationPreference: degradationPreferenceSchema }).strict();
export type VideoSettings = z.infer<typeof videoSettingsSchema>;
export const DEFAULT_QUALITY_SETTINGS = {
  resolution: { width: 1920, height: 1080 },
  maxFramerate: 30,
  maxBitrate: 5_000_000,
  degradationPreference: "balanced",
  maxAudioBitrate: 128000,
} as const satisfies QualitySettings;
export const viewerRoutePreferenceSchema = z.enum(["auto", "p2p", "sfu"]);
export type ViewerRoutePreference = z.infer<typeof viewerRoutePreferenceSchema>;

export type CodeEntryPolicy = "open" | "private";
export type MediaRouteUpstream =
  | { kind: "none" }
  | { kind: "peer"; peerId: string }
  | { kind: "sfu" };
export interface ViewerPresenceEntry {
  role: "viewer";
  peerId: string;
  displayName: string;
  upstream: MediaRouteUpstream;
  mediaReady?: true;
}
export type ParticipantPresenceEntry = ViewerPresenceEntry | {
  role: "host";
  peerId: string;
  displayName: string;
  upstream: { kind: "none" };
};

export type RoomVoiceCommand =
  | { action: "join" }
  | { action: "leave" }
  | { action: "publish" }
  | { action: "unpublish"; publicationId: string }
  | { action: "deafen"; deafened: boolean }
  | { action: "bitrate"; bitrate: number };
export interface RoomVoiceState {
  type: "room-voice-state";
  bitrate?: number;
  revision: number;
  enabled: boolean;
  hostPeerId: string | null;
  members: {
    peerId: string;
    connected: boolean;
    joined: boolean;
    upstream: MediaRouteUpstream;
    publicationId?: string;
    deafened?: boolean;
  }[];
  publications: { id: string; peerId: string }[];
  connections: {
    connectionId: string;
    parentPeerId?: string;
    childPeerId: string;
    transport: "peer" | "sfu";
    pending: boolean;
    revision: number;
    send: string[];
    receive: string[];
  }[];
  unavailable: string[];
}
