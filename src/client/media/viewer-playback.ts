export type ScreenPlaybackError = 3 | 4;

export function elementPlaybackError(error: MediaError | null): ScreenPlaybackError | undefined {
  const code = error?.code;
  return code === 3 || code === 4 ? code : undefined;
}

export function playbackFailure(error: unknown): "autoplay-blocked" | "playback-failed" | null {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
  // pause()/load() cancel pending play promises; cancellation is not failed media.
  if (name === "AbortError") return null;
  return name === "NotAllowedError" ? "autoplay-blocked" : "playback-failed";
}
