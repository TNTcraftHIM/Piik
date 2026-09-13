import { en, enTitleFrames } from "./en";
import { visualTitleFrames } from "./visual";
import { zh, zhTitleFrames } from "./zh";

export type { CopyKey, TitleFrameKey } from "./zh";

// One registration supplies the menu, browser-language matching and copy.
export const locales = {
  zh: { name: "简体中文", short: "中", tag: "zh-CN", copy: zh, titleFrames: zhTitleFrames },
  en: { name: "English", short: "EN", tag: "en", copy: en, titleFrames: enTitleFrames },
};
export type Lang = keyof typeof locales;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && Object.hasOwn(locales, value);
}

export function resolveLang(language?: string): Lang {
  const tag = language?.toLowerCase();
  const exact = (Object.keys(locales) as Lang[]).find((key) =>
    key.toLowerCase() === tag || locales[key].tag.toLowerCase() === tag);
  const base = tag?.split("-")[0];
  return exact ?? (isLang(base) ? base : "en");
}

// The App console currently translates these three presentations only.
export function consoleLanguage(lang: Lang, visual: boolean): "zh" | "en" | "vis" {
  return visual ? "vis" : lang === "zh" ? "zh" : "en";
}

export { visualTitleFrames };
