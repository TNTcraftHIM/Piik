import { useLayoutEffect } from "react";

/** One preview choice drives both control motion and the existing comic poses. */
export function usePreviewReducedMotion(reduced: boolean) {
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-reduced-motion", reduced);
    return () => document.documentElement.removeAttribute("data-reduced-motion");
  }, [reduced]);
}
