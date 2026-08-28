// Hand-drawn flat icon set for the living-room UI. Stroke icons use
// currentColor; solid icons (play/pause/stop) are filled. Bodies are real JSX
// children (never dangerouslySetInnerHTML — React re-sets innerHTML on every
// render pass, which would restart the draw-in animation on unrelated state
// changes; reconciled children stay put, so the draw only replays on a true
// icon swap). pathLength={1} on every shape paces the draw-in evenly.
import type { ReactNode } from "react";

const PATHS: Record<string, { body: ReactNode; solid?: boolean }> = {
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
  hash: { body: (<><path pathLength={1} d="M9 3 7 21M17 3l-2 18M4 8h17M3 16h17"/></>) },
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
  plug: { body: (<><path pathLength={1} d="M9 7V3m6 4V3"/><path pathLength={1} d="M6 7h12v4a6 6 0 0 1-12 0V7Z"/><path pathLength={1} d="M12 17v4"/></>) },
  gauge: { body: (<><path pathLength={1} d="M4 14.5a8 8 0 1 1 16 0"/><path pathLength={1} d="m12 14 3.5-4"/><path pathLength={1} d="M3.5 17.5h17"/></>) },
  drop: { body: (<><path pathLength={1} d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z"/></>) },
  expand: { body: (<><path pathLength={1} d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></>) },
  wave: { body: (<><path pathLength={1} d="M2 12c1.7 0 1.7-2.5 3.4-2.5S7 12 8.7 12s1.6-2.5 3.3-2.5S13.6 12 15.3 12s1.7-2.5 3.4-2.5S20.3 12 22 12"/></>) },
  speaker: { body: (<><path pathLength={1} d="M4 9v6h4l5 4V5L8 9H4Z"/><path pathLength={1} d="M16 9a4.2 4.2 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></>) },
  sliders: { body: (<><path pathLength={1} d="M3 6h9m4 0h5M3 12h3m4 0h11M3 18h12m4 0h2"/><circle pathLength={1} cx="14" cy="6" r="2"/><circle pathLength={1} cx="8" cy="12" r="2"/><circle pathLength={1} cx="17" cy="18" r="2"/></>) },
  mountain: { body: (<><path pathLength={1} d="m3 18 5.5-8.5L13 15l3.5-5L21 18H3Z"/></>) },
  balance: { body: (<><path pathLength={1} d="M12 4v16m-5 0h10"/><path pathLength={1} d="m12 6-6 1.5L3.5 13a3.1 3.1 0 0 0 5 0L6 7.5M12 6l6 1.5 2.5 5.5a3.1 3.1 0 0 1-5 0L18 7.5"/></>) },
  branch: { body: (<><circle pathLength={1} cx="6" cy="6" r="2.5"/><circle pathLength={1} cx="6" cy="18" r="2.5"/><circle pathLength={1} cx="18" cy="8" r="2.5"/><path pathLength={1} d="M6 8.5v7M6 13c5 0 5.5-2 9.3-3.2"/></>) },
  clock: { body: (<><circle pathLength={1} cx="12" cy="12" r="9"/><path pathLength={1} d="M12 7v5.2l3.4 2"/></>) },
  cpu: { body: (<><rect pathLength={1} x="7" y="7" width="10" height="10" rx="2"/><path pathLength={1} d="M10 2v3m4-3v3M10 19v3m4-3v3M2 10h3M2 14h3m14-4h3m-3 4h3"/></>) },
  star: { body: (<><path pathLength={1} d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2-5.6-3-5.6 3 1.2-6.2L3 9.5l6.3-.8L12 3Z"/></>) },
  zap: { body: (<><path pathLength={1} d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></>) },
  sparkles: { body: (<><path pathLength={1} d="m12 4 1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4Z"/><path pathLength={1} d="m18.5 15.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></>) },
  cast: { body: (<><path pathLength={1} d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9.95 9.95 0 0 1 9.95 20M2 8a14 14 0 0 1 14 14"/><circle pathLength={1} cx="3" cy="20" r="1.2" fill="currentColor" stroke="none"/><rect pathLength={1} x="2" y="4" width="20" height="15" rx="2"/></>) },
  sun: { body: (<><circle pathLength={1} cx="12" cy="12" r="4"/><path pathLength={1} d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>) },
};

export type GlyphName = keyof typeof PATHS;

export function Glyph({
  name,
  size = 18,
  className,
  draw,
}: {
  name: GlyphName | string;
  size?: number;
  className?: string;
  /**
   * Declares this icon a draw-in SPOT (the value is the spot's stable id,
   * used for documentation only). Spots are state-beat positions the author
   * chose deliberately: theatrical mounts (entry cast/door, stage overlay,
   * join/gate doors) and toggle icons whose form changes (pause↔play,
   * copy↔check, moon↔sun, eye↔eyeOff). The draw replays exactly when the
   * icon's innerHTML changes — a swap at the spot, or a genuine re-entry
   * remount. No runtime inference: icons without a spot never draw, so list
   * reconciliation and StrictMode can never cause a false trigger.
   */
  draw?: string;
}) {
  const icon = PATHS[name] ?? PATHS.alert;
  const isSolid = icon?.solid === true;
  const drawClass = [
    draw ? "lr-glyph-draw" : null,
    draw && isSolid ? "is-solid" : null,
    className ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
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
      className={drawClass || undefined}
    >
      {icon?.body}
    </svg>
  );
}
