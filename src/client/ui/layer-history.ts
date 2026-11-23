import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import { useSurfaceDocument } from "./panel-window";

type TrackLayer = (element: HTMLElement) => () => void;
export const LayerHistory = createContext<TrackLayer | null>(null);

/** The containing page owns Back. The native popover or dialog owns visibility. */
export function useLayerHistory(ref: RefObject<HTMLElement | null>, open: boolean) {
  const surface = useSurfaceDocument();
  const track = useContext(LayerHistory);
  useLayoutEffect(() => {
    if (open && ref.current?.ownerDocument === document) return track?.(ref.current);
  }, [track, ref, open, surface]);
}
