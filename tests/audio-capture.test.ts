import { describe, expect, it } from "vitest";

import {
  browserAudioCaptureStatus,
  displayMediaOptions,
} from "../src/client/media/audio-capture.ts";

describe("browser display audio capture", () => {
  it("requests the selected window audio without claiming source readback", () => {
    const options = displayMediaOptions({ width: { ideal: 1280 } });

    expect(options).toMatchObject({
      audio: true,
      systemAudio: "exclude",
      windowAudio: "window",
    });
  });

  it("reports an audio track while keeping its scope unconfirmed", () => {
    const stream = {
      getAudioTracks: () => [{}],
    } as unknown as MediaStream;

    expect(browserAudioCaptureStatus(stream)).toEqual({
      hasTrack: true,
      scope: "window-requested-unconfirmed",
    });
  });

  it("reports a missing audio track explicitly", () => {
    const stream = {
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    expect(browserAudioCaptureStatus(stream)).toEqual({
      hasTrack: false,
      scope: "none",
    });
  });
});
