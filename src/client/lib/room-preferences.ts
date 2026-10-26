import { z } from "zod";
import { viewerRoutePreferenceSchema } from "../../shared/protocol";
import { remoteControlModeSchema, remoteShortcutKeySchema } from "../remote-control/protocol";

const STORAGE_KEY = "piik:room-preferences:v1";
export const CHAT_OVERLAY_LIMITS = { scale: [.8, 1.3], opacity: [.4, 1], speed: [.5, 1.5] } as const;
export const CHAT_OVERLAY_DEFAULTS = { scale: 1, opacity: 1, speed: 1, colorBySender: false };
export const REMOTE_KEYBOARD_PAGES = ["letters", "symbols", "functions", "text"] as const;

const roomPreferencesSchema = z.object({
  pictureFit: z.enum(["contain", "cover", "fill"]).default("contain"),
  pictureRotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).catch(0).default(0),
  previewAutoPause: z.boolean().default(true),
  routePreference: viewerRoutePreferenceSchema.default("auto"),
  overlayEnabled: z.boolean().default(false),
  overlayAppearance: z.object({
    scale: z.number().min(CHAT_OVERLAY_LIMITS.scale[0]).max(CHAT_OVERLAY_LIMITS.scale[1]),
    opacity: z.number().min(CHAT_OVERLAY_LIMITS.opacity[0]).max(CHAT_OVERLAY_LIMITS.opacity[1]),
    speed: z.number().min(CHAT_OVERLAY_LIMITS.speed[0]).max(CHAT_OVERLAY_LIMITS.speed[1]).default(CHAT_OVERLAY_DEFAULTS.speed),
    colorBySender: z.boolean().default(CHAT_OVERLAY_DEFAULTS.colorBySender),
  }).default(CHAT_OVERLAY_DEFAULTS),
  voiceInput: z.object({ deviceId: z.string(), volume: z.number().min(0).max(2), voiceProcessing: z.boolean() })
    .default({ deviceId: "", volume: 1, voiceProcessing: true }),
  voiceListeningVolume: z.number().min(0).max(2).default(1),
  keyboardPage: z.enum(REMOTE_KEYBOARD_PAGES).default("letters"),
  combineKeys: z.boolean().default(false),
  remoteReleaseKey: remoteShortcutKeySchema.default(10),
  remoteStopKey: remoteShortcutKeySchema.default(10),
  remoteTouchMode: z.enum(["direct", "trackpad"]).default("direct"),
  remoteControlMode: remoteControlModeSchema.exclude(["off"]).default("ask"),
});
export type RoomPreferences = z.infer<typeof roomPreferencesSchema>;

// Personal choices belong to this Browser origin, never to a room grant or
// held input. Other preference owners (quality, language, theme) stay separate.
export function readRoomPreferences(): RoomPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const result = roomPreferencesSchema.safeParse(stored ? JSON.parse(stored) : {});
    if (result.success) return result.data;
  } catch {
    // Room tools remain usable when optional Browser storage is unavailable.
  }
  return roomPreferencesSchema.parse({});
}

export function saveRoomPreferences(patch: Partial<RoomPreferences>): void {
  const result = roomPreferencesSchema.safeParse({ ...readRoomPreferences(), ...patch });
  if (!result.success) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result.data));
  } catch {
    // A preference write must not turn an applied action into a failure.
  }
}
