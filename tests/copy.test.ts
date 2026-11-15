import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLanguage, rememberLanguage } from "../site/assets/language.js";
import { locales, visualTitleFrames } from "../src/client/locales";

import {
  getTitleFrames,
  isCopyKey,
  say,
  setCopy,
  t,
  type CopyKey,
} from "../src/client/ui/copy.ts";

describe("copy catalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCopy({ lang: "zh", vis: false });
  });

  it.each([
    ["zh-CN", "zh:false"],
    ["zh-TW", "zh-Hant:false"],
    ["zh-HK", "zh-Hant:false"],
    ["zh-SG", "zh:false"],
    ["zh-Hans", "zh:false"],
    ["zh-Hant", "zh-Hant:false"],
    ["zh-Hant-HK", "zh-Hant:false"],
    ["en-US", "en:false"],
    ["ja-JP", "ja:false"],
    [undefined, "en:false"],
  ])("uses the primary system language on first use: %s", async (language, expected) => {
    vi.resetModules();
    vi.stubGlobal("navigator", { language });
    const [{ useCopy }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
      import("../src/client/ui/copy.ts"),
      import("react"),
      import("react-dom/server"),
    ]);
    function Selection() {
      const { lang, vis } = useCopy();
      return `${lang}:${vis}`;
    }
    expect(renderToStaticMarkup(createElement(Selection))).toBe(expected);
  });

  it.each([
    ["zh", "text", "zh:false"],
    ["en", "vis", "en:true"],
    ["ja", "vis", "ja:true"],
    ["zh-Hant", "text", "zh-Hant:false"],
    ["ko", "text", "ko:false"],
  ])("keeps an explicit %s/%s choice over the system default", async (lang, mode, expected) => {
    vi.resetModules();
    vi.stubGlobal("navigator", { language: "ja-JP" });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === "piik:ui-lang" ? lang : mode,
      },
      addEventListener: () => {},
    });
    const [{ useCopy }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
      import("../src/client/ui/copy.ts"),
      import("react"),
      import("react-dom/server"),
    ]);
    function Selection() {
      const { lang, vis } = useCopy();
      return `${lang}:${vis}`;
    }
    expect(renderToStaticMarkup(createElement(Selection))).toBe(expected);
  });

  it("renders zh and en for every key", () => {
    const zh = t("zh", "join.title");
    expect(zh).toBe("加入房间");
    expect(t("en", "join.title")).toBe("Join a room");
    expect(t("zh", "host.advanced.route.peerOnly")).toBe("隐私模式");
    expect(t("en", "host.advanced.route.peerOnly")).toBe("Privacy mode");
    expect(isCopyKey("viewer.reconnect")).toBe(true);
    expect(isCopyKey("Reconnect media")).toBe(false);
  });

  it("interpolates variables", () => {
    expect(t("zh", "host.title", { name: "阿舟" })).toBe("阿舟 的屏幕");
    expect(t("zh", "viewer.title", { name: "$&" })).toBe("$& 的屏幕");
  });

  it("keeps primary catalogs complete and supplied translations valid", () => {
    const keys = Object.keys(locales.zh.copy) as CopyKey[];
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
    for (const lang of ["zh", "en"] as const) {
      expect(Object.keys(locales[lang].copy).sort(), lang).toEqual([...keys].sort());
    }
    for (const [lang, locale] of Object.entries(locales)) {
      for (const [key, value] of Object.entries(locale.copy)) {
        expect(isCopyKey(key), `${lang}: obsolete ${key}`).toBe(true);
        expect(value.trim(), `${lang}: ${key}`).not.toBe("");
        expect(placeholders(value), `${lang}: ${key}`)
          .toEqual(placeholders(locales.zh.copy[key as CopyKey]));
      }
      for (const frames of Object.values(locale.titleFrames)) {
        expect(frames.label.trim().length, lang).toBeGreaterThan(0);
        expect(frames.variations.every((frame: string) => frame.trim().length > 0), lang).toBe(true);
      }
      for (const pool of [locale.playful.welcome.map(entry => entry.text), locale.playful.waiting]) {
        expect(pool.every(text => text.trim().length > 0), lang).toBe(true);
        expect(new Set(pool).size, lang).toBe(pool.length);
      }
    }
  });

  it.each(["zh-Hant", "ja", "ko"] as const)("carries %s through selection and App handoff", async lang => {
    vi.resetModules();
    const registry = await import("../src/client/locales");
    try {
      const stored = new Map<string, string>([["piik:ui-lang", lang]]);
      vi.stubGlobal("navigator", { language: "en-US" });
      vi.stubGlobal("document", { documentElement: { lang: "en" } });
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => stored.set(key, value),
        },
        addEventListener: () => {},
        location: new URL("https://site.example/"),
        history: { state: null, replaceState: vi.fn() },
      });
      const copy = await import("../src/client/ui/copy");
      const { clientLaunchURL, takeClientLaunchBootstrap } = await import("../src/client/lib/session");

      expect(registry.resolveLang(registry.locales[lang].tag)).toBe(lang);
      expect(registry.resolveLang("zh-CN")).toBe("zh");
      expect(registry.isLang("toString")).toBe(false);
      expect(copy.currentLang()).toBe(lang);
      expect(document.documentElement.lang).toBe(registry.locales[lang].tag);
      expect(copy.t(copy.currentLang(), "common.host")).toBe(locales[lang].copy["common.host"]);

      const presentation = { lang: copy.currentLang(), vis: false, theme: null };
      window.location.hash = new URL(clientLaunchURL("https://site.example/#piik-client=1", presentation)).hash;
      expect(takeClientLaunchBootstrap().presentation).toEqual({ ...presentation, explicit: [] });
      expect(registry.consoleLanguage(presentation.lang, false)).toBe("en");
      expect(registry.consoleLanguage(presentation.lang, true)).toBe("vis");
      expect(registry.consoleLanguage("zh", false)).toBe("zh");
    } finally {
      vi.resetModules();
    }
  });

  it.each(["zh-Hant", "ja", "ko"] as const)("uses the partial %s catalog with English and visual defaults", lang => {
    expect(t(lang, "common.copied")).toBe(locales[lang].copy["common.copied"]);
    expect(locales[lang].copy["mode.vis"]).toBeUndefined();
    expect(t(lang, "mode.vis")).toBe(locales.en.copy["mode.vis"]);
    expect(getTitleFrames(lang, false, "hostActive")).toBe(locales.en.titleFrames.hostActive);
    expect(getTitleFrames(lang, true, "hostActive")).toBe(visualTitleFrames.hostActive);
  });

  it("say() follows the current language", () => {
    setCopy({ lang: "zh" });
    expect(say("common.copied")).toBe("已复制");
    setCopy({ lang: "en" });
    expect(say("common.copied")).toBe("Copied");
  });

  it("keeps title variations in the selected content catalog", () => {
    const zhHost = getTitleFrames("zh", false, "hostActive");
    const enViewer = getTitleFrames("en", false, "viewerActive");
    const visualViewer = getTitleFrames("zh", true, "viewerActive");

    expect(zhHost.label).toBe("分享中");
    expect(zhHost.variations).toContain("小电视上工");
    expect(enViewer.label).toBe("Watching");
    expect(enViewer.variations).toContain("Popcorn ready");
    expect(visualViewer.label).toBe("📺");
    expect(visualViewer.variations).toContain("🍿");
    expect(getTitleFrames("zh", false, "hostIdle").variations).toContain("天线在打盹");
    expect(getTitleFrames("en", false, "viewerWaiting").variations).toContain(
      "Couch saved you a spot",
    );
    expect(getTitleFrames("zh", true, "hostReady").variations).toContain("🍵");
  });

  it("keeps actionable titles fixed and lets playful pools vary independently", () => {
    const playful = new Set([
      "hostActive", "viewerActive", "hostStarting", "hostReady", "hostIdle", "viewerWaiting",
    ]);
    for (const catalog of [locales.zh.titleFrames, locales.en.titleFrames, visualTitleFrames]) {
      for (const [state, frames] of Object.entries(catalog)) {
        if (!playful.has(state)) expect(frames.variations, state).toEqual([]);
        expect(new Set(frames.variations).size, state).toBe(frames.variations.length);
      }
    }
  });

  it("keeps the document language aligned with the selected catalog", () => {
    const documentElement = { lang: "zh-CN" };
    vi.stubGlobal("document", { documentElement });

    setCopy({ lang: "en" });
    expect(documentElement.lang).toBe("en");
    setCopy({ lang: "zh" });
    expect(documentElement.lang).toBe("zh-CN");
  });
});

