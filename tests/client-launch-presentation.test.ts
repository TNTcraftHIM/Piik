import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const firstPaint = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)![1]!;
const keys = ["piik:ui-lang", "piik:ui-mode", "piik:ui-theme"];

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function browser(saved: string[] = [], blocked = false) {
  const values = new Map(keys.flatMap((key, index) => saved[index] ? [[key, saved[index]!]] : []));
  const localStorage = {
    getItem(key: string) { if (blocked) throw new Error("blocked"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw new Error("blocked"); values.set(key, value); },
    removeItem(key: string) { if (blocked) throw new Error("blocked"); values.delete(key); },
  };
  const page = {
    location: new URL("https://site.example/"),
    localStorage,
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
    addEventListener: vi.fn(),
    matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
    history: {
      state: null,
      replaceState: (_state: unknown, _unused: string, url: string) => {
        page.location = new URL(url, page.location);
      },
    },
  };
  const document = { documentElement: { lang: "en", dataset: {} as Record<string, string> } };
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", page);
  return { page, document, values, saved: () => keys.map(key => values.get(key) ?? null) };
}

describe("App presentation handoff authority", () => {
  it.each([
    { name: "old launcher preserves saved choices", saved: ["zh", "vis", "dark"], fields: "", selection: "zh:true", theme: "dark", result: ["zh", "vis", "dark"] },
    { name: "old launcher supplies only temporary first-use defaults", saved: [], fields: "", selection: "en:false", theme: "light", result: [null, null, null] },
    { name: "explicit language keeps the destination theme", saved: ["zh", "vis", "dark"], fields: "copy", selection: "en:false", theme: "dark", result: ["en", "text", "dark"] },
    { name: "explicit theme keeps the destination language and visual mode", saved: ["zh", "vis", "dark"], fields: "theme", selection: "zh:true", theme: "light", result: ["zh", "vis", "light"] },
    { name: "both explicit domains replace saved choices", saved: ["zh", "vis", "dark"], fields: "copy,theme", selection: "en:false", theme: "light", result: ["en", "text", "light"] },
  ])("$name", async ({ saved, fields, selection, theme, result }) => {
    const env = browser(saved);
    env.page.location = new URL(`https://site.example/${fields ? `?piik-preferences=${fields}` : ""}#piik-client=1&piik-lang=en&piik-mode=text&piik-theme=light`);
    runInNewContext(firstPaint, { ...env.page, document: env.document, URLSearchParams, matchMedia: env.page.matchMedia });
    expect(env.document.documentElement.dataset.theme).toBe(theme);
    const copy = await import("../src/client/ui/copy");
    const themes = await import("../src/client/ui/theme");
    const { takeClientLaunchBootstrap } = await import("../src/client/lib/session");
    const presentation = takeClientLaunchBootstrap().presentation!;
    themes.initTheme(presentation.theme, presentation.explicit!.includes("theme"));
    copy.applyLaunchCopy(presentation, presentation.explicit!.includes("copy"));
    function Selection() { const { lang, vis } = copy.useCopy(); return `${lang}:${vis}`; }
    expect(renderToStaticMarkup(createElement(Selection))).toBe(selection);
    expect(env.document.documentElement.dataset.theme).toBe(theme);
    expect(env.saved()).toEqual(result);
    expect(env.page.location.search).toBe("");
    expect(env.page.location.hash).toBe("");
  });

  it("does not clear a saved dark theme on an old system-theme handoff", async () => {
    const env = browser(["zh", "vis", "dark"]);
    const theme = await import("../src/client/ui/theme");
    theme.initTheme(null, false);
    expect(env.saved()).toEqual(["zh", "vis", "dark"]);
    expect(env.document.documentElement.dataset.theme).toBe("dark");
  });

  it("retains explicit in-memory choices when storage is unavailable", async () => {
    const env = browser([], true);
    const copy = await import("../src/client/ui/copy");
    const theme = await import("../src/client/ui/theme");
    theme.initTheme();
    copy.setCopy({ lang: "zh", vis: true });
    theme.applyTheme("dark");
    copy.applyLaunchCopy({ lang: "en", vis: false }, false);
    theme.initTheme(null, false);
    function Selection() { const { lang, vis } = copy.useCopy(); return `${lang}:${vis}`; }
    expect(renderToStaticMarkup(createElement(Selection))).toBe("zh:true");
    expect(copy.hasCopyPreference()).toBe(true);
    expect(theme.currentThemePreference()).toBe("dark");
    expect(env.document.documentElement.dataset.theme).toBe("dark");
    expect(env.saved()).toEqual([null, null, null]);
  });

  it("keeps the old complete tuple and exact invitation fragment usable on old Sites", async () => {
    const env = browser();
    const { clientLaunchURL, takeClientLaunchBootstrap, readViewerRoute } = await import("../src/client/lib/session");
    const grant = `${"a".repeat(21)}A`;
    const target = new URL(clientLaunchURL(`https://site.example/r/9527?debug=1#piik-client=1&v=${grant}`, {
      lang: "zh", vis: true, theme: "dark", explicit: ["copy", "theme"],
    }));
    const oldFragment = new URLSearchParams(target.hash.slice(1));
    expect(oldFragment.get("piik-lang")).toBe("zh");
    expect(oldFragment.get("piik-mode")).toBe("vis");
    expect(oldFragment.get("piik-theme")).toBe("dark");
    // The released reader removes only these keys before its exact #v= parser.
    for (const key of ["piik-client", "client-access", "piik-lang", "piik-mode", "piik-theme"]) oldFragment.delete(key);
    expect(oldFragment.toString()).toBe(`v=${grant}`);
    env.page.location = target;
    expect(takeClientLaunchBootstrap().presentation?.explicit).toEqual(["copy", "theme"]);
    expect(env.page.location.search).toBe("?debug=1");
    expect(readViewerRoute()).toEqual({ roomId: "9527", viewerGrant: grant });
  });
});
