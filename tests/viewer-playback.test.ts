import { describe, expect, it, vi } from "vitest";

import { nextViewerMediaBinding, prepareViewerPlayback } from "../src/client/media/viewer-playback.ts";

describe("Viewer playback binding", () => {
  it("retains video identity across audio arrival, replacement and removal", () => {
    let audio: { id: string }[] = [];
    const stream = { getVideoTracks: () => [{ id: "video" }], getAudioTracks: () => audio } as MediaStream;
    const original = nextViewerMediaBinding(null, stream, 3, 7);
    let binding = original;
    for (const nextAudio of [[{ id: "audio-a" }], [{ id: "audio-b" }], []]) {
      audio = nextAudio;
      binding = nextViewerMediaBinding(binding, stream, 4, 8);
      expect(binding).toMatchObject({ generation: 7, boundAtRevision: 3, videoTrackKey: "video", audioTrackKey: nextAudio[0]?.id ?? "" });
      expect(nextViewerMediaBinding(binding, stream, 5, 8)).toBe(binding);
    }
    expect(original.audioTrackKey).toBe("");
  });

  it("creates a new picture identity for a new video or stream, including after retirement", () => {
    let id = "video-a";
    const stream = { getVideoTracks: () => [{ id }], getAudioTracks: () => [] } as unknown as MediaStream;
    const first = nextViewerMediaBinding(null, stream, 1, 1);
    id = "video-b";
    const changed = nextViewerMediaBinding(first, stream, 2, 2);
    expect(changed).toMatchObject({ generation: 2, boundAtRevision: 2, videoTrackKey: "video-b" });
    expect(nextViewerMediaBinding(changed, { ...stream }, 3, 3).generation).toBe(3);
    expect(nextViewerMediaBinding(null, stream, 4, 4).generation).toBe(4);
  });

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
