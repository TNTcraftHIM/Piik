import { z } from "zod";
import { viewerRoutePreferenceSchema } from "../../shared/protocol";
import { remoteControlModeSchema } from "../remote-control/protocol";

const STORAGE_KEY = "piik:room-preferences:v1";
export const CHAT_OVERLAY_LIMITS = { scale: [.8, 1.3], opacity: [.4, 1] } as const;
export const REMOTE_KEYBOARD_PAGES = ["letters", "symbols", "functions", "text"] as const;

const roomPreferencesSchema = z.object({
  pictureFit: z.enum(["contain", "cover", "fill"]).default("contain"),
  routePreference: viewerRoutePreferenceSchema.default("auto"),
  overlayEnabled: z.boolean().default(false),
  overlayAppearance: z.object({
    scale: z.number().min(CHAT_OVERLAY_LIMITS.scale[0]).max(CHAT_OVERLAY_LIMITS.scale[1]),
    opacity: z.number().min(CHAT_OVERLAY_LIMITS.opacity[0]).max(CHAT_OVERLAY_LIMITS.opacity[1]),
  }).default({ scale: 1, opacity: 1 }),
  interactionEffects: z.boolean().default(true),
  keyboardPage: z.enum(REMOTE_KEYBOARD_PAGES).default("letters"),
  keepModifiers: z.boolean().default(false),
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
