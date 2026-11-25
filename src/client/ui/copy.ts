// Locale selection and persistence. Catalog content lives in ../locales.
import { useSyncExternalStore } from "react";
import {
  locales,
  isLang,
  resolveLang,
  extraLanguages,
  type CopyKey,
  type Lang,
  type TitleFrameKey,
  type TitleContent,
} from "../locales";

export type { CopyKey, Lang, TitleFrameKey } from "../locales";

export const LANG_STORAGE_KEY = "piik:ui-lang";

interface CopyPrefs {
  lang: Lang;
}

export function readStoredCopy(): Partial<CopyPrefs> {
  try {
    const lang = window.localStorage.getItem(LANG_STORAGE_KEY);
    return {
      ...(isLang(lang) ? { lang } : {}),
    };
  } catch {
    return {};
  }
}

const stored = readStoredCopy();
let explicit = Object.keys(stored).length > 0;
let windowCopy: "following" | "chosen" | undefined;
const state: CopyPrefs = {
  lang: resolveLang(typeof navigator === "undefined" ? undefined : navigator.language),
  ...stored,
};
let pinnedLanguage: Lang | null = extraLanguages.includes(state.lang) ? state.lang : null;

function syncDocumentLanguage(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locales[state.lang].tag;
  }
}

syncDocumentLanguage();

const listeners = new Set<() => void>();

// Applies values without persisting (storage-event sync path); commit() is
// the persisting variant for local user actions.
function apply(next: Partial<CopyPrefs>): void {
  if (next.lang) {
    state.lang = next.lang;
    if (extraLanguages.includes(next.lang)) pinnedLanguage = next.lang;
  }
  syncDocumentLanguage();
  listeners.forEach((listener) => listener());
}

function commit(next: Partial<CopyPrefs>): void {
  explicit = true;
  windowCopy = "chosen";
  apply(next);
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, state.lang);
  } catch {
    // Restricted storage only disables persistence.
  }
}

// Cross-tab sync: a commit in another tab re-applies the persisted values
// here. Identical-value writes fire no storage event, so tabs converge
// without re-notify loops.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === LANG_STORAGE_KEY && windowCopy !== "following") {
      const stored = readStoredCopy();
      explicit = Object.keys(stored).length > 0;
      apply(stored);
    }
  });
}

// Non-React setter for local choices and product previews.
export const setCopy = commit;

/** The native utility window follows the main window until a local choice. */
export function applyWindowCopy(lang: Lang): void {
  if (windowCopy === "chosen") return;
  windowCopy = "following";
  apply({ lang });
}

export function hasCopyPreference(): boolean {
  return explicit && windowCopy !== "following";
}

// Explicit launcher choices replace and persist the destination preference.
// System defaults only fill an unset preference, without being saved.
export function applyLaunchCopy(next: Partial<CopyPrefs>, explicitChoice: boolean): void {
  if (explicitChoice) commit(next);
  else if (!explicit) apply(next);
}

export function isCopyKey(value: string): value is CopyKey {
  return Object.hasOwn(locales.zh.copy, value);
}

export function t(lang: Lang, key: CopyKey, vars?: Record<string, string>): string {
  const catalog: Partial<Record<CopyKey, string>> = locales[lang].copy;
  let value = catalog[key] ?? locales.en.copy[key];
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replace(`{${name}}`, () => replacement);
    }
  }
  return value;
}

export function getTitleFrames(
  lang: Lang,
  key: TitleFrameKey,
): TitleContent {
  return locales[lang].titleFrames[key] ?? locales.en.titleFrames[key];
}

// Non-hook accessor for transient notices composed outside React render
// (pages keep resolved strings in state; a language switch leaves an already
// shown notice in its original language until replaced).
export function say(key: CopyKey, vars?: Record<string, string>): string {
  return t(state.lang, key, vars);
}

// Locale-aware joins for composed notices.
export function joinSentences(lang: Lang, parts: string[]): string {
  return parts.join(lang === "zh" || lang === "zh-Hant" ? "；" : "; ");
}
export function joinItems(lang: Lang, parts: string[]): string {
  return parts.join(lang === "zh" || lang === "zh-Hant" || lang === "ja" ? "、" : ", ");
}

export interface Copy {
  lang: Lang;
  pinnedLanguage: Lang | null;
  t: (key: CopyKey, vars?: Record<string, string>) => string;
  titleFrames: (key: TitleFrameKey) => TitleContent;
  setLang: (lang: Lang) => void;
}

export function useCopy(): Copy {
  const snapshot = () => state.lang;
  const lang = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    snapshot,
  );
  return {
    lang,
    pinnedLanguage,
    t: (key, vars) => t(lang, key, vars),
    titleFrames: (key) => getTitleFrames(lang, key),
    setLang: (next) => commit({ lang: next }),
  };
}
