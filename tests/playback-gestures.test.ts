import { afterEach, describe, expect, it, vi } from "vitest";
import { bindPlaybackGestures } from "../src/client/components/living/playback-gestures";

function picture() {
  const screen = new EventTarget();
  const video = Object.assign(new EventTarget(), {
    parentElement: screen,
    srcObject: {} as object | null,
  });
  const playback = vi.fn();
  const fullscreen = vi.fn();
  const dispose = bindPlaybackGestures(video as unknown as HTMLVideoElement, playback, fullscreen);
  const pointer = (pointerType = "mouse") => screen.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerType }));
  const click = (detail = 1, button = 0) => video.dispatchEvent(Object.assign(new Event("click"), { detail, button }));
  const doubleClick = () => video.dispatchEvent(Object.assign(new Event("dblclick"), { detail: 2, button: 0 }));
  return { screen, video, playback, fullscreen, dispose, pointer, click, doubleClick };
}

afterEach(() => vi.useRealTimers());

describe("Viewer picture gestures", () => {
  it("waits for a single click and gives double-click fullscreen priority without changing playback", () => {
    vi.useFakeTimers();
    const view = picture();
    view.pointer();
    view.click();
    vi.advanceTimersByTime(499);
    expect(view.playback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(view.playback).toHaveBeenCalledOnce();

    view.playback.mockClear();
    view.pointer();
    view.click();
    vi.advanceTimersByTime(300);
    view.pointer();
    // The second press cancels the single even if its release comes later.
    vi.advanceTimersByTime(300);
    view.click(2);
    view.doubleClick();
    vi.runAllTimers();
    expect(view.playback).not.toHaveBeenCalled();
    expect(view.fullscreen).toHaveBeenCalledOnce();
    view.dispose();
  });

  it("retires pending clicks after another action, playback change, media replacement or unmount", () => {
    vi.useFakeTimers();
    const view = picture();
    for (const [target, event] of [
      [view.screen, "pointerdown"], [view.screen, "keydown"], [view.screen, "pointercancel"],
      [view.video, "play"], [view.video, "pause"], [view.video, "emptied"],
    ] as const) {
      view.click();
      target.dispatchEvent(new Event(event));
      vi.runAllTimers();
    }
    view.click();
    view.video.srcObject = {};
    vi.runAllTimers();
    view.click();
    view.dispose();
    vi.runAllTimers();
    view.click();
    view.doubleClick();
    vi.runAllTimers();
    expect(view.playback).not.toHaveBeenCalled();
    expect(view.fullscreen).not.toHaveBeenCalled();
  });

  it("leaves touch taps, control-bar clicks, auxiliary buttons and keyboard-generated clicks alone", () => {
    vi.useFakeTimers();
    const view = picture();
    view.pointer("touch");
    view.click();
    view.doubleClick();
    view.pointer();
    view.screen.dispatchEvent(Object.assign(new Event("click"), { detail: 1, button: 0 }));
    view.screen.dispatchEvent(Object.assign(new Event("dblclick"), { detail: 2, button: 0 }));
    view.click(1, 2);
    view.click(0);
    vi.runAllTimers();
    expect(view.playback).not.toHaveBeenCalled();
    expect(view.fullscreen).not.toHaveBeenCalled();
    view.dispose();
  });
});
