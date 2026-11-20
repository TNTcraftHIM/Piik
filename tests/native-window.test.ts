import { afterEach, expect, test, vi } from "vitest";
import { locales } from "../src/client/locales";
import controls from "../src/client/ui/window-controls.json";
import { surfaceViewport } from "../src/client/ui/window-appearance";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test.each([
  { native: "integrated", fullscreen: false, top: 0, expectedTop: controls.height },
  { native: "system", fullscreen: false, top: 0, expectedTop: 0 },
  { native: "integrated", fullscreen: false, top: 20, expectedTop: controls.height },
  { native: "integrated", fullscreen: true, top: 20, expectedTop: 20 },
])("surface bounds use the displaying $native document at offset $top (fullscreen=$fullscreen)", value => {
  const document = {
    documentElement: { dataset: { piikNativeWindow: value.native } },
    fullscreenElement: value.fullscreen ? {} : null,
    defaultView: {
      innerWidth: 900, innerHeight: 650,
      visualViewport: { offsetLeft: 10, offsetTop: value.top, width: 640, height: 400 },
      getComputedStyle: () => ({ getPropertyValue: () => `${controls.height}px` }),
    },
  } as unknown as Document;
  expect(surfaceViewport(document)).toEqual({
    left: 10, top: value.expectedTop, width: 640, height: value.top + 400 - value.expectedTop,
    right: 650, bottom: value.top + 400,
  });
});

test("native appearance follows the selected locale when the document language changes", async () => {
  const messages: Array<{ kind: string; language?: string }> = [];
  const root = { lang: "en", dataset: { theme: "light" }, style: { setProperty: vi.fn() } };
  let changed: () => void = () => {};
  vi.stubGlobal("window", { piikNativeWindow: "integrated", ipc: {
    postMessage: (message: string) => messages.push(JSON.parse(message)),
  } });
  vi.stubGlobal("document", { documentElement: root, querySelectorAll: () => [], addEventListener: vi.fn() });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { changed = callback; }
    observe() {}
  });
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  await import("../src/client/ui/native-window");
  expect(root.style.setProperty).toHaveBeenCalledWith("--native-caption-height", `${controls.height}px`);
  expect(root.style.setProperty).toHaveBeenCalledWith("--native-caption-width", `${controls.width}px`);
  for (const [language, locale] of Object.entries(locales)) {
    root.lang = locale.tag;
    changed();
    expect(messages.filter(message => message.kind === "appearance").at(-1)?.language).toBe(language);
    expect(Object.keys(controls.labels[language as keyof typeof controls.labels]).sort())
      .toEqual(Object.keys(controls.labels.en).sort());
  }
});

test("standalone App captions follow their document's modal material without integrated geometry", async () => {
  const messages: unknown[] = [];
  const root = { lang: "en", dataset: { theme: "dark" } as Record<string, string>, style: { setProperty: vi.fn() } };
  let dialogs: string[] = [];
  let changed: () => void = () => {};
  vi.stubGlobal("location", new URL("https://piik.test/client"));
  vi.stubGlobal("window", { piikNativeWindow: "system", ipc: {
    postMessage: (message: string) => messages.push(JSON.parse(message)),
  } });
  vi.stubGlobal("document", { documentElement: root,
    querySelectorAll: () => dialogs.map(material => ({ getAttribute: () => material })),
  });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { changed = callback; }
    observe() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  await import("../src/client/ui/native-window");
  expect(root.dataset.piikNativeWindow).toBe("system");
  expect(root.style.setProperty).toHaveBeenCalledExactlyOnceWith("--native-caption-height", `${controls.height}px`);
  expect(messages).toEqual([{ kind: "appearance", theme: "dark", language: "en", material: null }]);
  root.dataset.theme = "light";
  changed();
  expect(messages.at(-1)).toEqual({ kind: "appearance", theme: "light", language: "en", material: null });
  dialogs = ["surface"];
  changed();
  expect(messages.at(-1)).toEqual({ kind: "appearance", theme: "light", language: "en", material: "surface" });
  dialogs.push("image");
  changed();
  expect(messages.at(-1)).toEqual({ kind: "appearance", theme: "light", language: "en", material: "image" });
  root.dataset.theme = "dark";
  root.lang = "zh";
  changed();
  expect(messages.at(-1)).toEqual({ kind: "appearance", theme: "dark", language: "zh", material: "image" });
  dialogs.pop();
  changed();
  expect(messages.at(-1)).toEqual({ kind: "appearance", theme: "dark", language: "zh", material: "surface" });
  dialogs = [];
  changed();
  expect(messages.at(-1)).toEqual({ kind: "appearance", theme: "dark", language: "zh", material: null });
  const count = messages.length;
  changed();
  expect(messages).toHaveLength(count);
  expect(messages.every(message => (message as { kind: string }).kind === "appearance")).toBe(true);
});
