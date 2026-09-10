import { useEffect } from "react";

const BRAND_TITLE = "Piik";
const TITLE_VARIATION_INTERVAL_MS = 15_000;

export function composeDocumentTitle(
  ...parts: Array<string | null | undefined>
): string {
  const detail = parts.filter((part): part is string => Boolean(part));
  return detail.length > 0
    ? `${BRAND_TITLE} | ${detail.join(" · ")}`
    : BRAND_TITLE;
}

export function useDocumentTitle(
  parts: Array<string | null | undefined>,
  variations: readonly string[] = [],
): void {
  const title = composeDocumentTitle(...parts);
  const variationKey = variations.join("\u001f");
  useEffect(() => {
    document.title = title;
    const currentPart = parts.at(-1);
    const frames = currentPart ? [currentPart, ...variations] : [];
    if (
      frames.length < 2 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return () => {
        document.title = BRAND_TITLE;
      };
    }

    const prefix = parts.slice(0, -1);
    let frameIndex = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      frameIndex =
        frameIndex === 0
          ? 1 + Math.floor(Math.random() * (frames.length - 1))
          : 0;
      document.title = composeDocumentTitle(...prefix, frames[frameIndex]);
    }, TITLE_VARIATION_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      document.title = BRAND_TITLE;
    };
  }, [title, variationKey]);
}
