import { parse, parsePayloads, write } from "sdp-transform";

import { SCREEN_AUDIO_RECEIVE_MAX_BITRATE } from "../media/quality";

const OPUS_RECEIVE_PREFERENCES = {
  stereo: "1",
  maxaveragebitrate: String(SCREEN_AUDIO_RECEIVE_MAX_BITRATE),
} as const;
const OPUS_RECEIVE_FMTP = Object.entries(OPUS_RECEIVE_PREFERENCES)
  .map(([name, value]) => `${name}=${value}`)
  .join(";");

export function preferScreenAudioStereo(
  answer: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  try {
    if (answer.type !== "answer" || !answer.sdp?.trim()) {
      return answer;
    }
    const session = parse(answer.sdp);
    if (
      session.version !== 0 ||
      !session.origin ||
      typeof session.name !== "string" ||
      !session.timing ||
      !Array.isArray(session.media)
    ) {
      return answer;
    }

    const audioSections = session.media.filter(
      (media) => media.type === "audio" && media.port !== 0,
    );
    if (audioSections.length !== 1) {
      return answer;
    }

    const audio = audioSections[0]!;
    const payloads = new Set(parsePayloads(audio.payloads ?? ""));
    const opus = audio.rtp.filter(
      (codec) =>
        payloads.has(codec.payload) && codec.codec.toLowerCase() === "opus",
    );
    if (opus.length !== 1) {
      return answer;
    }

    const payload = opus[0]!.payload;
    const formats = audio.fmtp.filter((format) => format.payload === payload);
    if (formats.length > 1) {
      return answer;
    }
    if (formats[0]) {
      const config = upsertOpusReceivePreferences(formats[0].config);
      if (config === null) {
        return answer;
      }
      formats[0].config = config;
    } else {
      audio.fmtp.push({ payload, config: OPUS_RECEIVE_FMTP });
    }

    const sdp = write(session);
    return sdp.trim() ? { type: answer.type, sdp } : answer;
  } catch {
    return answer;
  }
}

function upsertOpusReceivePreferences(config: string): string | null {
  const parameters = config.split(";").map((parameter) => parameter.trim());
  const preferenceIndexes = new Map<string, number>();
  for (const [index, parameter] of parameters.entries()) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals === parameter.length - 1) {
      return null;
    }
    const name = parameter.slice(0, equals).trim().toLowerCase();
    if (Object.hasOwn(OPUS_RECEIVE_PREFERENCES, name)) {
      if (preferenceIndexes.has(name)) {
        return null;
      }
      preferenceIndexes.set(name, index);
    }
  }

  for (const [name, value] of Object.entries(OPUS_RECEIVE_PREFERENCES)) {
    const parameter = `${name}=${value}`;
    const index = preferenceIndexes.get(name);
    if (index === undefined) {
      parameters.push(parameter);
    } else {
      parameters[index] = parameter;
    }
  }
  return parameters.join(";");
}
