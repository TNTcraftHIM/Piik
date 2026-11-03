import { z } from "zod";
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

export const nativeVideoCodecSchema = z.enum(["h264", "vp8"]);

const remoteControlRequestSchema = z.object({
  id: opaqueIdentifierSchema,
  peerId: opaqueIdentifierSchema,
  state: z.enum(["pending", "active", "suspended"]),
  endpointId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
}).strict();

export type RemoteControlRequest = z.infer<typeof remoteControlRequestSchema>;

export const remoteControlStateSchema = z.object({ mode: remoteControlModeSchema, platform: remoteInputPlatformSchema, requests: z.array(remoteControlRequestSchema), coPlay: z.boolean().optional(), gamepad: z.boolean().optional(), simultaneous: z.boolean().optional() });
