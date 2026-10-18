import { expect, test, vi } from "vitest";
import { openPanelWindow, panelWindowAPI } from "../src/client/ui/panel-window";

function setup() {
  let finish!: (view: Window) => void;
  const requestWindow = vi.fn(() => new Promise<Window>(resolve => { finish = resolve; }));
  const view = { isSecureContext: true, documentPictureInPicture: { requestWindow } } as unknown as Window;
  Object.defineProperty(view, "top", { value: view });
  const container = { ownerDocument: { defaultView: view }, parentElement: {}, isConnected: true,
    firstElementChild: { getBoundingClientRect: () => ({ width: 304, height: 346 }) } } as unknown as HTMLElement;
  return { container, view, requestWindow, finish: (window: Window) => finish(window) };
}

test("a room retired while the browser opens PiP closes the late window without moving its UI", async () => {
  const { container, finish, requestWindow } = setup();
  const controller = new AbortController();
  const changed = vi.fn();
  const close = vi.fn();
  const opening = openPanelWindow(container, controller.signal, changed);
  expect(requestWindow).toHaveBeenCalledWith({ width: 304, height: 346, preferInitialWindowPlacement: true });
  controller.abort();
  finish({ close } as unknown as Window);
  await opening;
  expect(close).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
});

test("an already retired surface does not ask the browser for another window", async () => {
  const { container, requestWindow } = setup();
  await openPanelWindow(container, AbortSignal.abort(), vi.fn());
  expect(requestWindow).not.toHaveBeenCalled();
});

test("browser refusal leaves the current surface untouched and reports failure to its caller", async () => {
  const { container, requestWindow } = setup();
  requestWindow.mockRejectedValueOnce(new Error("NotAllowedError"));
  const changed = vi.fn();
  await expect(openPanelWindow(container, new AbortController().signal, changed)).rejects.toThrow("NotAllowedError");
  expect(changed).not.toHaveBeenCalled();
});

test("unavailable or embedded browsers retain the in-page panel", () => {
  expect(panelWindowAPI(null)).toBeUndefined();
  const { view } = setup();
  expect(panelWindowAPI(view)).toBeDefined();
  expect(panelWindowAPI({ ...view, top: view } as Window)).toBeUndefined();
});
