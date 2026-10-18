import { useLayoutEffect } from "react";

export function usePreviewAnchor() {
  useLayoutEffect(() => {
    // Native fragment navigation runs before a lazy preview has mounted.
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, []);
}
