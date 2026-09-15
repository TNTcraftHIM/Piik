import { useEffect } from "react";
import { createTextCycle, startTextRotation } from "./text-rotation";

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
    if (!currentPart || variations.length === 0) {
      return () => {
        document.title = BRAND_TITLE;
      };
    }

    const prefix = parts.slice(0, -1);
    const next = createTextCycle(variations);
    let ordinary = true;
    const stop = startTextRotation(() => {
      ordinary = !ordinary;
      document.title = ordinary ? title : composeDocumentTitle(...prefix, next());
    }, TITLE_VARIATION_INTERVAL_MS);

    return () => {
      stop();
      document.title = BRAND_TITLE;
    };
  }, [title, variationKey]);
}
