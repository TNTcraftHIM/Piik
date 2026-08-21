export type PreferredVideoCodec = "h264" | "vp8";

function videoCodecs(): RTCRtpCodec[] {
  if (typeof RTCRtpSender === "undefined") {
    return [];
  }
  return RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
}

function isH264(codec: RTCRtpCodec): boolean {
  return codec.mimeType.toLowerCase() === "video/h264";
}

export function preferredVideoCodec(): PreferredVideoCodec {
  return videoCodecs().some(isH264) ? "h264" : "vp8";
}

export function preferH264(transceiver: RTCRtpTransceiver): boolean {
  if (typeof transceiver.setCodecPreferences !== "function") {
    return false;
  }
  const codecs = videoCodecs();
  const h264 = codecs.filter(isH264);
  if (h264.length === 0) {
    return false;
  }
  try {
    transceiver.setCodecPreferences([
      ...h264,
      ...codecs.filter((codec) => !isH264(codec)),
    ]);
    return true;
  } catch {
    return false;
  }
}
