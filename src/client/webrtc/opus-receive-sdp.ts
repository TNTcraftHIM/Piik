import { parse, parsePayloads, write } from "sdp-transform";

import { OPUS_RECEIVE_MAX_BITRATE } from "../media/quality";

export function preferScreenAudioStereo(
  answer: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  return answer.type === "answer" ? preferOpusReceive(answer, true) : answer;
}

export function preferRoomVoiceAudio(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  return preferOpusReceive(description, false);
}

/** A shared transport can receive several pictures and voices in either SDP role.
 * Stereo reception also accepts mono input; it does not configure capture. */
export function preferOpusStereoReceive(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  return preferOpusReceive(description, true, "receiving");
}

function preferOpusReceive(answer: RTCSessionDescriptionInit, stereo: boolean,
  scope: "single" | "all" | "receiving" = stereo ? "single" : "all"): RTCSessionDescriptionInit {
  const preferences = { stereo: stereo ? "1" : "0", maxaveragebitrate: String(OPUS_RECEIVE_MAX_BITRATE) };
  try {
    if (!answer.sdp?.trim()) {
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
      (media) => media.type === "audio" && media.port !== 0
        && (scope !== "receiving" || !["sendonly", "inactive"].includes(media.direction ?? session.direction ?? "sendrecv")),
    );
    if (!audioSections.length || (scope === "single" && audioSections.length !== 1)) {
      return answer;
    }

    for (const audio of audioSections) {
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
        const config = upsertOpusReceivePreferences(formats[0].config, preferences);
        if (config === null) {
          return answer;
        }
        formats[0].config = config;
      } else {
        audio.fmtp.push({ payload, config: Object.entries(preferences).map(([key, value]) => `${key}=${value}`).join(";") });
      }
    }

    const sdp = write(session);
    return sdp.trim() ? { type: answer.type, sdp } : answer;
  } catch {
    return answer;
  }
}

function upsertOpusReceivePreferences(config: string, preferences: Record<string, string>): string | null {
  const parameters = config.split(";").map((parameter) => parameter.trim());
  const preferenceIndexes = new Map<string, number>();
  for (const [index, parameter] of parameters.entries()) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals === parameter.length - 1) {
      return null;
    }
    const name = parameter.slice(0, equals).trim().toLowerCase();
    if (Object.hasOwn(preferences, name)) {
      if (preferenceIndexes.has(name)) {
        return null;
      }
      preferenceIndexes.set(name, index);
    }
  }

  for (const [name, value] of Object.entries(preferences)) {
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
