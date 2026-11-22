import { createContext } from "react";

export type OverlayMode = "panel" | "pinned" | "editing";
export const VoiceOverlay = createContext<{
  target: HTMLElement | null;
  mode: OverlayMode;
  show(): void;
  edit(): void;
  close(): void;
} | null>(null);

declare global {
  interface Window {
    piikVoiceOverlay?: boolean;
    piikSetVoiceOverlay?: (mode: OverlayMode) => boolean;
  }
}
