import { useEffect, useState } from "react";
import type { Lang } from "../ui/copy";

const WEBSITE = "https://piik.tv";
let availability: Promise<boolean> | undefined;

/** Optional help/download navigation only; never gates App or room startup. */
export function projectWebsiteAvailable(): Promise<boolean> {
  return availability ??= (async () => {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(WEBSITE + "/", {
        method: "HEAD", credentials: "omit", referrerPolicy: "no-referrer",
        cache: "no-store", signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      globalThis.clearTimeout(timer);
    }
  })();
}

export function useProjectLink(path: string, fallback: string, enabled = true): string {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void projectWebsiteAvailable().then(result => { if (current) setAvailable(result); });
    return () => { current = false; };
  }, [enabled]);
  // A click before the optional probe finishes still has a working destination.
  return available ? WEBSITE + path : fallback;
}

export type GuideAnchors = { en: string; zh: string };

export function guidePaths(lang: Lang, article: string, anchors?: GuideAnchors) {
  const chinese = lang === "zh" || lang === "zh-Hant";
  const fragment = anchors ? `#${chinese ? anchors.zh : anchors.en}` : "";
  return {
    path: `/docs/${chinese ? "zh/" : ""}${article}.html${fragment}`,
    fallback: `https://github.com/TNTcraftHIM/Piik/blob/main/docs/guide/${article}${chinese ? ".zh-CN" : ""}.md${fragment}`,
  };
}

export function useGuideLink(lang: Lang, article: string, enabled = true, anchors?: GuideAnchors): string {
  const { path, fallback } = guidePaths(lang, article, anchors);
  return useProjectLink(path, fallback, enabled);
}
