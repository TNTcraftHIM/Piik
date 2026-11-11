import { z } from "zod";

export const FEEDBACK_CLIP_MAX_BYTES = 256 * 1024;
export const FEEDBACK_CLIP_MAX_DURATION = 3;
export const feedbackClipSchema = z.object({
  name: z.string().min(1).max(128),
  data: z.string().min(4).max(Math.ceil(FEEDBACK_CLIP_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine(data => data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) <= FEEDBACK_CLIP_MAX_BYTES),
}).strict();
export type FeedbackClip = z.infer<typeof feedbackClipSchema>;

export function feedbackClipBytes(clip: FeedbackClip): ArrayBuffer {
  return Uint8Array.from(atob(clip.data), character => character.charCodeAt(0)).buffer;
}

export function checkFeedbackDuration(buffer: AudioBuffer): void {
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > FEEDBACK_CLIP_MAX_DURATION) {
    throw new Error("feedback_clip_too_long");
  }
}

/** Validate local bytes before the preference owner replaces either sound slot. */
export async function validateCustomFeedbackClip(file: File): Promise<FeedbackClip> {
  if (!file.size || file.size > FEEDBACK_CLIP_MAX_BYTES) throw new Error("feedback_clip_too_large");
  const bytes = await file.arrayBuffer();
  let decoded: AudioBuffer;
  try { decoded = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(bytes.slice(0)); }
  catch { throw new Error("feedback_clip_invalid"); }
  checkFeedbackDuration(decoded);
  return { name: file.name.slice(0, 128) || "Audio", data: btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join("")) };
}
