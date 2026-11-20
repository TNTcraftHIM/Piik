import Hls, { type ErrorData } from "hls.js";
export { default as Hls, M3U8Parser, PlaylistLevelType } from "hls.js";
export function watchHlsFailure(error: Pick<ErrorData, "type" | "details" | "response">, fromReader = false): string {
  if (error.type === Hls.ErrorTypes.NETWORK_ERROR && (error.response?.code === 401 || error.response?.code === 403)) return "watch_media_access_denied";
  const readCode = error.response?.text;
  if (fromReader && error.type === Hls.ErrorTypes.NETWORK_ERROR && error.response?.code === 0 && readCode
    && /^watch_(?:path_unavailable|read_(?:timeout|busy)|source_(?:failed|unavailable|changed|retired)|resource_limit)$/.test(readCode)) return readCode;
  if (error.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR
    || error.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR)
    return "watch_media_unsupported";
  if (error.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR || error.details === Hls.ErrorDetails.LEVEL_PARSING_ERROR)
    return "watch_invalid_manifest";
  if (error.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) return "watch_media_encryption_unsupported";
  if (error.type === Hls.ErrorTypes.NETWORK_ERROR) return "watch_media_unavailable";
  return "watch_media_failed";
}
