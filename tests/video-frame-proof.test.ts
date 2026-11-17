import { describe, expect, it, vi } from "vitest";

import { observeCompositedVideoFrame } from "../src/client/media/video-frame-proof.ts";

interface FakeVideo extends EventTarget {
  srcObject: MediaStream | null;
  readyState: number;
  currentTime: number;
  decodedFrames: number;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number };
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

function fakeVideo(stream: MediaStream | null): FakeVideo {
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
  it("retains the final composited frame while a paused seek finishes without another frame", () => {
    const video = fakeVideo(null), callbacks: Array<() => void> = [];
    video.requestVideoFrameCallback = callback => { callbacks.push(callback); return callbacks.length; };
    video.cancelVideoFrameCallback = vi.fn();
    const shown = vi.fn(), stop = observeCompositedVideoFrame(video as unknown as HTMLVideoElement, null, shown);
    video.readyState = 1; video.decodedFrames = 24;
    callbacks[0]!();
    expect(shown).not.toHaveBeenCalled();
    video.readyState = 4;
    video.dispatchEvent(new Event("seeked"));
    video.dispatchEvent(new Event("loadeddata"));
    expect(shown).toHaveBeenCalledOnce();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(2);
    callbacks[1]!(); stop();
    expect(shown).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "replace"])("does not reuse a retained frame after %s", action => {
    const stream = {} as MediaStream, video = fakeVideo(stream);
    let callback!: () => void;
    video.requestVideoFrameCallback = next => { callback = next; return 1; };
    video.cancelVideoFrameCallback = vi.fn();
    const shown = vi.fn(), stop = observeCompositedVideoFrame(video as unknown as HTMLVideoElement, stream, shown);
    video.readyState = 1; callback();
    if (action === "cancel") stop();
    else video.srcObject = {} as MediaStream;
    video.readyState = 4; video.dispatchEvent(new Event("loadeddata"));
    expect(shown).not.toHaveBeenCalled(); stop();
  });

  it("accepts a preloaded paused URL picture in the decoded-counter fallback", () => {
    const video = fakeVideo(null); video.readyState = 2; video.decodedFrames = 1;
    const frame = vi.fn(), cancel = observeCompositedVideoFrame(video as unknown as HTMLVideoElement, null, frame);
    expect(frame).toHaveBeenCalledOnce(); cancel();
  });
  it("observes a URL player's first composed frame and cancellation retires the observation", () => {
    const video = fakeVideo(null);
    let frame!: () => void;
    video.requestVideoFrameCallback = callback => { frame = callback; return 9; };
    video.cancelVideoFrameCallback = vi.fn();
    const shown = vi.fn(), stop = observeCompositedVideoFrame(video as unknown as HTMLVideoElement, null, shown);
    video.readyState = 2; video.dispatchEvent(new Event("loadeddata"));
    expect(shown).not.toHaveBeenCalled();
    frame(); expect(shown).toHaveBeenCalledOnce(); stop();
    const pending = observeCompositedVideoFrame(video as unknown as HTMLVideoElement, null, shown);
    pending(); frame();
    expect(shown).toHaveBeenCalledOnce(); expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(9);
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

  it("does not substitute media time for an available decoded-frame count", () => {
    const stream = {} as MediaStream;
    const video = fakeVideo(stream);
    const onFrame = vi.fn();
    const cancel = observeCompositedVideoFrame(
      video as unknown as HTMLVideoElement,
      stream,
      onFrame,
    );

    video.readyState = 2;
    video.currentTime = 1;
    video.dispatchEvent(new Event("timeupdate"));
    expect(onFrame).not.toHaveBeenCalled();
    cancel();
  });

  it("uses media time only when decoded-frame count is unavailable", () => {
    const stream = {} as MediaStream;
    const video = fakeVideo(stream);
    delete video.getVideoPlaybackQuality;
    const onFrame = vi.fn();
    const cancel = observeCompositedVideoFrame(
      video as unknown as HTMLVideoElement,
      stream,
      onFrame,
    );

    video.readyState = 2;
    video.currentTime = 1;
    video.dispatchEvent(new Event("timeupdate"));
    expect(onFrame).toHaveBeenCalledOnce();
    cancel();
  });
});
