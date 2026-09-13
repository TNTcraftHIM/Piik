import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleVideoFullscreen, videoFullscreenState, type FullscreenVideo } from "../src/client/components/living/video-fullscreen";

function player(native = false) {
  const screen = { requestFullscreen: vi.fn<() => Promise<void>>().mockResolvedValue() };
  const video = {
    parentElement: screen, readyState: 0,
    ...(native ? {
      webkitEnterFullscreen: vi.fn(), webkitExitFullscreen: vi.fn(),
      webkitSupportsFullscreen: false, webkitDisplayingFullscreen: false,
      webkitPresentationMode: "inline",
    } : {}),
  };
  const page = {
    fullscreenEnabled: !native, fullscreenElement: null as object | null,
    exitFullscreen: vi.fn<() => Promise<void>>().mockResolvedValue(),
    pictureInPictureElement: null as object | null,
    exitPictureInPicture: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  vi.stubGlobal("document", page);
  return { screen, video, page, element: video as unknown as FullscreenVideo };
}

afterEach(() => vi.unstubAllGlobals());

describe("Video fullscreen", () => {
  it("requests page fullscreen in the click stack before leaving PiP, and exits only its own stage", async () => {
    const { screen, video, page, element } = player();
    page.pictureInPictureElement = video;
    const entering = toggleVideoFullscreen(element);
    expect(screen.requestFullscreen).toHaveBeenCalledOnce();
    expect(page.exitPictureInPicture).not.toHaveBeenCalled();
    await entering;
    expect(page.exitPictureInPicture).toHaveBeenCalledOnce();
    expect(videoFullscreenState(element).active).toBe(false);

    page.fullscreenElement = screen;
    expect(videoFullscreenState(element).active).toBe(true);
    await toggleVideoFullscreen(element);
    expect(page.exitFullscreen).toHaveBeenCalledOnce();
    page.fullscreenElement = {};
    await toggleVideoFullscreen(element);
    expect(screen.requestFullscreen).toHaveBeenCalledTimes(2);
    expect(page.exitFullscreen).toHaveBeenCalledOnce();
  });

  it("waits for Safari metadata and actual native support without queuing a request outside user activation", async () => {
    const { video, element } = player(true);
    expect(videoFullscreenState(element)).toMatchObject({ supported: true, ready: false, active: false });
    await toggleVideoFullscreen(element);
    expect(video.webkitEnterFullscreen).not.toHaveBeenCalled();
    video.readyState = 1;
    await toggleVideoFullscreen(element);
    expect(video.webkitEnterFullscreen).not.toHaveBeenCalled();
    video.webkitSupportsFullscreen = true;
    expect(videoFullscreenState(element).ready).toBe(true);
    const entering = toggleVideoFullscreen(element);
    expect(video.webkitEnterFullscreen).toHaveBeenCalledOnce();
    await entering;
    expect(videoFullscreenState(element).active).toBe(false);
    video.webkitDisplayingFullscreen = true;
    expect(videoFullscreenState(element)).toMatchObject({ active: true, nativeActive: true });
    await toggleVideoFullscreen(element);
    expect(video.webkitExitFullscreen).toHaveBeenCalledOnce();
    video.webkitDisplayingFullscreen = false;
    video.webkitPresentationMode = "fullscreen";
    expect(videoFullscreenState(element).nativeActive).toBe(true);
    video.webkitPresentationMode = "inline";
    video.readyState = 0;
    expect(videoFullscreenState(element)).toMatchObject({ active: false, ready: false });
  });

  it("retains native and standard rejection details and leaves PiP alone when fullscreen is rejected", async () => {
    const native = player(true);
    native.video.readyState = 1;
    native.video.webkitSupportsFullscreen = true;
    const rejected = new DOMException("The video is changing presentation mode", "InvalidStateError");
    native.video.webkitEnterFullscreen!.mockImplementation(() => { throw rejected; });
    await expect(toggleVideoFullscreen(native.element)).rejects.toBe(rejected);
    expect(videoFullscreenState(native.element).active).toBe(false);

    const standard = player();
    standard.page.pictureInPictureElement = standard.video;
    standard.screen.requestFullscreen.mockRejectedValue(rejected);
    await expect(toggleVideoFullscreen(standard.element)).rejects.toBe(rejected);
    expect(standard.page.exitPictureInPicture).not.toHaveBeenCalled();
  });
});
