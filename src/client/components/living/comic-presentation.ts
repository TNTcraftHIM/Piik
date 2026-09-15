import type { CSSProperties } from "react";
import type { ComicKind, HintKind } from "../../ui/visual-kinds";

// Visual grammar only. Current status/operation owners may supply a more
// specific tone; a reused illustration must never override their evidence.
export type ComicTone = "off" | "busy" | "live" | "warn" | "bad";
export type ComicMotion = "demo" | "progress" | "still";
export type ComicPresentation = { tone: ComicTone; motion: ComicMotion };

const NEUTRAL: ComicPresentation = { tone: "off", motion: "demo" };
const LIMITED: ComicPresentation = { tone: "warn", motion: "still" };
const FAILED: ComicPresentation = { tone: "bad", motion: "still" };
const CONNECTING: ComicPresentation = { tone: "busy", motion: "progress" };
const RECOVERING: ComicPresentation = { tone: "warn", motion: "progress" };

const STATES: Record<ComicKind, ComicPresentation> = {
  "waiting-for-host": { tone: "off", motion: "still" },
  "connecting-p2p": CONNECTING,
  "connecting-sfu": CONNECTING,
  "signal-connecting": CONNECTING,
  "signal-recovering": RECOVERING,
  "signal-offline": { tone: "off", motion: "still" },
  "signal-connected": { tone: "live", motion: "still" },
  "transport-connected": { tone: "live", motion: "still" },
  "signal-failed": FAILED,
  "media-playing": { tone: "live", motion: "still" },
  "media-ready": { tone: "live", motion: "still" },
  "share-live": { tone: "live", motion: "still" },
  "share-ended": { tone: "off", motion: "still" },
  "room-closed": { tone: "off", motion: "still" },
  "room-code-invalid": FAILED,
  "page-refresh": NEUTRAL,
  "site-access": { tone: "off", motion: "still" },
  "source-switching": CONNECTING,
  "source-starting": CONNECTING,
  "preview-paused": LIMITED,
  "update-available": { tone: "off", motion: "still" },
  "debug-start": NEUTRAL,
  "debug-export-failed": FAILED,
  "copy-failed": FAILED,
  "source-failed": FAILED,
  "settings-failed": FAILED,
  "name-invalid": FAILED,
  "tap-to-play": { tone: "busy", motion: "demo" },
  "host-paused": LIMITED,
  recovering: RECOVERING,
  "route-failed": FAILED,
  "playback-failed": FAILED,
  "host-offline": FAILED,
  "no-audio": LIMITED,
  "room-not-found": FAILED,
  "access-denied": FAILED,
  "invalid-invite": FAILED,
  "room-full": FAILED,
  "bandwidth-limited": LIMITED,
  "encoder-limited": LIMITED,
  warning: LIMITED,
};

export const COMIC_KINDS = Object.keys(STATES) as ComicKind[];

const PRESENTATIONS: Partial<Record<ComicKind | HintKind, ComicPresentation>> = {
  ...STATES,
  "hint-admission-code": { tone: "off", motion: "still" },
  "hint-admission-password": { tone: "off", motion: "still" },
  "hint-admission-invite": { tone: "off", motion: "still" },
  "hint-route-p2p-required": LIMITED,
  "hint-nat-unavailable": LIMITED,
  "hint-volume-basic": LIMITED,
  "hint-no-audio": LIMITED,
  "hint-pip-unavailable": LIMITED,
  "hint-fullscreen-unavailable": LIMITED,
  "hint-share-audio-fixed": LIMITED,
  "hint-silent-share-fixed": LIMITED,
};

export function getComicPresentation(kind?: ComicKind | HintKind): ComicPresentation {
  return (kind && PRESENTATIONS[kind]) || NEUTRAL;
}

const COLOURS: Record<ComicTone, string> = {
  off: "var(--comic-neutral, var(--ink))",
  busy: "var(--action)",
  live: "var(--live)",
  warn: "var(--warn)",
  bad: "var(--danger)",
};

export function comicStyle(tone: ComicTone, motion: ComicMotion): CSSProperties {
  return {
    "--comic-tone": COLOURS[tone],
    "--comic-duration": "3.2s",
    // Explanations inherit the tooltip's loop; standalone results play once.
    "--comic-repeat": motion === "progress" ? "infinite" : undefined,
  } as CSSProperties;
}
