import { describe, expect, it } from "vitest";
import { parse } from "sdp-transform";

import { preferScreenAudioStereo } from "../src/client/webrtc/screen-audio-sdp.ts";

function answerSdp(opusFmtp: string | null = "minptime=10;useinbandfec=1"): string {
  return [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0",
    "c=IN IP4 0.0.0.0",
    "a=rtpmap:111 opus/48000/2",
    ...(opusFmtp === null ? [] : [`a=fmtp:111 ${opusFmtp}`]),
    "a=rtpmap:0 PCMU/8000",
    "a=recvonly",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=rtpmap:96 H264/90000",
    "a=fmtp:96 packetization-mode=1;profile-level-id=42e01f",
    "a=recvonly",
    "",
  ].join("\r\n");
}

describe("preferScreenAudioStereo", () => {
  it("adds exact stereo and bitrate tokens without changing FEC or video fmtp", () => {
    const result = preferScreenAudioStereo({
      type: "answer",
      sdp: answerSdp("minptime=10;useinbandfec=1;x-stereo=keep"),
    });
    const session = parse(result.sdp!);

    expect(session.media[0]?.fmtp).toContainEqual({
      payload: 111,
      config:
        "minptime=10;useinbandfec=1;x-stereo=keep;stereo=1;maxaveragebitrate=192000",
    });
    expect(session.media[1]?.fmtp).toEqual([
      { payload: 96, config: "packetization-mode=1;profile-level-id=42e01f" },
    ]);
    expect(preferScreenAudioStereo(result)).toEqual(result);
  });

  it("replaces only exact stereo and bitrate tokens", () => {
    const result = preferScreenAudioStereo({
      type: "answer",
      sdp: answerSdp(
        "stereo=0;x-stereo=0;maxaveragebitrate=64000;x-maxaveragebitrate=keep",
      ),
    });

    expect(parse(result.sdp!).media[0]?.fmtp[0]?.config).toBe(
      "stereo=1;x-stereo=0;maxaveragebitrate=192000;x-maxaveragebitrate=keep",
    );
  });

  it("creates the Opus fmtp row when it is absent", () => {
    const result = preferScreenAudioStereo({
      type: "answer",
      sdp: answerSdp(null),
    });

    expect(parse(result.sdp!).media[0]?.fmtp).toContainEqual({
      payload: 111,
      config: "stereo=1;maxaveragebitrate=192000",
    });
  });

  it("ignores a rejected audio section", () => {
    const rejected = [
      "m=audio 0 UDP/TLS/RTP/SAVPF 112",
      "a=rtpmap:112 opus/48000/2",
      "a=fmtp:112 stereo=0",
    ].join("\r\n");
    const result = preferScreenAudioStereo({
      type: "answer",
      sdp: answerSdp().replace("m=audio 9", `${rejected}\r\nm=audio 9`),
    });
    const audio = parse(result.sdp!).media.filter((media) => media.type === "audio");

    expect(audio[0]?.fmtp[0]?.config).toBe("stereo=0");
    expect(audio[1]?.fmtp[0]?.config).toContain("stereo=1");
    expect(audio[1]?.fmtp[0]?.config).toContain("maxaveragebitrate=192000");
  });

  it.each([
    ["empty", { type: "answer", sdp: "" }],
    ["malformed", { type: "answer", sdp: "not SDP" }],
    ["parser exception", { type: "answer", sdp: { trim: () => "x" } as unknown as string }],
    ["not an answer", { type: "offer", sdp: answerSdp() }],
    [
      "missing Opus",
      { type: "answer", sdp: answerSdp().replace("opus/48000/2", "ISAC/16000") },
    ],
    [
      "multiple active audio sections",
      { type: "answer", sdp: `${answerSdp()}m=audio 9 RTP/AVP 0\r\n` },
    ],
    [
      "duplicate Opus fmtp rows",
      {
        type: "answer",
        sdp: answerSdp().replace(
          "a=fmtp:111 minptime=10;useinbandfec=1",
          "a=fmtp:111 minptime=10\r\na=fmtp:111 useinbandfec=1",
        ),
      },
    ],
    [
      "duplicate target parameter",
      {
        type: "answer",
        sdp: answerSdp(
          "stereo=0;maxaveragebitrate=64000;MAXAVERAGEBITRATE=96000",
        ),
      },
    ],
  ] as const)("returns the original answer for %s", (_case, answer) => {
    const result = preferScreenAudioStereo(answer);
    expect(result).toBe(answer);
    expect(result.sdp).toBe(answer.sdp);
  });
});