describe("website language", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["zh-CN", null, "", "zh-CN"],
    ["zh-TW", null, "", "zh-CN"],
    ["zh-HK", null, "", "zh-CN"],
    ["zh-SG", null, "", "zh-CN"],
    ["zh-Hans", null, "", "zh-CN"],
    ["zh-Hant", null, "", "zh-CN"],
    ["zh-Hant-HK", null, "", "zh-CN"],
    ["en-US", null, "", "en"],
    ["ja-JP", null, "", "en"],
    ["ja-JP", "zh-CN", "", "zh-CN"],
    ["zh-CN", "zh-CN", "?lang=en", "en"],
  ])("resolves system, saved and linked language: %s/%s/%s", (language, saved, search, expected) => {
    vi.stubGlobal("navigator", { language });
    vi.stubGlobal("location", { search });
    vi.stubGlobal("localStorage", { getItem: () => saved });
    expect(initialLanguage()).toBe(expected);
  });

  it("uses the system default when storage is unavailable", () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    vi.stubGlobal("location", new URL("https://example.test/?preview=1#download"));
    const replaceState = vi.fn();
    vi.stubGlobal("history", { state: null, replaceState });
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(initialLanguage()).toBe("zh-CN");
    expect(() => rememberLanguage("en")).not.toThrow();
    expect(String(replaceState.mock.calls[0]?.[2])).toBe("https://example.test/?preview=1&lang=en#download");
  });
});
