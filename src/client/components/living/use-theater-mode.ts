import { useEffect, useState } from "react";

/** The stage owns theater presentation; room membership and drafts stay mounted. */
export function useTheaterMode() {
  const [theaterMode, setTheaterMode] = useState(false);
  useEffect(() => {
    if (!theaterMode) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      // A nonmodal popover can remain open after Tab moves focus outside it;
      // native Escape must dismiss that surface before leaving theater mode.
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing &&
        !document.querySelector('[popover="auto"]:popover-open')) setTheaterMode(false);
    };
    document.body.classList.add("lr-theater-open");
    window.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.classList.remove("lr-theater-open");
      window.removeEventListener("keydown", exitOnEscape);
    };
  }, [theaterMode]);
  return [theaterMode, setTheaterMode] as const;
}
