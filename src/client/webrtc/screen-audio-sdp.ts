import { parse, parsePayloads, write } from "sdp-transform";

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
      const config = upsertStereo(formats[0].config);
      if (config === null) {
        return answer;
      }
      formats[0].config = config;
    } else {
      audio.fmtp.push({ payload, config: "stereo=1" });
    }

    const sdp = write(session);
    return sdp.trim() ? { type: answer.type, sdp } : answer;
  } catch {
    return answer;
  }
}

function upsertStereo(config: string): string | null {
  const parameters = config.split(";").map((parameter) => parameter.trim());
  let stereoIndex = -1;
  for (const [index, parameter] of parameters.entries()) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals === parameter.length - 1) {
      return null;
    }
    if (parameter.slice(0, equals).trim().toLowerCase() === "stereo") {
      if (stereoIndex !== -1) {
        return null;
      }
      stereoIndex = index;
    }
  }
  if (stereoIndex === -1) {
    parameters.push("stereo=1");
  } else {
    parameters[stereoIndex] = "stereo=1";
  }
  return parameters.join(";");
}
