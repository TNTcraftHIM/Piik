import { describe, expect, it, vi } from "vitest";

import { prepareViewerPlayback } from "../src/client/media/viewer-playback.ts";

describe("Viewer playback binding", () => {
  it("arms every media generation even when the MediaStream identity is reused", () => {
    const stream = {} as MediaStream;
    const video = {
      srcObject: null as MediaProvider | null,
      pause: vi.fn(),
    };

    expect(prepareViewerPlayback(video, stream, false)).toBe(true);
    expect(video.srcObject).toBe(stream);
    expect(prepareViewerPlayback(video, stream, false)).toBe(true);
    expect(video.pause).not.toHaveBeenCalled();

    expect(prepareViewerPlayback(video, stream, true)).toBe(false);
    expect(video.pause).toHaveBeenCalledOnce();
  });
});
