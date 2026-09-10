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
  "hint-route-p2p-required": LIMITED,
  "hint-nat-unavailable": LIMITED,
  "hint-volume-basic": LIMITED,
  "hint-no-audio": LIMITED,
  "hint-pip-unavailable": LIMITED,
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
    "--comic-repeat": motion === "progress" ? "infinite" : "1",
  } as CSSProperties;
}
