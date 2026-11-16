import { afterEach, expect, test, vi } from "vitest";
import { locales } from "../src/client/locales";
import controls from "../src/client/ui/window-controls.json";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

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

test("system-decorated App windows report the same document appearance without custom caption geometry", async () => {
  const messages: unknown[] = [];
  const root = { lang: "en", dataset: { theme: "dark" } as Record<string, string>, style: { setProperty: vi.fn() } };
  let changed: () => void = () => {};
  vi.stubGlobal("window", { piikNativeWindow: "system", ipc: {
    postMessage: (message: string) => messages.push(JSON.parse(message)),
  } });
  vi.stubGlobal("document", { documentElement: root });
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
});
