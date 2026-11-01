import { describe, expect, it } from "vitest";

import { audioInputConstraints, displayMediaOptions } from "../src/client/media/audio-capture.ts";

describe("browser display audio capture", () => {
  it("keeps screen audio free of speech processing and prefers stereo", () => {
    const options = displayMediaOptions({ width: { ideal: 1280 } });

    expect(options).toMatchObject({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: { ideal: 2 },
        restrictOwnAudio: true,
      },
      systemAudio: "include",
      windowAudio: "window",
    });
    expect(audioInputConstraints(true)).not.toHaveProperty("restrictOwnAudio");
    expect(audioInputConstraints(false)).not.toHaveProperty("restrictOwnAudio");
  });
});
