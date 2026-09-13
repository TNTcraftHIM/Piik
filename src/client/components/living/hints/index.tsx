// Control hint scenes (操作提示漫画): small 2-panel before→after idioms used
// as hover/focus tooltips in every mode, with captions added by Tooltip.
// Same cast, palette, 320x96 canvas, and motion
// constitution as the state comics. Sets live in set1..set4.tsx;
// each must define exactly its SetNKind keys — the merge below then proves
// completeness at compile time. JSX-free shell: this module is also loaded
// by the tsx preview harness, which uses the classic JSX runtime.

import { createElement, memo, type CSSProperties } from "react";
import type { HintKind, HintScene } from "../../../ui/visual-kinds";
import { SET1_SCENES } from "./set1";
import { SET2_SCENES } from "./set2";
import { SET3_SCENES } from "./set3";
import { SET4_SCENES } from "./set4";
import { PLAYBACK_SCENES } from "./playback";
import { CONTROL_SCENES } from "./controls";
import { comicStyle, getComicPresentation, type ComicTone, type ComicMotion } from "../comic-presentation";

export type { HintKind, HintScene };

export const HINT_KINDS: readonly HintKind[] = [
  "hint-share-start",
  "hint-share-stop",
  "hint-pause",
  "hint-resume",
  "hint-switch-source",
  "hint-reconnect",
  "hint-copy-code",
  "hint-shuffle-code",
  "hint-copy-invite",
  "hint-client-link",
  "hint-rotate-invite",
  "hint-revoke-invite",
  "hint-policy-open",
  "hint-policy-private",
  "hint-password",
  "hint-quality",
  "hint-audio-quality",
  "hint-degrade-pref",
  "hint-codec",
  "hint-advanced",
  "hint-details",
  "hint-debug-export",
  "hint-more-metrics",
  "hint-topology",
  "hint-close",
  "hint-rename",
  "hint-theme-light",
  "hint-theme-dark",
  "hint-collapse",
  "hint-password-show",
  "hint-password-hide",
  "hint-share-audio",
  "hint-stop-audio",
  "hint-share-audio-fixed",
  "hint-silent-share-fixed",
  "hint-join-go",
  "hint-theater",
  "hint-theater-exit",
  "hint-route-p2p",
  "hint-route-p2p-required",
  "hint-route-sfu",
  "hint-nat-prediction",
  "hint-nat-unavailable",
  "hint-client-local",
  "hint-client-site",
  "hint-capture-browser",
  "hint-capture-window",
  "hint-capture-display",
  "hint-local-play",
  "hint-local-pause",
  "hint-volume",
  "hint-volume-basic",
  "hint-mute",
  "hint-unmute",
  "hint-no-audio",
  "hint-fullscreen",
  "hint-fullscreen-exit",
  "hint-fullscreen-unavailable",
  "hint-pip",
  "hint-pip-exit",
  "hint-pip-unavailable",
];

export const HINT_SCENES: Record<HintKind, HintScene> = {
  ...SET1_SCENES,
  ...SET2_SCENES,
  ...SET3_SCENES,
  ...SET4_SCENES,
  ...PLAYBACK_SCENES,
  ...CONTROL_SCENES,
};

const HINT_KIND_SET: ReadonlySet<string> = new Set(HINT_KINDS);

export function isHintKind(kind: string): kind is HintKind {
  return HINT_KIND_SET.has(kind);
}

/** All hint scenes are paper idioms: they float on a paper tooltip. */
export const HintComic = memo(function HintComic({
  kind,
  size,
  tone,
  motion,
}: {
  kind: HintKind;
  size?: number;
  tone?: ComicTone;
  motion?: ComicMotion;
}) {
  const defaults = getComicPresentation(kind);
  const resolvedTone = tone ?? defaults.tone;
  const resolvedMotion = motion ?? defaults.motion;
  const style: CSSProperties = {
    ...comicStyle(resolvedTone, resolvedMotion),
    width: size != null ? `${size}px` : "min(320px, 86%)",
    height: "auto",
    display: "block",
  };
  return createElement(
    "svg",
    {
      viewBox: "0 0 320 96",
      "data-comic-tone": resolvedTone,
      "data-comic-motion": resolvedMotion,
      style,
      "aria-hidden": true,
      focusable: false,
      xmlns: "http://www.w3.org/2000/svg",
    },
    HINT_SCENES[kind]({ theme: "paper" }),
  );
});
