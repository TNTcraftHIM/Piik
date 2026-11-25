import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLanguage, rememberLanguage } from "../site/assets/language.js";
import { locales, primaryLanguages, resolveLang } from "../src/client/locales";

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
    setCopy({ lang: "zh" });
  });

  it.each([
    ["zh-CN", "zh"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-SG", "zh"],
    ["zh-Hans", "zh"],
    ["zh-Hant", "zh-Hant"],
    ["zh-Hant-HK", "zh-Hant"],
    ["en-US", "en"],
    ["ja-JP", "ja"],
    [undefined, "en"],
  ])("uses the primary system language on first use: %s", async (language, expected) => {
    vi.resetModules();
    vi.stubGlobal("navigator", { language });
    const [{ useCopy }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
      import("../src/client/ui/copy.ts"),
      import("react"),
      import("react-dom/server"),
    ]);
    function Selection() {
      const { lang } = useCopy();
      return lang;
    }
    expect(renderToStaticMarkup(createElement(Selection))).toBe(expected);
  });

  it.each([
    ["zh", "zh"],
    ["en", "en"],
    ["zh-Hant", "zh-Hant"],
    ["ko", "ko"],
  ])("keeps an explicit %s choice over the system default", async (lang, expected) => {
    vi.resetModules();
    vi.stubGlobal("navigator", { language: "ja-JP" });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === "piik:ui-lang" ? lang : null,
      },
      addEventListener: () => {},
    });
    const [{ useCopy }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
      import("../src/client/ui/copy.ts"),
      import("react"),
      import("react-dom/server"),
    ]);
    function Selection() {
      const { lang } = useCopy();
      return lang;
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

  it.each(["zh-Hant", "ja", "ko"] as const)("uses English for a missing %s message", lang => {
    const key = "common.copied";
    const translated = locales[lang].copy[key];
    try {
      Reflect.deleteProperty(locales[lang].copy, key);
      expect(t(lang, key)).toBe(locales.en.copy[key]);
    } finally {
      locales[lang].copy[key] = translated;
    }
  });

  it("keeps primary catalogs complete and supplied translations valid", () => {
    const keys = Object.keys(locales.zh.copy) as CopyKey[];
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
    for (const lang of primaryLanguages) {
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

  it("resolves scripts before regions and rejects invalid tags", () => {
    expect(resolveLang("zh-Hans-TW")).toBe("zh");
    expect(resolveLang("zh-Hant-CN")).toBe("zh-Hant");
    expect(resolveLang("ko-KR")).toBe("ko");
    expect(resolveLang("not_a_tag")).toBe("en");
    expect(resolveLang("fr-CA")).toBe("en");
  });

  it("synchronizes another tab's language without writing it back", async () => {
    vi.resetModules();
    let saved = "en";
    let onStorage: (event: { key: string }) => void = () => {};
    const setItem = vi.fn();
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    vi.stubGlobal("window", {
      localStorage: { getItem: () => saved, setItem },
      addEventListener: (_name: string, listener: typeof onStorage) => { onStorage = listener; },
    });
    const copy = await import("../src/client/ui/copy");
    saved = "zh-Hant";
    onStorage({ key: "piik:ui-lang" });
    expect(copy.say("common.copied")).toBe(copy.t("zh-Hant", "common.copied"));
    expect(document.documentElement.lang).toBe("zh-Hant");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("follows the App window without copying its language as a preference", async () => {
    vi.resetModules();
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "ja", setItem },
      addEventListener: () => {},
    });
    const copy = await import("../src/client/ui/copy");
    expect(copy.say("common.copied")).toBe(copy.t("ja", "common.copied"));
    copy.applyWindowCopy("en");
    expect(copy.say("common.copied")).toBe(copy.t("en", "common.copied"));
    expect(copy.hasCopyPreference()).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    copy.setCopy({ lang: "zh" });
    copy.applyWindowCopy("en");
    expect(copy.say("common.copied")).toBe(copy.t("zh", "common.copied"));
    expect(copy.hasCopyPreference()).toBe(true);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("piik:ui-lang", "zh");
  });

  it.each(["zh-Hant", "ja", "ko"] as const)("persists and hands off %s", async (lang) => {
    vi.resetModules();
    const stored = new Map<string, string>([["piik:ui-lang", lang]]);
    const registry = await import("../src/client/locales");
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
    const { clientLaunchURL, takeClientLaunchBootstrap } = await import("../src/client/lib/app-launch");
    expect(copy.say("common.copied")).toBe(copy.t(lang, "common.copied"));
    expect(document.documentElement.lang).toBe(registry.locales[lang].tag);
    const presentation = { lang, theme: null };
    window.location.hash = new URL(clientLaunchURL("https://site.example/#piik-client=1", presentation)).hash;
    expect(takeClientLaunchBootstrap()).toEqual({ ...presentation, explicit: [] });
    expect(registry.consoleLanguage(lang)).toBe(lang === "zh-Hant" ? "zh" : "en");
    const keysBeforeSelection = [...stored.keys()];
    copy.setCopy({ lang });
    expect(stored.get("piik:ui-lang")).toBe(lang);
    expect([...stored.keys()]).toEqual(keysBeforeSelection);
  });

  it("say() follows the current language", () => {
    setCopy({ lang: "zh" });
    expect(say("common.copied")).toBe("已复制");
    setCopy({ lang: "en" });
    expect(say("common.copied")).toBe("Copied");
  });

  it("keeps title variations in the selected content catalog", () => {
    const zhHost = getTitleFrames("zh", "hostActive");
    const enViewer = getTitleFrames("en", "viewerActive");

    expect(zhHost.label).toBe("分享中");
    expect(zhHost.variations).toContain("小电视上工");
    expect(enViewer.label).toBe("Watching");
    expect(enViewer.variations).toContain("Popcorn ready");
    expect(getTitleFrames("zh", "hostIdle").variations).toContain("天线在打盹");
    expect(getTitleFrames("en", "viewerWaiting").variations).toContain(
      "Couch saved you a spot",
    );
  });

  it("keeps actionable titles fixed and lets playful pools vary independently", () => {
    const playful = new Set([
      "hostActive", "viewerActive", "hostStarting", "hostReady", "hostIdle", "viewerWaiting",
    ]);
    for (const catalog of Object.values(locales).map((locale) => locale.titleFrames)) {
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
