import { parse, parsePayloads, write } from "sdp-transform";

const REPAIR_CODEC_MIME_TYPES = new Set([
  "video/rtx",
  "video/red",
  "video/ulpfec",
  "video/flexfec-03",
]);
const SCREEN_SHARE_START_BITRATE_RATIO = 0.9;

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

export function preferVp8StartBitrate(
  offer: RTCSessionDescriptionInit,
  maxBitrate: number,
): RTCSessionDescriptionInit {
  try {
    if (
      offer.type !== "offer" ||
      !offer.sdp?.trim() ||
      !Number.isSafeInteger(maxBitrate) ||
      maxBitrate <= 0
    ) {
      return offer;
    }
    const session = parse(offer.sdp);
    if (
      session.version !== 0 ||
      !session.origin ||
      typeof session.name !== "string" ||
      !session.timing ||
      !Array.isArray(session.media)
    ) {
      return offer;
    }
    const videoSections = session.media.filter(
      (media) => media.type === "video" && media.port !== 0,
    );
    if (videoSections.length !== 1) {
      return offer;
    }
    const video = videoSections[0]!;
    const payloads = new Set(parsePayloads(video.payloads ?? ""));
    const vp8 = video.rtp.filter(
      (codec) =>
        payloads.has(codec.payload) && codec.codec.toLowerCase() === "vp8",
    );
    if (vp8.length !== 1) {
      return offer;
    }
    const payload = vp8[0]!.payload;
    const formats = video.fmtp.filter((format) => format.payload === payload);
    if (formats.length > 1) {
      return offer;
    }
    const parameter = `x-google-start-bitrate=${Math.round(
      (maxBitrate / 1_000) * SCREEN_SHARE_START_BITRATE_RATIO,
    )}`;
    if (formats[0]) {
      const config = upsertStartBitrate(formats[0].config, parameter);
      if (config === null) {
        return offer;
      }
      formats[0].config = config;
    } else {
      video.fmtp.push({ payload, config: parameter });
    }
    const sdp = write(session);
    return sdp.trim() ? { type: offer.type, sdp } : offer;
  } catch {
    return offer;
  }
}

function upsertStartBitrate(
  config: string,
  startBitrate: string,
): string | null {
  const parameters = config.split(";").map((parameter) => parameter.trim());
  let targetIndex: number | null = null;
  for (const [index, parameter] of parameters.entries()) {
    const equals = parameter.indexOf("=");
    const isTarget =
      equals > 0 &&
      parameter.slice(0, equals).trim().toLowerCase() ===
        "x-google-start-bitrate";
    if (!isTarget) {
      continue;
    }
    if (targetIndex !== null) {
      return null;
    }
    targetIndex = index;
  }
  if (targetIndex === null) {
    parameters.push(startBitrate);
  } else {
    parameters[targetIndex] = startBitrate;
  }
  return parameters.filter(Boolean).join(";");
}
