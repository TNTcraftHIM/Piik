import { z } from "zod";
import { MAX_RELAY_CAPACITY } from "../../shared/relay-capacity";
import { remoteControlModeSchema, remoteShortcutKeySchema } from "../remote-control/protocol";
import { feedbackClipSchema } from "../channel/feedback-clip";
import { voiceShortcutBindingSchema } from "../channel/voice-shortcut-binding";
import { microphoneModes, SPEAKING_LEVEL_DBFS, VOICE_ACTIVATION_RANGE_DBFS } from "../media/voice-gate";

const STORAGE_KEY = "piik:room-preferences:v1";
export const CHAT_OVERLAY_LIMITS = { scale: [.8, 1.3], opacity: [.4, 1], speed: [.5, 1.5] } as const;
export const CHAT_OVERLAY_DEFAULTS = { scale: 1, opacity: 1, speed: 1, colorBySender: false };
export const REMOTE_KEYBOARD_PAGES = ["letters", "symbols", "functions", "text"] as const;
const interfaceLayoutSchema = z.enum(["workspace", "quick"]);
export type InterfaceLayout = z.infer<typeof interfaceLayoutSchema>;
/** A room page layout. "living" is an unaccepted prototype, selected only by the room preview; it is never stored. */
export type RoomLayout = InterfaceLayout | "living";
const unitCoordinate = z.number().min(0).max(1);
const stickPosition = z.object({ x: unitCoordinate, y: unitCoordinate });

const roomPreferencesSchema = z.object({
  feedbackSound: z.object({ enabled: z.boolean(), volume: z.number().min(0).max(1),
    muted: z.object({ message: z.boolean().optional(), throw: z.boolean().optional() }).optional(),
    clips: z.object({ message: feedbackClipSchema.optional(), throw: feedbackClipSchema.optional() }).optional(),
  }).default({ enabled: false, volume: 1 }),
  sharingView: z.boolean().default(false),
  interfaceLayout: interfaceLayoutSchema.optional(),
  screenBufferTargetMs: z.number().min(0).max(4000).nullable().default(null),
  pictureFit: z.enum(["contain", "cover", "fill"]).default("contain"),
  pictureRotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).catch(0).default(0),
  previewAutoPause: z.boolean().default(true),
  forwardingLimitByIdentity: z.record(z.string(), z.number().int().min(-1).max(MAX_RELAY_CAPACITY)).default({}),
  overlayEnabled: z.boolean().default(false),
  overlayAppearance: z.object({
    scale: z.number().min(CHAT_OVERLAY_LIMITS.scale[0]).max(CHAT_OVERLAY_LIMITS.scale[1]),
    opacity: z.number().min(CHAT_OVERLAY_LIMITS.opacity[0]).max(CHAT_OVERLAY_LIMITS.opacity[1]),
    speed: z.number().min(CHAT_OVERLAY_LIMITS.speed[0]).max(CHAT_OVERLAY_LIMITS.speed[1]).default(CHAT_OVERLAY_DEFAULTS.speed),
    colorBySender: z.boolean().default(CHAT_OVERLAY_DEFAULTS.colorBySender),
  }).default(CHAT_OVERLAY_DEFAULTS),
  voiceInput: z.object({ deviceId: z.string(), volume: z.number().min(0).max(2), voiceProcessing: z.boolean(), strongerSuppression: z.boolean().optional() })
    .default({ deviceId: "", volume: 1, voiceProcessing: true }),
  voiceListeningVolume: z.number().min(0).max(2).default(1),
  voiceTransmission: z.object({
    mode: z.enum(microphoneModes),
    activationThreshold: z.number().min(VOICE_ACTIVATION_RANGE_DBFS[0]).max(VOICE_ACTIVATION_RANGE_DBFS[1]),
  }).catch({ mode: "open", activationThreshold: SPEAKING_LEVEL_DBFS }),
  voiceShortcuts: z.object({
    microphone: voiceShortcutBindingSchema.nullable().optional(),
    listening: voiceShortcutBindingSchema.nullable().optional(),
    talk: voiceShortcutBindingSchema.nullable().optional(),
  }).catch({}).default({}),
  keyboardPage: z.enum(REMOTE_KEYBOARD_PAGES).default("letters"),
  combineKeys: z.boolean().default(false),
  remoteReleaseKey: remoteShortcutKeySchema.default(10),
  remoteStopKey: remoteShortcutKeySchema.default(10),
  virtualSticksEnabled: z.boolean().default(true),
  stickPositions: z.object({ left: stickPosition.optional(), right: stickPosition.optional() }).default({}),
  touchOnlySticks: z.boolean().default(false),
  remoteTouchMode: z.enum(["direct", "trackpad"]).default("direct"),
  remoteControlMode: remoteControlModeSchema.exclude(["off"]).default("ask"),
});
export type RoomPreferences = z.infer<typeof roomPreferencesSchema>;
let cached: { stored: string; preferences: RoomPreferences } | undefined;

// Personal choices belong to this Browser origin, never to a room grant or
// held input. Other preference owners (quality, language, theme) stay separate.
export function readRoomPreferences(): RoomPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (cached && cached.stored === stored) return structuredClone(cached.preferences);
    cached = undefined;
    const result = roomPreferencesSchema.safeParse(stored ? JSON.parse(stored) : {});
    if (result.success) {
      if (stored && typeof structuredClone === "function") {
        cached = { stored, preferences: structuredClone(result.data) };
      }
      return result.data;
    }
  } catch {
    // Room tools remain usable when optional Browser storage is unavailable.
  }
  return roomPreferencesSchema.parse({});
}

export function saveRoomPreferences(patch: Partial<RoomPreferences>): boolean {
  const result = roomPreferencesSchema.safeParse({ ...readRoomPreferences(), ...patch });
  if (!result.success) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result.data));
    return true;
  } catch {
    // Ordinary preferences may remain usable in memory; persistent imports check this result.
    return false;
  }
}
