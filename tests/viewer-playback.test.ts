import { describe, expect, it, vi } from "vitest";

import { nextViewerMediaBinding, playbackFailure, prepareViewerPlayback } from "../src/client/media/viewer-playback.ts";

describe("Viewer playback binding", () => {
  it("distinguishes canceled playback from autoplay denial and actual failures", () => {
    expect(playbackFailure(new DOMException("Paused", "AbortError"))).toBeNull();
    expect(playbackFailure({ name: "AbortError" })).toBeNull();
    expect(playbackFailure(new DOMException("Blocked", "NotAllowedError"))).toBe("autoplay-blocked");
    expect(playbackFailure(new DOMException("Unsupported", "NotSupportedError"))).toBe("playback-failed");
    expect(playbackFailure(new Error("decode failed"))).toBe("playback-failed");
    expect(playbackFailure(null)).toBe("playback-failed");
  });

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
    const pauseState = { active: false, resume: false };

    expect(prepareViewerPlayback(video, stream, false, pauseState)).toBe(true);
    expect(video.srcObject).toBe(stream);
    expect(prepareViewerPlayback(video, stream, false, pauseState)).toBe(true);
    expect(video.pause).not.toHaveBeenCalled();

    expect(prepareViewerPlayback(video, stream, true, pauseState)).toBe(false);
    expect(video.pause).toHaveBeenCalledOnce();
  });

  it.each([false, true])("arms Host resume on a new binding regardless of the old local pause (%s)", (resume) => {
    const stream = {} as MediaStream;
    const video = { srcObject: stream, pause: vi.fn() };
    const pauseState = { active: true, resume };

    // A new video generation can reuse the same MediaStream object.
    expect(prepareViewerPlayback(video, stream, true, pauseState)).toBe(false);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(pauseState).toEqual({ active: true, resume: true });

    // If the Host has already resumed, the new binding starts immediately.
    expect(prepareViewerPlayback(video, stream, false, pauseState)).toBe(true);
    expect(pauseState).toEqual({ active: false, resume: false });
  });
});
