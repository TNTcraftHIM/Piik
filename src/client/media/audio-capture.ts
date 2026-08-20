/**
 * Best-effort display-audio hints for Chromium. The Screen Capture API does
 * not expose a portable readback for the selected audio source, so callers
 * must keep the requested scope separate from the observed track presence.
 */

export type BrowserAudioScope = "window-requested-unconfirmed" | "none";

export interface BrowserAudioCaptureStatus {
  hasTrack: boolean;
  scope: BrowserAudioScope;
}

type DisplayMediaAudioHints = DisplayMediaStreamOptions & {
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
};

/**
 * Ask Chromium to prefer audio from the selected display surface while
 * excluding the whole-system source. Unknown dictionary members are ignored
 * by older browsers; no fallback is added because silently widening to
 * whole-system audio would leak sound.
 */
export function displayMediaOptions(
  video: MediaTrackConstraints,
): DisplayMediaStreamOptions {
  return {
    video,
    audio: true,
    systemAudio: "exclude",
    windowAudio: "window",
  } as DisplayMediaAudioHints;
}

export function browserAudioCaptureStatus(
  stream: MediaStream,
): BrowserAudioCaptureStatus {
  const hasTrack = stream.getAudioTracks().length > 0;
  return {
    hasTrack,
    scope: hasTrack ? "window-requested-unconfirmed" : "none",
  };
}
