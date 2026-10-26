import { afterEach, expect, it, vi } from "vitest";
import { RemoteViewport } from "../src/client/remote-control/viewport";
import { RemoteTouchpad } from "../src/client/remote-control/touchpad";
import { picturePoint, pictureRect, rotatePicturePoint, type VideoRotation } from "../src/client/media/video-geometry";
import type { RemoteInputEvent } from "../src/client/remote-control/input-session";

afterEach(() => vi.unstubAllGlobals());

// The boundary models CSS translate/scale around the video cell's center.
// Camera bounds, fitted picture and source coordinates use production owners.
function viewport(width = 400, height = 200, rotation: VideoRotation = 0) {
  const frame = { left: 20, top: 30, width, height };
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height });
  const surface = { getBoundingClientRect: () => rect(frame.left, frame.top, frame.width, frame.height) } as HTMLElement;
  const style = { transform: "", clipPath: "", objectFit: "fill", width: `${width}px`, height: `${height}px` };
  const video = { videoWidth: width, videoHeight: height, style, dataset: { pictureRotation: String(rotation) },
    getBoundingClientRect: () => {
      const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(style.transform);
      const x = Number(match?.[1] ?? 0), y = Number(match?.[2] ?? 0), scale = Number(match?.[3] ?? 1);
      return rect(frame.left + frame.width * (1 - scale) / 2 + x,
        frame.top + frame.height * (1 - scale) / 2 + y, frame.width * scale, frame.height * scale);
    } } as unknown as HTMLVideoElement;
  vi.stubGlobal("getComputedStyle", () => style);
  const changed = vi.fn(), view = new RemoteViewport(video, surface, changed);
  const point = (position: { x: number; y: number }) => {
    const picture = pictureRect(video)!, rotated = rotatePicturePoint(position, rotation);
    return { x: picture.left + rotated.x * picture.width, y: picture.top + rotated.y * picture.height };
  };
  return { frame, video, surface, style, changed, view, point };
}

it("zooms out with black gutters, pans at unit scale and restores the original cell", () => {
  const { view, video, style, surface, point } = viewport();
  const center = { x: 220, y: 130 };
  view.transform(center, center, .1);
  expect(view.scale).toBe(.5);
  expect(pictureRect(video)).toEqual({ left: 120, top: 80, width: 200, height: 100 });
  expect(picturePoint(video, 30, 40)).toBeNull();
  expect(style.clipPath).toContain("inset(");
  expect(style.clipPath).toContain("-");
  view.follow({ x: 1, y: 1 }, { right: 128, bottom: 172 });
  expect(point({ x: 1, y: 1 }).y + 172).toBe(surface.getBoundingClientRect().bottom);
  view.transform(center, center, 20);
  expect(view.scale).toBe(4);
  view.reset();
  view.transform(center, { x: 10000, y: 10000 }, 1);
  const picture = pictureRect(video)!, frame = surface.getBoundingClientRect();
  expect(view.scale).toBe(1);
  expect(style.transform).toContain("translate(");
  expect(style.clipPath).not.toBe("");
  expect(frame.right - picture.left).toBeGreaterThanOrEqual(200);
  expect(frame.bottom - picture.top).toBeGreaterThanOrEqual(100);
  view.reset();
  expect(style.transform).toBe(""); expect(style.clipPath).toBe("");
});

it.each([0, 90, 180, 270] as const)("follows the source point without changing it after rotation %s", rotation => {
  const { view, point, surface, changed } = viewport(300, 300, rotation);
  const position = { x: 1, y: 1 }, original = { ...position }, room = { right: 128, bottom: 172 };
  view.follow(position, room);
  const cursor = point(position), frame = surface.getBoundingClientRect();
  expect(cursor.x).toBeGreaterThanOrEqual(frame.left);
  expect(cursor.y).toBeGreaterThanOrEqual(frame.top);
  expect(cursor.x + room.right).toBeLessThanOrEqual(frame.right);
  expect(cursor.y + room.bottom).toBeLessThanOrEqual(frame.bottom);
  expect(position).toEqual(original);
  changed.mockClear();
  view.follow(position, room);
  expect(changed).not.toHaveBeenCalled();
});

it("uses actual tool room even when only a narrow strip of picture remains", () => {
  const { view, point, video, surface } = viewport(390, 185);
  const position = { x: 1, y: 1 };
  view.follow(position, { right: 128, bottom: 172 });
  expect(point(position)).toEqual({ x: 282, y: 43 });
  expect(pictureRect(video)!.top).toBeLessThan(surface.getBoundingClientRect().top);
  expect(pictureRect(video)!.top + pictureRect(video)!.height - surface.getBoundingClientRect().top).toBe(13);
  // An oversized tool still leaves a pixel of picture, rather than losing it.
  view.follow(position, { right: 1000, bottom: 1000 });
  expect(point(position)).toEqual({ x: 21, y: 31 });
});

it("republishes geometry on resize and reaches the full remote source beyond the visible crop", () => {
  const { view, video, point, frame } = viewport();
  const events: RemoteInputEvent[] = [], room = { right: 128, bottom: 172 };
  const pad = new RemoteTouchpad(() => ({ ...pictureRect(video)!, rotation: 0 }), event => events.push(event),
    () => {}, position => view.follow(position, room), view);
  pad.setVirtualMouse(true);
  pad.button(0, true);
  pad.moveBy(400, 200);
  const position = pad.position;
  expect(position).toEqual({ x: 1, y: 1 });
  expect(events.at(-1)).toEqual({ type: "move", x: 1, y: 1 });
  expect(point(position).y + room.bottom).toBe(frame.top + frame.height);
  frame.height = 185;
  view.refresh();
  const count = events.length;
  pad.refresh();
  expect(pad.position).toBe(position);
  expect(events).toHaveLength(count);
  expect(point(position).y + room.bottom).toBe(frame.top + frame.height);
  pad.reset();
  expect(events.at(-1)).toEqual({ type: "button", button: 0, down: false });
  view.reset();
  view.follow(position, null);
  expect(video.style.transform).toBe("");
});
