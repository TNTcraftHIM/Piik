import { afterEach, expect, test, vi } from "vitest";
import { locales } from "../src/client/locales";
import controls from "../src/client/ui/window-controls.json";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test("native appearance follows the selected locale when the document language changes", async () => {
  const messages: Array<{ kind: string; language?: string }> = [];
  const root = { lang: "en", dataset: { theme: "light" }, style: { setProperty: vi.fn() } };
  let changed: () => void = () => {};
  vi.stubGlobal("window", { piikNativeWindow: true, ipc: {
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
  for (const [language, locale] of Object.entries(locales)) {
    root.lang = locale.tag;
    changed();
    expect(messages.filter(message => message.kind === "appearance").at(-1)?.language).toBe(language);
    expect(Object.keys(controls.labels[language as keyof typeof controls.labels]).sort())
      .toEqual(Object.keys(controls.labels.en).sort());
  }
});
