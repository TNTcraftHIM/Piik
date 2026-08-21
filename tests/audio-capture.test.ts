import { describe, expect, it } from "vitest";

import { displayMediaOptions } from "../src/client/media/audio-capture.ts";

describe("browser display audio capture", () => {
  it("offers source-appropriate audio for windows and full displays", () => {
    const options = displayMediaOptions({ width: { ideal: 1280 } });

    expect(options).toMatchObject({
      audio: true,
      systemAudio: "include",
      windowAudio: "window",
    });
  });
});
