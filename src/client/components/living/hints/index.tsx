// Control hint scenes (操作提示漫画): small 2-panel before→after idioms used
// as hover/focus tooltips on controls in pure-visual mode, where no human
// language may appear. Same cast, palette, 320x96 canvas, and motion
// constitution as the state comics. Sets live in set1..set4.tsx;
// each must define exactly its SetNKind keys — the merge below then proves
// completeness at compile time. JSX-free shell: this module is also loaded
// by the tsx preview harness, which uses the classic JSX runtime.

import { createElement, memo, type CSSProperties, type ReactNode } from "react";
import type { ComicTheme } from "../Comic";
import { SET1_SCENES } from "./set1";
import { SET2_SCENES } from "./set2";
import { SET3_SCENES } from "./set3";
import { SET4_SCENES } from "./set4";

export type Set1Kind =
  | "hint-share-start"
  | "hint-share-stop"
  | "hint-pause"
  | "hint-resume"
  | "hint-switch-source"
  | "hint-reconnect";

export type Set2Kind =
  | "hint-copy-code"
  | "hint-shuffle-code"
  | "hint-copy-invite"
  | "hint-rotate-invite"
  | "hint-revoke-invite"
  | "hint-policy-open"
  | "hint-policy-private"
  | "hint-password";

export type Set3Kind =
  | "hint-quality"
  | "hint-audio-quality"
  | "hint-degrade-pref"
  | "hint-codec"
  | "hint-advanced"
  | "hint-details"
  | "hint-more-metrics";

export type Set4Kind =
  | "hint-topology"
  | "hint-close"
  | "hint-admit"
  | "hint-deny"
  | "hint-rename"
  | "hint-theme"
  | "hint-join-go"
  | "hint-theater"
  | "hint-theater-exit"
  | "hint-route-p2p"
  | "hint-route-sfu";

export type HintKind = Set1Kind | Set2Kind | Set3Kind | Set4Kind;

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
  "hint-more-metrics",
  "hint-topology",
  "hint-close",
  "hint-admit",
  "hint-deny",
  "hint-rename",
  "hint-theme",
  "hint-join-go",
  "hint-theater",
  "hint-theater-exit",
  "hint-route-p2p",
  "hint-route-sfu",
];

export type HintScene = (props: { theme: ComicTheme }) => ReactNode;

export const HINT_SCENES: Record<HintKind, HintScene> = {
  ...SET1_SCENES,
  ...SET2_SCENES,
  ...SET3_SCENES,
  ...SET4_SCENES,
};

const HINT_KIND_SET: ReadonlySet<string> = new Set(HINT_KINDS);

export function isHintKind(kind: string): kind is HintKind {
  return HINT_KIND_SET.has(kind);
}

/** All hint scenes are paper idioms: they float on a paper tooltip. */
export const HintComic = memo(function HintComic({
  kind,
  size,
}: {
  kind: HintKind;
  size?: number;
}) {
  const style: CSSProperties = {
    width: size != null ? `${size}px` : "min(320px, 86%)",
    height: "auto",
    display: "block",
  };
  return createElement(
    "svg",
    {
      viewBox: "0 0 320 96",
      style,
      "aria-hidden": true,
      focusable: false,
      xmlns: "http://www.w3.org/2000/svg",
    },
    HINT_SCENES[kind]({ theme: "paper" }),
  );
});
