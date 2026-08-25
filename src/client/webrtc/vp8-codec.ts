const REPAIR_CODEC_MIME_TYPES = new Set([
  "video/rtx",
  "video/red",
  "video/ulpfec",
  "video/flexfec-03",
]);

export function applyVp8Codec(transceiver: RTCRtpTransceiver): boolean {
  if (
    typeof RTCRtpSender === "undefined" ||
    typeof transceiver.setCodecPreferences !== "function"
  ) {
    return false;
  }

  try {
    const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
    const vp8Codecs = codecs.filter(
      ({ mimeType }) => mimeType.toLowerCase() === "video/vp8",
    );
    if (vp8Codecs.length === 0) {
      return false;
    }

    transceiver.setCodecPreferences([
      ...vp8Codecs,
      ...codecs.filter(({ mimeType }) =>
        REPAIR_CODEC_MIME_TYPES.has(mimeType.toLowerCase()),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}
