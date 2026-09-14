// Hand-drawn flat icon set for the living-room UI. Stroke icons use
// currentColor; solid icons (play/pause/stop) are filled. Bodies are real JSX
// children (never dangerouslySetInnerHTML — React re-sets innerHTML on every
// render pass, which would restart the draw-in animation on unrelated state
// changes; reconciled children stay put, so the draw only replays on a true
// icon swap). pathLength={1} on every shape paces the draw-in evenly.
// Meanings are shared across controls, comics and text placeholders; see
// docs/design/visual-language.md#symbol-reference before adding a symbol.
import { useEffect, useRef, type ReactNode } from "react";
import { bindSvgReplayOnPointerEnter } from "./animation";

const PATHS = {
  couch: { body: (<><path pathLength={1} d="M5 12V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v4M6 19v2m12-2v2"/><path pathLength={1} d="M5 15h14v-3a2 2 0 0 1 4 0v5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-5a2 2 0 0 1 4 0Z"/></>) },
  gamepad: { body: (<><path pathLength={1} d="M8 7h8c3 0 4 2 5 6l1 5c.3 2-2 3-3.5 1.5L16 17H8l-2.5 2.5C4 21 1.7 20 2 18l1-5c1-4 2-6 5-6Z"/><path pathLength={1} d="M6 12h4m-2-2v4m8-3h.01M18 14h.01"/></>) },
  save: { body: (<><path pathLength={1} d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path pathLength={1} d="M7 3v6h9V3M7 21v-7h10v7"/></>) },
  popcorn: { body: (<><path pathLength={1} d="M5 9c-3-3 0-6 3-5 0-4 6-4 7-1 4-1 7 3 4 6M5 9h14l-2 12H7Z"/><path pathLength={1} d="m9 12 1 6m5-6-1 6"/></>) },
  clapperboard: { body: (<><path pathLength={1} d="m3 9-1-5 19-3 1 5ZM3 10h19v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path pathLength={1} d="m7 3 3 4m4-5 3 4"/></>) },
  trophy: { body: (<><path pathLength={1} d="M7 3h10v6a5 5 0 0 1-10 0ZM7 5H3v3a4 4 0 0 0 5 4m9-7h4v3a4 4 0 0 1-5 4M12 14v6m-5 1h10"/></>) },
  gift: { body: (<><rect pathLength={1} x="3" y="8" width="18" height="5" rx="1"/><path pathLength={1} d="M5 13v8h14v-8M12 8v13m0-13C5 8 4 3 7 3c3 0 5 5 5 5s2-5 5-5c3 0 2 5-5 5Z"/></>) },
  flag: { body: (<><path pathLength={1} d="M5 22V3h14l-4 5 4 5H5"/></>) },
  heart: { body: (<><path pathLength={1} d="M12 21 3.6 12.6C-2 7 5.5.5 12 7 18.5.5 26 7 20.4 12.6Z"/></>) },
  bulb: { body: (<><path pathLength={1} d="M8 17v-2c-6-5-3-13 4-13s10 8 4 13v2ZM9 21h6m-3-4v-7m-3 0 3 3 3-3"/></>) },
  copy: { body: (<><rect pathLength={1} x="9" y="9" width="12" height="12" rx="2"/><path pathLength={1} d="M5 15V5a2 2 0 0 1 2-2h10"/></>) },
  check: { body: (<><path pathLength={1} d="M4 12.5 9.5 18 20 6.5"/></>) },
  refresh: { body: (<><path pathLength={1} d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7L21 8"/><path pathLength={1} d="M21 3v5h-5"/><path pathLength={1} d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7L3 16"/><path pathLength={1} d="M8 16H3v5"/></>) },
  x: { body: (<><path pathLength={1} d="M18 6 6 18M6 6l12 12"/></>) },
  eye: { body: (<><path pathLength={1} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle pathLength={1} cx="12" cy="12" r="3"/></>) },
  eyeOff: { body: (<><path pathLength={1} d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.74 9.74 0 0 0 5.39-1.61"/><path pathLength={1} d="m2 2 20 20"/><path pathLength={1} d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/></>) },
  play: { solid: true, body: (<><path pathLength={1} d="M7 4.8v14.4a1 1 0 0 0 1.52.86l11.4-7.2a1 1 0 0 0 0-1.72L8.52 3.94A1 1 0 0 0 7 4.8Z"/></>) },
  pause: { solid: true, body: (<><rect pathLength={1} x="6" y="4" width="4.2" height="16" rx="1.2"/><rect pathLength={1} x="13.8" y="4" width="4.2" height="16" rx="1.2"/></>) },
  stop: { solid: true, body: (<><rect pathLength={1} x="6" y="6" width="12" height="12" rx="2"/></>) },
  share: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="13" rx="2"/><path pathLength={1} d="M12 17v-7m0 0-3 3m3-3 3 3"/><path pathLength={1} d="M8 21h8"/></>) },
  switchSource: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="14" rx="2"/><path pathLength={1} d="M7 9h9m0 0-2.5-2.5M16 9l-2.5 2.5M17 13H8m0 0 2.5-2.5M8 13l2.5 2.5"/><path pathLength={1} d="M8 22h8M12 18v4"/></>) },
  users: { body: (<><circle pathLength={1} cx="9" cy="8" r="3.5"/><path pathLength={1} d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle pathLength={1} cx="17" cy="9" r="2.5"/><path pathLength={1} d="M16.2 15.2c2.5.4 4.6 1.8 5.3 4.8"/></>) },
  network: { body: (<><rect pathLength={1} x="9" y="2" width="6" height="6" rx="1.5"/><rect pathLength={1} x="2" y="16" width="6" height="6" rx="1.5"/><rect pathLength={1} x="16" y="16" width="6" height="6" rx="1.5"/><path pathLength={1} d="M12 8v3.5M12 11.5 5.5 16M12 11.5l6.5 4.5"/></>) },
  chevron: { body: (<><path pathLength={1} d="m6 9 6 6 6-6"/></>) },
  loader: { body: (<><path pathLength={1} d="M21 12a9 9 0 1 1-6.22-8.56"/></>) },
  alert: { body: (<><path pathLength={1} d="M12 3.5 2.8 19.5a1 1 0 0 0 .87 1.5h16.66a1 1 0 0 0 .87-1.5L12 3.5Z"/><path pathLength={1} d="M12 10v4.5"/><path pathLength={1} d="M12 17.8h.01"/></>) },
  wifiOff: { body: (<><path pathLength={1} d="m2 2 20 20"/><path pathLength={1} d="M8.5 16.5a5 5 0 0 1 7 0"/><path pathLength={1} d="M5 12.9a11 11 0 0 1 3.1-2.2M15.9 11.4a11 11 0 0 1 3.1 1.5"/><path pathLength={1} d="M1.5 8.8A16 16 0 0 1 8 5.4m8 .2a16 16 0 0 1 6.5 3.2"/><path pathLength={1} d="M12 20h.01"/></>) },
  moon: { body: (<><path pathLength={1} d="M20.2 14.2A8.5 8.5 0 1 1 9.8 3.8a7 7 0 1 0 10.4 10.4Z"/></>) },
  pencil: { body: (<><path pathLength={1} d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z"/></>) },
  link: { body: (<><path pathLength={1} d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path pathLength={1} d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>) },
  linkOff: { body: (<><path pathLength={1} d="M10 13a5 5 0 0 0 7.54.54l1.1-1.1M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><path pathLength={1} d="m3 3 18 18"/></>) },
  arrowRight: { body: (<><path pathLength={1} d="M4 12h16m-6.5-6.5L20 12l-6.5 6.5"/></>) },
  arrowUp: { body: (<><path pathLength={1} d="M12 20V4m-6.5 6.5L12 4l6.5 6.5"/></>) },
  arrowDown: { body: (<><path pathLength={1} d="M12 4v16m-6.5-6.5L12 20l6.5-6.5"/></>) },
  key: { body: (<><circle pathLength={1} cx="7.5" cy="15.5" r="4.5"/><path pathLength={1} d="m11 12.5 9.5-9.5M14.5 6l3 3M17.5 3l3 3"/></>) },
  globe: { body: (<><circle pathLength={1} cx="12" cy="12" r="9"/><path pathLength={1} d="M3 12h18"/><path pathLength={1} d="M12 3c2.5 2.6 3.9 5.6 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.6-3.9-9S9.5 5.6 12 3Z"/></>) },
  lock: { body: (<><rect pathLength={1} x="4" y="11" width="16" height="10" rx="2"/><path pathLength={1} d="M8 11V7a4 4 0 0 1 8 0v4"/></>) },
  signal: { body: (<><path pathLength={1} d="M2 9a15 15 0 0 1 20 0"/><path pathLength={1} d="M5 12.5a10 10 0 0 1 14 0"/><path pathLength={1} d="M8.5 16a5 5 0 0 1 7 0"/><path pathLength={1} d="M12 19.5h.01"/></>) },
  server: { body: (<><rect pathLength={1} x="3" y="4" width="18" height="7" rx="2"/><rect pathLength={1} x="3" y="13" width="18" height="7" rx="2"/><path pathLength={1} d="M7 7.5h.01M7 16.5h.01"/></>) },
  tv: { body: (<><rect pathLength={1} x="2" y="5" width="20" height="14" rx="2"/><path pathLength={1} d="M8 2l4 3 4-3"/></>) },
  door: { body: (<><path pathLength={1} d="M4 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16"/><path pathLength={1} d="M2 21h20"/><path pathLength={1} d="M12.5 12h.01"/></>) },
  gauge: { body: (<><path pathLength={1} d="M4 14.5a8 8 0 1 1 16 0"/><path pathLength={1} d="m12 14 3.5-4"/><path pathLength={1} d="M3.5 17.5h17"/></>) },
  expand: { body: (<><path pathLength={1} d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></>) },
  contract: { body: (<><path pathLength={1} d="M8 3v5H3m13-5v5h5M8 21v-5H3m13 5v-5h5"/></>) },
  pip: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="16" rx="2"/><rect pathLength={1} x="12" y="12" width="7" height="5" rx="1"/><path pathLength={1} d="m6 8 3 3M6 11h3V8"/></>) },
  pipExit: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="16" rx="2"/><rect pathLength={1} x="12" y="12" width="7" height="5" rx="1"/><path pathLength={1} d="m9 11-3-3m0 3V8h3"/></>) },
  window: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="16" rx="2"/><path pathLength={1} d="M2 9h20M6 6.5h.01M9 6.5h.01"/></>) },
  display: { body: (<><rect pathLength={1} x="2" y="3" width="20" height="14" rx="2"/><path pathLength={1} d="M12 17v4m-4 0h8"/></>) },
  frames: { body: (<><rect pathLength={1} x="8" y="8" width="13" height="12" rx="2"/><path pathLength={1} d="M16 4H5a2 2 0 0 0-2 2v10M12 11l5 3-5 3Z"/></>) },
  jitter: { body: (<><path pathLength={1} d="M2 18h20M4 8v6m4-9v9m7-5v5m5-10v10"/></>) },
  packetLoss: { body: (<><rect pathLength={1} x="2" y="8" width="5" height="6" rx="1"/><rect pathLength={1} x="17" y="8" width="5" height="6" rx="1"/><path pathLength={1} d="m10 8 4 6m0-6-4 6M12 17v5m-2-2 2 2 2-2"/></>) },
  frameDrop: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="15" rx="2"/><path pathLength={1} d="m8 8 8 7m0-7-8 7"/></>) },
  audioRepair: { body: (<><path pathLength={1} d="M2 10v4h3l4 4V6l-4 4H2ZM12 12h2l2-5 3 10 2-5h1"/></>) },
  puzzle: { body: (<><path pathLength={1} d="M4 3h5a3 3 0 1 0 6 0h5v6a3 3 0 1 0 0 6v6h-6a3 3 0 1 0-6 0H4v-6a3 3 0 1 0 0-6Z"/></>) },
  speakerOff: { body: (<><path pathLength={1} d="M4 9v6h4l5 4V5L8 9H4Z"/><path pathLength={1} d="m17 9 5 6m0-6-5 6"/></>) },
  theater: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="16" rx="2"/><path pathLength={1} d="M2 8h20M2 16h20"/></>) },
  theaterExit: { body: (<><rect pathLength={1} x="2" y="4" width="20" height="16" rx="2"/><rect pathLength={1} x="6" y="8" width="12" height="8" rx="1"/></>) },
  speaker: { body: (<><path pathLength={1} d="M4 9v6h4l5 4V5L8 9H4Z"/><path pathLength={1} d="M16 9a4.2 4.2 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></>) },
  sliders: { body: (<><path pathLength={1} d="M3 6h9m4 0h5M3 12h3m4 0h11M3 18h12m4 0h2"/><circle pathLength={1} cx="14" cy="6" r="2"/><circle pathLength={1} cx="8" cy="12" r="2"/><circle pathLength={1} cx="17" cy="18" r="2"/></>) },
  mountain: { body: (<><path pathLength={1} d="m3 18 5.5-8.5L13 15l3.5-5L21 18H3Z"/></>) },
  balance: { body: (<><path pathLength={1} d="M12 4v16m-5 0h10"/><path pathLength={1} d="m12 6-6 1.5L3.5 13a3.1 3.1 0 0 0 5 0L6 7.5M12 6l6 1.5 2.5 5.5a3.1 3.1 0 0 1-5 0L18 7.5"/></>) },
  branch: { body: (<><circle pathLength={1} cx="6" cy="6" r="2.5"/><circle pathLength={1} cx="6" cy="18" r="2.5"/><circle pathLength={1} cx="18" cy="8" r="2.5"/><path pathLength={1} d="M6 8.5v7M6 13c5 0 5.5-2 9.3-3.2"/></>) },
  clock: { body: (<><circle pathLength={1} cx="12" cy="12" r="9"/><path pathLength={1} d="M12 7v5.2l3.4 2"/></>) },
  cpu: { body: (<><rect pathLength={1} x="7" y="7" width="10" height="10" rx="2"/><path pathLength={1} d="M10 2v3m4-3v3M10 19v3m4-3v3M2 10h3M2 14h3m14-4h3m-3 4h3"/></>) },
  zap: { body: (<><path pathLength={1} d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></>) },
  cast: { body: (<><path pathLength={1} d="M4 16a4 4 0 0 1 4 4M4 12a8 8 0 0 1 8 8"/><circle pathLength={1} cx="4" cy="20" r="1.2" fill="currentColor" stroke="none"/><path pathLength={1} d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/></>) },
  sun: { body: (<><circle pathLength={1} cx="12" cy="12" r="4"/><path pathLength={1} d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>) },
} satisfies Record<string, { body: ReactNode; solid?: boolean }>;

export type GlyphName = keyof typeof PATHS;

export function Glyph({
  name,
  size = 18,
  className,
  draw,
}: {
  name: GlyphName;
  size?: number;
  className?: string;
  /**
   * Declares an explicit state-entry drawing. Hover/focus replay belongs only
   * to primary actions; ordinary controls keep their icon visible.
   */
  draw?: string;
}) {
  const icon: { body: ReactNode; solid?: boolean } = PATHS[name];
  const isSolid = icon.solid === true;
  const glyphClass = [
    "lr-glyph",
    draw ? "lr-glyph-draw" : null,
    isSolid ? "is-solid" : null,
    className ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  const graphicRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const graphic = graphicRef.current;
    if (!draw || !graphic?.closest("button:is(.lr-btn.is-primary, .lr-tv-big, .lr-join-go, .lr-tv-overlay)")) return;
    return bindSvgReplayOnPointerEnter(graphic);
  }, [draw]);

  return (
    <svg
      ref={graphicRef}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={isSolid ? "currentColor" : "none"}
      stroke={isSolid ? "none" : "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={glyphClass}
    >
      {icon.body}
    </svg>
  );
}
