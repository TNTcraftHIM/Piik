/** MediaError.message may contain a source URL; only its platform code is public. */
export function watchElementFailure(error: MediaError | null): string | null {
  if (!error) return null;
  if (error.code === 3) return "watch_media_decode_failed";
  // SRC_NOT_SUPPORTED also covers an unusable source response, not only codecs.
  if (error.code === 4) return "watch_media_unsupported";
  if (error.code === 2) return "watch_media_unavailable";
  return "watch_media_failed";
}
