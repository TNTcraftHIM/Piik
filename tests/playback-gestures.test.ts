import { expect, it, vi } from "vitest";
import { bindPlaybackGestures } from "../src/client/components/living/playback-gestures";

it("reserves picture gestures for desktop double-click fullscreen and removes them on disposal", () => {
  const screen = new EventTarget();
  const video = Object.assign(new EventTarget(), { parentElement: screen });
  const fullscreen = vi.fn();
  const dispose = bindPlaybackGestures(video as unknown as HTMLVideoElement, fullscreen);
  const pointer = (pointerType: string) => screen.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerType }));
  const doubleClick = () => video.dispatchEvent(Object.assign(new Event("dblclick"), { button: 0 }));

  pointer("touch"); doubleClick();
  pointer("mouse");
  video.dispatchEvent(new Event("click"));
  screen.dispatchEvent(Object.assign(new Event("dblclick"), { button: 0 }));
  const consumed = Object.assign(new Event("dblclick", { cancelable: true }), { button: 0 });
  consumed.preventDefault(); video.dispatchEvent(consumed);
  expect(fullscreen).not.toHaveBeenCalled();
  doubleClick();
  expect(fullscreen).toHaveBeenCalledOnce();
  dispose(); doubleClick();
  expect(fullscreen).toHaveBeenCalledOnce();
});
