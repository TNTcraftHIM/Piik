import { useEffect } from "react";
import { useRotatingText } from "./use-text-rotation";

const BRAND_TITLE = "Piik";

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
  variations: readonly string[],
  context: string,
  still = false,
): string {
  const decoration = useRotatingText(variations, context, undefined, still);
  const title = composeDocumentTitle(...parts, decoration);
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = BRAND_TITLE;
    };
  }, [title]);
  return title;
}
