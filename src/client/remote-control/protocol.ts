import { z } from "zod";

// A text submission still fits one encrypted input packet and the existing queue.
export const REMOTE_TEXT_BYTES = 2048;
// F12 is reserved by Windows debuggers, including for global modified chords.
export const remoteShortcutKeySchema = z.number().int().min(1).max(11);
export const REMOTE_SHORTCUT_KEYS = Array.from({ length: 11 }, (_, index) => index + 1);

export function matchesRemoteShortcut(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing">, key: number): boolean {
  return !event.isComposing && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.code === `F${key}`;
}

export const remoteControlModeSchema = z.enum(["off", "ask", "room", "password"]);
export type RemoteControlMode = z.infer<typeof remoteControlModeSchema>;
export const remoteInputPlatformSchema = z.enum(["windows", "darwin", "linux"]);
export type RemoteInputPlatform = z.infer<typeof remoteInputPlatformSchema>;

export const remoteInputStateSchema = z.object({
  state: z.enum(["ready", "unavailable", "pending", "active", "suspended", "failed"]),
  mode: remoteControlModeSchema,
  platform: remoteInputPlatformSchema,
  grant: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  intent: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  reason: z.enum(["password", "retry", "busy", "gamepad"]).optional(),
  capabilities: z.array(z.string().min(1).max(32)).max(16).optional(),
  coPlay: z.boolean().optional(),
  pointer: z.boolean().optional(),
  device: z.literal("gamepad").optional(),
}).strict();
export type RemoteInputState = z.infer<typeof remoteInputStateSchema>;

export interface RemoteGamepadReport {
  buttons: number;
  leftTrigger: number;
  rightTrigger: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}
