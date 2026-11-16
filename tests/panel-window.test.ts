import { afterEach, expect, test, vi } from "vitest";
import { openPanelWindow, panelWindowAPI, PANEL_SIZE } from "../src/client/ui/panel-window";

afterEach(() => vi.unstubAllGlobals());

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

test("an explicit tool size replaces workspace geometry and retirement closes the late window", async () => {
  const { container, requestWindow, finish } = setup();
  const controller = new AbortController();
  const close = vi.fn();
  const opening = openPanelWindow(container, controller.signal, vi.fn(), PANEL_SIZE);
  expect(requestWindow).toHaveBeenCalledWith({ ...PANEL_SIZE, preferInitialWindowPlacement: true });
  controller.abort(); finish({ close } as unknown as Window);
  await opening;
  expect(close).toHaveBeenCalledOnce();
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

test.each(["integrated", undefined] as const)("only an actual Native PiP child receives panel geometry: %s", async capability => {
  const { container, view, finish } = setup();
  const home = container.ownerDocument;
  view.piikNativeWindow = capability;
  Object.assign(home, {
    baseURI: "https://fixture.example/", styleSheets: [],
    documentElement: { lang: "en", dataset: { theme: "dark" }, getAttribute: () => null },
  });
  const appendHome = vi.fn();
  Object.assign(container.parentElement!, { append: appendHome });
  const postMessage = vi.fn(), close = vi.fn();
  const pip = {
    ipc: { postMessage }, close,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    document: {
      createElement: () => ({}), head: { append: vi.fn() },
      documentElement: { removeAttribute: vi.fn() }, body: { append: vi.fn() },
    },
  } as unknown as Window;
  let attributesChanged: () => void = () => {};
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { attributesChanged = callback; }
    observe() {} disconnect() {}
  });
  const controller = new AbortController();
  const changed = vi.fn();
  const opening = openPanelWindow(container, controller.signal, changed);
  finish(pip);
  await opening;
  if (capability) {
    expect(postMessage.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { kind: "panel", width: 304, height: 346 },
      { kind: "appearance", theme: "dark", language: "en", material: null },
    ]);
    home.documentElement.dataset.theme = "light";
    attributesChanged();
    expect(JSON.parse(postMessage.mock.calls.at(-1)![0])).toEqual({ kind: "appearance", theme: "light", language: "en", material: null });
    expect(postMessage.mock.calls.filter(([message]) => JSON.parse(message).kind === "panel")).toHaveLength(1);
  } else expect(postMessage).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledExactlyOnceWith(pip.document);
  controller.abort();
  expect(close).toHaveBeenCalledOnce();
  expect(appendHome).toHaveBeenCalledExactlyOnceWith(container);
});
