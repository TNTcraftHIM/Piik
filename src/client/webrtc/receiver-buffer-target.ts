export type PlaybackBufferStatus = "supported" | "unsupported" | "failed" | null;
// W3C RTCRtpReceiver.jitterBufferTarget accepts 0..4000 milliseconds, or null.
export const MAX_PLAYBACK_BUFFER_TARGET_MS = 4000;

export function validatePlaybackBufferTarget(target: number | null): void {
  if (target !== null && (!Number.isFinite(target) || target < 0 || target > MAX_PLAYBACK_BUFFER_TARGET_MS)) {
    throw new RangeError("Playback buffer target must be null or 0..4000 milliseconds");
  }
}

/** Only the receiving owner supplies current screen video/source-audio receivers. */
export function applyPlaybackBufferTarget(receivers: readonly RTCRtpReceiver[], target: number | null): PlaybackBufferStatus {
  validatePlaybackBufferTarget(target);
  let status: PlaybackBufferStatus = null;
  for (const receiver of receivers) {
    if (!("jitterBufferTarget" in receiver)) { if (status !== "failed") status = "unsupported"; continue; }
    try {
      const buffered = receiver as RTCRtpReceiver & { jitterBufferTarget: number | null };
      if (buffered.jitterBufferTarget !== target) buffered.jitterBufferTarget = target;
      status ??= "supported";
    } catch { status = "failed"; }
  }
  return status;
}
