// Locale selection and persistence. Catalog content lives in ../locales.
import { useSyncExternalStore } from "react";
import {
  catalogs,
  titleFrameCatalogs,
  visualTitleFrames,
  type CopyKey,
  type Lang,
  type TitleFrameKey,
} from "../locales";

export type { CopyKey, Lang, TitleFrameKey } from "../locales";
export type CopyMode = "text" | "vis";

const LANG_STORAGE_KEY = "piik:ui-lang";
const MODE_STORAGE_KEY = "piik:ui-mode";

interface CopyPrefs {
  lang: Lang;
  vis: boolean;
}

function readStored(): Partial<CopyPrefs> {
  try {
    const lang = window.localStorage.getItem(LANG_STORAGE_KEY);
    const mode = window.localStorage.getItem(MODE_STORAGE_KEY);
    return {
      ...(lang === "zh" || lang === "en" ? { lang } : {}),
      ...(mode === "text" || mode === "vis" ? { vis: mode === "vis" } : {}),
    };
  } catch {
    return {};
  }
}

function detectLang(): Lang {
  const language = typeof navigator === "undefined"
    ? undefined
    : navigator.language?.split("-")[0]?.toLowerCase();
  return language === "zh" ? "zh" : "en";
}

const state: CopyPrefs = {
  lang: detectLang(),
  vis: false,
  ...readStored(),
};

function syncDocumentLanguage(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  }
}

syncDocumentLanguage();

const listeners = new Set<() => void>();

// Applies values without persisting (storage-event sync path); commit() is
// the persisting variant for local user actions.
function apply(next: Partial<CopyPrefs>): void {
  if (next.lang) state.lang = next.lang;
  if (next.vis !== undefined) state.vis = next.vis;
  syncDocumentLanguage();
  listeners.forEach((listener) => listener());
}

function commit(next: Partial<CopyPrefs>): void {
  apply(next);
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, state.lang);
    window.localStorage.setItem(MODE_STORAGE_KEY, state.vis ? "vis" : "text");
  } catch {
    // Restricted storage only disables persistence.
  }
}

// Cross-tab sync: a commit in another tab re-applies the persisted values
// here. Identical-value writes fire no storage event, so tabs converge
// without re-notify loops.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === LANG_STORAGE_KEY || event.key === MODE_STORAGE_KEY) {
      apply(readStored());
    }
  });
}

// Non-React setter (used by the mode pill and by tests).
export const setCopy = commit;

export function isCopyKey(value: string): value is CopyKey {
  return Object.prototype.hasOwnProperty.call(catalogs.zh, value);
}

export function t(lang: Lang, key: CopyKey, vars?: Record<string, string>): string {
  let value = catalogs[lang][key];
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replace(`{${name}}`, () => replacement);
    }
  }
  return value;
}

export function getTitleFrames(
  lang: Lang,
  visual: boolean,
  key: TitleFrameKey,
): readonly string[] {
  return visual ? visualTitleFrames[key] : titleFrameCatalogs[lang][key];
}

// Non-hook accessor for transient notices composed outside React render
// (pages keep resolved strings in state; a language switch leaves an already
// shown notice in its original language until replaced).
export function say(key: CopyKey, vars?: Record<string, string>): string {
  return t(state.lang, key, vars);
}

// The selected language for composers that run outside React render (say()).
export function currentLang(): Lang {
  return state.lang;
}

// Locale-aware joins for composed notices.
export function joinSentences(lang: Lang, parts: string[]): string {
  return parts.join(lang === "zh" ? "；" : "; ");
}
export function joinItems(lang: Lang, parts: string[]): string {
  return parts.join(lang === "zh" ? "、" : ", ");
}

export interface Copy {
  lang: Lang;
  vis: boolean;
  t: (key: CopyKey, vars?: Record<string, string>) => string;
  titleFrames: (key: TitleFrameKey) => readonly string[];
  setLang: (lang: Lang) => void;
  setVis: (vis: boolean) => void;
}

export function useCopy(): Copy {
  const snapshot = () => `${state.lang}:${state.vis}`;
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    snapshot,
  );
  const [lang, vis] = current.split(":") as [Lang, string];
  const visual = vis === "true";
  return {
    lang,
    vis: visual,
    t: (key, vars) => t(lang, key, vars),
    titleFrames: (key) => getTitleFrames(lang, visual, key),
    setLang: (next) => commit({ lang: next, vis: false }),
    setVis: (next) => commit({ vis: next }),
  };
}
