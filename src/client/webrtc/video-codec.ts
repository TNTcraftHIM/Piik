export type BrowserVideoCodec = "h264" | "vp8";
export type BrowserVideoCodecMode = "vp8" | "auto" | "h264";

export interface BrowserVideoCodecPreference {
  primary: BrowserVideoCodec;
  vp8Fallback: boolean;
}

export const VP8_ONLY_VIDEO_CODEC: BrowserVideoCodecPreference = {
  primary: "vp8",
  vp8Fallback: false,
};

export function automaticVideoCodecPreference(
  codec: BrowserVideoCodec,
): BrowserVideoCodecPreference {
  return { primary: codec, vp8Fallback: codec === "h264" };
}

export function manualVideoCodecPreference(
  codec: BrowserVideoCodec,
): BrowserVideoCodecPreference {
  return { primary: codec, vp8Fallback: false };
}

const REPAIR_CODEC_MIME_TYPES = new Set([
  "video/rtx",
  "video/red",
  "video/ulpfec",
  "video/flexfec-03",
]);

function videoCapabilities(): RTCRtpCodec[] {
  return RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
}

function vp8Codecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(
    ({ mimeType }) => mimeType.toLowerCase() === "video/vp8",
  );
}

function h264ModeOneCodecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(({ mimeType, sdpFmtpLine }) => {
    if (mimeType.toLowerCase() !== "video/h264") {
      return false;
    }
    return (
      !sdpFmtpLine ||
      /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(sdpFmtpLine)
    );
  });
}

function repairCodecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(({ mimeType }) =>
    REPAIR_CODEC_MIME_TYPES.has(mimeType.toLowerCase()),
  );
}

function applyCodecs(
  transceiver: RTCRtpTransceiver,
  codecs: RTCRtpCodec[],
): boolean {
  if (typeof transceiver.setCodecPreferences !== "function") {
    return false;
  }
  try {
    transceiver.setCodecPreferences(codecs);
    return true;
  } catch {
    return false;
  }
}

export function applyVideoCodecPreference(
  transceiver: RTCRtpTransceiver,
  preference: BrowserVideoCodecPreference,
): boolean {
  if (typeof RTCRtpSender === "undefined") {
    return false;
  }
  const codecs = videoCapabilities();
  const vp8 = vp8Codecs(codecs);
  if (
    (preference.primary === "vp8" || preference.vp8Fallback) &&
    vp8.length === 0
  ) {
    return false;
  }
  const h264 =
    preference.primary === "h264" ? h264ModeOneCodecs(codecs) : [];
  if (preference.primary === "h264" && h264.length === 0) {
    return false;
  }
  return applyCodecs(transceiver, [
    ...h264,
    ...(preference.primary === "vp8" || preference.vp8Fallback ? vp8 : []),
    ...repairCodecs(codecs),
  ]);
}

export function applyH264ProbeCodec(
  transceiver: RTCRtpTransceiver,
): boolean {
  if (typeof RTCRtpSender === "undefined") {
    return false;
  }
  const codecs = videoCapabilities();
  const h264 = h264ModeOneCodecs(codecs);
  return h264.length > 0 &&
    applyCodecs(transceiver, [...h264, ...repairCodecs(codecs)]);
}
