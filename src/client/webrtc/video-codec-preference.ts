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
  const resolvedPreference = preference ?? "vp8";
  if (typeof transceiver.setCodecPreferences !== "function") {
    return false;
  }
  if (resolvedPreference === "automatic") {
    try {
      transceiver.setCodecPreferences([]);
      return true;
    } catch {
      return false;
    }
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
