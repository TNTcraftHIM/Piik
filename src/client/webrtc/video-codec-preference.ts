import type { VideoCodecPreference } from "../../shared/protocol";

function videoCodecs(): RTCRtpCodec[] {
  if (typeof RTCRtpSender === "undefined") {
    return [];
  }
  return RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
}

export function applyVideoCodecPreference(
  transceiver: RTCRtpTransceiver,
  preference: VideoCodecPreference | undefined,
): boolean {
  const resolvedPreference = preference ?? "automatic";
  if (
    resolvedPreference === "automatic" ||
    typeof transceiver.setCodecPreferences !== "function"
  ) {
    return resolvedPreference === "automatic";
  }
  const codecs = videoCodecs();
  const mimeType = `video/${resolvedPreference}`;
  const preferred = codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === mimeType,
  );
  if (preferred.length === 0) {
    return false;
  }
  try {
    transceiver.setCodecPreferences([
      ...preferred,
      ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== mimeType),
    ]);
    return true;
  } catch {
    return false;
  }
}
