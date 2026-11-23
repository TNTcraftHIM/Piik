import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const firstPaint = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)![1]!;
const keys = ["piik:ui-lang", "piik:ui-theme"];

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
  it("marks ordinary bookmark invitations as App launches and preserves their invitation", async () => {
    const env = browser(["zh", "light"]);
    const { clientLaunchURL, takeClientLaunchBootstrap, clientRuntimePort } = await import("../src/client/lib/app-launch");
    env.page.location = new URL(clientLaunchURL("https://site.example/r?existing=1#room=owned-fixture&invite=fixture-key", {
      lang: "en", theme: "dark", explicit: ["copy", "theme"],
    }, false, 19481));
    runInNewContext(firstPaint, { ...env.page, document: env.document, URLSearchParams, matchMedia: env.page.matchMedia });
    expect(env.document.documentElement.dataset.theme).toBe("dark");
    const presentation = takeClientLaunchBootstrap()!;
    const themes = await import("../src/client/ui/theme");
    const copy = await import("../src/client/ui/copy");
    themes.initTheme(presentation.theme, presentation.explicit!.includes("theme"));
    copy.applyLaunchCopy(presentation, presentation.explicit!.includes("copy"));
    expect(env.saved()).toEqual(["en", "dark"]);
    expect(clientRuntimePort()).toBe(19481);
    expect(env.page.location.search).toBe("?existing=1");
    expect(env.page.location.hash).toBe("#room=owned-fixture&invite=fixture-key");
  });

  it.each([false, true])("activates the current page after approval, including blocked storage: %s", async (blocked) => {
    const env = browser([], blocked);
    const events = new EventTarget();
    Object.assign(env.page, {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });
    const { isClientActivated, activateClient, watchClientActivation } = await import("../src/client/lib/app-launch");
    const changed = vi.fn();
    const release = watchClientActivation(changed);
    expect(isClientActivated()).toBe(false);
    activateClient();
    expect(isClientActivated()).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(env.page.location.href).toBe("https://site.example/");
    expect(env.values.get("piik:client-launch:v1")).toBe(blocked ? undefined : "1");
    release();
    activateClient();
    expect(changed).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "default handoff preserves saved choices", saved: ["zh", "dark"], fields: "", selection: "zh", theme: "dark", result: ["zh", "dark"] },
    { name: "default handoff supplies only temporary first-use defaults", saved: [], fields: "", selection: "en", theme: "light", result: [null, null] },
    { name: "explicit language keeps the destination theme", saved: ["zh", "dark"], fields: "copy", selection: "en", theme: "dark", result: ["en", "dark"] },
    { name: "explicit theme keeps the destination language", saved: ["zh", "dark"], fields: "theme", selection: "zh", theme: "light", result: ["zh", "light"] },
    { name: "both explicit domains replace saved choices", saved: ["zh", "dark"], fields: "copy,theme", selection: "en", theme: "light", result: ["en", "light"] },
  ])("$name", async ({ saved, fields, selection, theme, result }) => {
    const env = browser(saved);
    env.page.location = new URL(`https://site.example/${fields ? `?piik-preferences=${fields}` : ""}#piik-client=1&piik-lang=en&piik-theme=light`);
    runInNewContext(firstPaint, { ...env.page, document: env.document, URLSearchParams, matchMedia: env.page.matchMedia });
    expect(env.document.documentElement.dataset.theme).toBe(theme);
    const copy = await import("../src/client/ui/copy");
    const themes = await import("../src/client/ui/theme");
    const { takeClientLaunchBootstrap } = await import("../src/client/lib/app-launch");
    const presentation = takeClientLaunchBootstrap()!;
    themes.initTheme(presentation.theme, presentation.explicit!.includes("theme"));
    copy.applyLaunchCopy(presentation, presentation.explicit!.includes("copy"));
    function Selection() { const { lang } = copy.useCopy(); return lang; }
    expect(renderToStaticMarkup(createElement(Selection))).toBe(selection);
    expect(env.document.documentElement.dataset.theme).toBe(theme);
    expect(env.saved()).toEqual(result);
    expect(env.page.location.search).toBe("");
    expect(env.page.location.hash).toBe("");
  });

  it("does not clear a saved dark theme on a default system-theme handoff", async () => {
    const env = browser(["zh", "dark"]);
    const theme = await import("../src/client/ui/theme");
    theme.initTheme(null, false);
    expect(env.saved()).toEqual(["zh", "dark"]);
    expect(env.document.documentElement.dataset.theme).toBe("dark");
  });

  it("retains explicit in-memory choices when storage is unavailable", async () => {
    const env = browser([], true);
    const copy = await import("../src/client/ui/copy");
    const theme = await import("../src/client/ui/theme");
    theme.initTheme();
    copy.setCopy({ lang: "zh" });
    theme.applyTheme("dark");
    copy.applyLaunchCopy({ lang: "en" }, false);
    theme.initTheme(null, false);
    function Selection() { const { lang } = copy.useCopy(); return lang; }
    expect(renderToStaticMarkup(createElement(Selection))).toBe("zh");
    expect(copy.hasCopyPreference()).toBe(true);
    expect(theme.currentThemePreference()).toBe("dark");
    expect(env.document.documentElement.dataset.theme).toBe("dark");
    expect(env.saved()).toEqual([null, null]);
  });

  it("consumes presentation and runtime port while preserving the destination fragment", async () => {
    const env = browser();
    const { clientLaunchURL, takeClientLaunchBootstrap } = await import("../src/client/lib/app-launch");
    const target = new URL(clientLaunchURL("https://site.example/?debug=1#piik-client=1&owner=room-owner", {
      lang: "zh", theme: "dark", explicit: ["copy", "theme"],
    }, undefined, 39730));
    const fragment = new URLSearchParams(target.hash.slice(1));
    expect(fragment.get("piik-lang")).toBe("zh");
    expect(fragment.has("piik-mode")).toBe(false);
    expect(fragment.get("piik-theme")).toBe("dark");
    expect(target.searchParams.get("piik-client-port")).toBe("39730");
    env.page.location = target;
    expect(takeClientLaunchBootstrap()?.explicit).toEqual(["copy", "theme"]);
    expect(env.page.location.search).toBe("?debug=1");
    expect(env.page.location.hash).toBe("#owner=room-owner");
  });

  it.each(["0", "65536", "NaN", "39721.5"])("ignores invalid runtime ports: %s", async port => {
    const env = browser();
    env.page.location = new URL(`https://site.example/?piik-client-port=${port}#piik-client=1`);
    const { takeClientLaunchBootstrap, clientRuntimePort, isClientActivated } = await import("../src/client/lib/app-launch");
    expect(takeClientLaunchBootstrap()).toBeNull();
    expect(isClientActivated()).toBe(true);
    expect(clientRuntimePort()).toBeNull();
    expect(env.page.location.href).toBe("https://site.example/");
    expect(env.values.get("piik:client-launch:v1")).toBe("1");
  });

  it("keeps an explicit App port outside discovery range when storage is unavailable", async () => {
    const env = browser([], true);
    Object.assign(env.page, { sessionStorage: {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    } });
    env.page.location = new URL("https://site.example/?piik-client-port=49152#piik-client=1");
    const { takeClientLaunchBootstrap, clientRuntimePort, isClientActivated } = await import("../src/client/lib/app-launch");
    takeClientLaunchBootstrap();
    expect(clientRuntimePort()).toBe(49152);
    expect(isClientActivated()).toBe(true);
    expect(env.page.location.href).toBe("https://site.example/");
  });
});
