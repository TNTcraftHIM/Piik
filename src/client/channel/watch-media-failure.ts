import Hls, { type ErrorData } from "hls.js";

/** MediaError.message may contain a source URL; only its platform code is public. */
export function watchElementFailure(error: MediaError | null): string | null {
  if (!error) return null;
  if (error.code === 3) return "watch_media_decode_failed";
  if (error.code === 4) return "watch_media_unsupported";
  if (error.code === 2) return "watch_media_unavailable";
  return "watch_media_failed";
}

export function watchHlsFailure(error: Pick<ErrorData, "type" | "details">): string {
  if (error.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR
    || error.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR)
    return "watch_media_unsupported";
  if (error.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR || error.details === Hls.ErrorDetails.LEVEL_PARSING_ERROR)
    return "watch_invalid_manifest";
  if (error.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) return "watch_media_encryption_unsupported";
  if (error.type === Hls.ErrorTypes.NETWORK_ERROR) return "watch_media_unavailable";
  return "watch_media_failed";
}
