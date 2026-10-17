import { z } from "zod";

export const remoteControlModeSchema = z.enum(["off", "ask", "room", "password"]);
export type RemoteControlMode = z.infer<typeof remoteControlModeSchema>;

export const remoteInputStateSchema = z.object({
  state: z.enum(["ready", "unavailable", "pending", "active", "suspended", "failed"]),
  mode: remoteControlModeSchema,
  grant: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  intent: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  reason: z.enum(["password", "retry", "busy"]).optional(),
}).strict();
export type RemoteInputState = z.infer<typeof remoteInputStateSchema>;
