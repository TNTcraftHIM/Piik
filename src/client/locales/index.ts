import { en, enPlayful, enTitleFrames } from "./en";
import { visualTitleFrames } from "./visual";
import { zh, zhPlayful, zhTitleFrames } from "./zh";
import { zhHant } from "./zh-Hant";
import { ja } from "./ja";
import { ko } from "./ko";

export type { CopyKey, TitleContent, TitleFrameKey, WelcomeEntry } from "./zh";

// One registration supplies the menu, browser-language matching and copy.
export const locales = {
  zh: { name: "简体中文", short: "中", tag: "zh-CN", copy: zh, titleFrames: zhTitleFrames, playful: zhPlayful },
  en: { name: "English", short: "EN", tag: "en", copy: en, titleFrames: enTitleFrames, playful: enPlayful },
  // Partial message catalogs retain the existing English title and playful defaults.
  "zh-Hant": { name: "繁體中文", short: "繁", tag: "zh-Hant", copy: zhHant, titleFrames: enTitleFrames, playful: enPlayful },
  ja: { name: "日本語", short: "日", tag: "ja", copy: ja, titleFrames: enTitleFrames, playful: enPlayful },
  ko: { name: "한국어", short: "한", tag: "ko", copy: ko, titleFrames: enTitleFrames, playful: enPlayful },
};
export type Lang = keyof typeof locales;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && Object.hasOwn(locales, value);
}

export function resolveLang(language?: string): Lang {
  if (!language) return "en";
  try {
    const requested = new Intl.Locale(language);
    const keys = Object.keys(locales) as Lang[];
    const exact = keys.find((key) => key.toLowerCase() === requested.baseName.toLowerCase()
      || locales[key].tag.toLowerCase() === requested.baseName.toLowerCase());
    if (exact) return exact;
    const candidates = keys.filter((key) => new Intl.Locale(locales[key].tag).language === requested.language);
    const script = requested.maximize().script;
    return candidates.find((key) => new Intl.Locale(locales[key].tag).maximize().script === script)
      ?? candidates[0] ?? "en";
  } catch {
    return "en";
  }
}

// The App console currently translates these three presentations only.
export function consoleLanguage(lang: Lang, visual: boolean): "zh" | "en" | "vis" {
  return visual ? "vis" : lang === "zh" ? "zh" : "en";
}

export { visualTitleFrames };
