import { describe, expect, it, vi } from "vitest";

import {
  isAutoplayPolicyRejection,
  observeCompositedVideoFrame,
} from "../src/client/media/video-frame-proof.ts";

interface FakeVideo extends EventTarget {
  srcObject: MediaStream | null;
  readyState: number;
  currentTime: number;
  decodedFrames: number;
  getVideoPlaybackQuality: () => { totalVideoFrames: number };
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

function fakeVideo(stream: MediaStream): FakeVideo {
  const video = new EventTarget() as FakeVideo;
  video.srcObject = stream;
  video.readyState = 0;
  video.currentTime = 0;
  video.decodedFrames = 0;
  video.getVideoPlaybackQuality = () => ({
    totalVideoFrames: video.decodedFrames,
  });
  return video;
}

describe("composited video frame proof", () => {
  it("recognizes only browser autoplay policy rejection", () => {
    expect(isAutoplayPolicyRejection({ name: "NotAllowedError" })).toBe(true);
    expect(isAutoplayPolicyRejection({ name: "AbortError" })).toBe(false);
    expect(isAutoplayPolicyRejection(new Error("not allowed"))).toBe(false);
  });

  it("binds requestVideoFrameCallback proof to the expected srcObject", () => {
    const stream = {} as MediaStream;
    const replacement = {} as MediaStream;
    const video = fakeVideo(stream);
    let callback: (() => void) | null = null;
    video.requestVideoFrameCallback = (next) => {
      callback = next;
      return 7;
    };
    video.cancelVideoFrameCallback = vi.fn();
    const onFrame = vi.fn();
    const cancel = observeCompositedVideoFrame(
      video as unknown as HTMLVideoElement,
      stream,
      onFrame,
    );

    video.readyState = 2;
    video.srcObject = replacement;
    callback!();
    expect(onFrame).not.toHaveBeenCalled();

    cancel();
    expect(video.cancelVideoFrameCallback).not.toHaveBeenCalled();
  });

  it("keeps observing when the first composited callback arrives before readiness", () => {
    const stream = {} as MediaStream;
    const video = fakeVideo(stream);
    const callbacks: Array<() => void> = [];
    video.requestVideoFrameCallback = (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    };
    const onFrame = vi.fn();
    const cancel = observeCompositedVideoFrame(
      video as unknown as HTMLVideoElement,
      stream,
      onFrame,
    );

    callbacks[0]!();
    expect(onFrame).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(2);

    video.readyState = 2;
    callbacks[1]!();
    expect(onFrame).toHaveBeenCalledOnce();
    cancel();
  });

  it("uses decoded progress plus readiness in the event fallback", () => {
    const stream = {} as MediaStream;
    const video = fakeVideo(stream);
    const onFrame = vi.fn();
    const cancel = observeCompositedVideoFrame(
      video as unknown as HTMLVideoElement,
      stream,
      onFrame,
    );

    video.readyState = 2;
    video.dispatchEvent(new Event("playing"));
    expect(onFrame).not.toHaveBeenCalled();

    video.decodedFrames = 1;
    video.dispatchEvent(new Event("timeupdate"));
    expect(onFrame).toHaveBeenCalledOnce();

    video.decodedFrames = 2;
    video.dispatchEvent(new Event("timeupdate"));
    expect(onFrame).toHaveBeenCalledOnce();
    cancel();
  });
});
