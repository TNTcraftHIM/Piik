// Panel comics (四宫格漫画): pictorial state strips that carry meaning with no
// human language. Each
// scene is a self-contained inline SVG: own <style>, vls- prefixed keyframes,
// own prefers-reduced-motion block pinning informative final frames. Motion
// constitution: state-change beats only, loops rest >=40%, max 2 movers per
// panel, stamps play once and hold. SSR-safe: pure static markup, no hooks.

import { memo, type CSSProperties, type ReactNode } from "react";

export type ComicKind =
  | "waiting-for-host"
  | "connecting-p2p"
  | "connecting-sfu"
  | "tap-to-play"
  | "host-paused"
  | "recovering"
  | "route-failed"
  | "playback-failed"
  | "host-offline"
  | "no-audio"
  | "room-not-found"
  | "access-denied"
  | "invalid-invite"
  | "room-full"
  | "warning";

export const COMIC_KINDS: readonly ComicKind[] = [
  "waiting-for-host",
  "connecting-p2p",
  "connecting-sfu",
  "tap-to-play",
  "host-paused",
  "recovering",
  "route-failed",
  "playback-failed",
  "host-offline",
  "no-audio",
  "room-not-found",
  "access-denied",
  "invalid-invite",
  "room-full",
  "warning",
];

/** stage = dark TV overlay (default for overlay states); paper = join rows. */
export type ComicTheme = "stage" | "paper";

const DEFAULT_THEME: Record<ComicKind, ComicTheme> = {
  "waiting-for-host": "stage",
  "connecting-p2p": "stage",
  "connecting-sfu": "stage",
  "tap-to-play": "stage",
  "host-paused": "stage",
  recovering: "stage",
  "route-failed": "stage",
  "playback-failed": "stage",
  "host-offline": "stage",
  "no-audio": "stage",
  "room-not-found": "paper",
  "access-denied": "paper",
  "invalid-invite": "paper",
  "room-full": "paper",
  warning: "paper",
};

/* ------------------------------------------------------------------ *
 * Cast + idiom helpers. Everything is absolute-coordinates: any element
 * whose class animates `transform` must not carry a transform attribute
 * (CSS motion would override it), so helpers bake positions into paths.
 * ------------------------------------------------------------------ */

/* Cast is exported for the hint-scene sets under ./hints (control tooltips);
   scene functions only dereference these at render time, so the hints ↔ Comic
   module cycle is safe (function declarations hoist; consts read post-init). */
export const YOU = "#2fa66a";
export const LIVE = "#2fa66a";
export const WARN = "#d98e04";
export const DANGER = "#d64541";
export const INK_STAGE = "#dfe8f2";
export const MINT = "#9de8bf";
export const SKY = "#7ea4f5";
export const LINE = "#8ea3b8";
export const FAINT = "#7789a8";
export const TV_BODY = "#22303e";
export const TV_EDGE = "#57697f";
export const TV_SCREEN = "#16233c";
export const STAR_GOLD = "#efb23f";

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Panel frame: rounded rect, rx 14 at >100px wide, stroke 2.5. */
export function Frame({
  x,
  w,
  theme,
  accent,
}: {
  x: number;
  w: number;
  theme: ComicTheme;
  accent?: string;
}) {
  const paper = theme === "paper";
  return (
    <rect
      x={x}
      y={4}
      width={w}
      height={88}
      rx={w > 100 ? 14 : 12}
      fill={paper ? "var(--paper)" : "#0d1526"}
      stroke={accent ?? (paper ? "var(--ink)" : "#48597a")}
      strokeWidth={2.5}
    />
  );
}

/** Floor/horizon line characters stand on (stage scenes). */
export function Floor({ x1, x2, y = 76 }: { x1: number; x2: number; y?: number }) {
  return (
    <path
      d={`M${x1} ${y} H${x2}`}
      stroke="#48597a"
      strokeWidth={2.5}
      strokeLinecap="round"
    />
  );
}

/** Mini pawn, feet on (x, yb), s = half-width. Green you-pawn by default. */
export function Pawn({
  x,
  yb,
  s,
  color = YOU,
  eyes = false,
  className,
}: {
  x: number;
  yb: number;
  s: number;
  color?: string;
  eyes?: boolean;
  className?: string;
}) {
  const body = `M${r2(x - s)} ${yb} c0-${r2(s * 1.1)} ${r2(s * 0.45)}-${r2(s * 1.55)} ${s}-${r2(s * 1.55)} s${s} ${r2(s * 0.45)} ${s} ${r2(s * 1.55)} Z`;
  const headR = r2(s * 0.6);
  const hy = r2(yb - s * 1.55 - headR * 0.75);
  const inner = (
    <>
      <path d={body} fill={color} />
      <circle cx={x} cy={hy} r={headR} fill={color} />
      {eyes ? (
        <>
          <circle cx={x - 2.2} cy={hy} r={r2(s * 0.11)} fill="#101a2c" />
          <circle cx={x + 2.2} cy={hy} r={r2(s * 0.11)} fill="#101a2c" />
        </>
      ) : null}
    </>
  );
  return className ? <g className={className}>{inner}</g> : inner;
}

/** Mini host TV: body + recessed screen. */
export function MiniTv({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={Math.min(8, h * 0.2)}
        fill={TV_BODY}
        stroke={TV_EDGE}
        strokeWidth={2}
      />
      <rect
        x={r2(x + w * 0.07)}
        y={r2(y + h * 0.11)}
        width={r2(w * 0.86)}
        height={r2(h * 0.66)}
        rx={Math.min(4, h * 0.1)}
        fill={TV_SCREEN}
      />
    </>
  );
}

/** Crescent moon (host not live / room asleep). Static; safe to transform. */
export function Moon({
  x,
  y,
  k = 1,
}: {
  x: number;
  y: number;
  k?: number;
}) {
  return (
    <g transform={`translate(${r2(x - 229 * k)} ${r2(y - 48 * k)}) scale(${k})`}>
      <path
        fillRule="evenodd"
        d="M229 39.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 1 1 0-17ZM232.5 42.3a6.3 6.3 0 1 0 0 11.4 6.3 6.3 0 1 0 0-11.4Z"
        fill="#f2e9c9"
      />
    </g>
  );
}

/** Host crown outline; dashed = the host is gone, not asleep. */
const CROWN_PTS: ReadonlyArray<readonly [number, number]> = [
  [-6, 0],
  [-8.5, -10.5],
  [-3, -6],
  [0, -12.5],
  [3, -6],
  [8.5, -10.5],
  [6, 0],
];
export function Crown({
  x,
  y,
  k = 1,
  dashed = false,
  className,
  baseOpacity,
}: {
  x: number;
  y: number;
  k?: number;
  dashed?: boolean;
  className?: string;
  baseOpacity?: number;
}) {
  const d = `M${CROWN_PTS.map(([px, py]) => `${r2(x + px * k)} ${r2(y + py * k)}`).join(" L")} Z`;
  return dashed ? (
    <path
      className={className}
      opacity={baseOpacity}
      d={d}
      fill="none"
      stroke={STAR_GOLD}
      strokeWidth={2}
      strokeDasharray="4 3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ) : (
    <path className={className} opacity={baseOpacity} d={d} fill={STAR_GOLD} />
  );
}

/** SFU relay server box; two slot lines light --live as the dot passes. */
export function ServerBox({
  x,
  y,
  w = 24,
  h = 16,
  lit = false,
  slotsClass,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  lit?: boolean;
  slotsClass?: string;
}) {
  const inset = w * 0.17;
  const slots = (
    <>
      <path d={`M${r2(x + inset)} ${r2(y + h * 0.31)}h${r2(w - inset * 2)}`} />
      <path d={`M${r2(x + inset)} ${r2(y + h * 0.63)}h${r2(w - inset * 2)}`} />
    </>
  );
  return (
    <>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={2.5}
        fill="#0d1526"
        stroke={lit ? LIVE : LINE}
        strokeWidth={2}
      />
      {slotsClass ? (
        <g className={slotsClass} stroke={LIVE} strokeWidth={2} strokeLinecap="round">
          {slots}
        </g>
      ) : (
        <g stroke={LIVE} strokeWidth={2} strokeLinecap="round">
          {slots}
        </g>
      )}
    </>
  );
}

/** Join-page door (paper rooms). */
export function Door({ x, y, className }: { x: number; y: number; className?: string }) {
  const inner = (
    <>
      <rect
        x={x}
        y={y}
        width={32}
        height={54}
        rx={5}
        fill="var(--wall-2)"
        stroke="var(--ink)"
        strokeWidth={2.5}
      />
      <circle cx={x + 25} cy={y + 28} r={2} fill="var(--ink)" />
    </>
  );
  return className ? <g className={className}>{inner}</g> : inner;
}

/** Tiny spark at a route break: three rays. */
export function Spark({ x, y, className }: { x: number; y: number; className?: string }) {
  return (
    <g
      className={className}
      stroke={STAR_GOLD}
      strokeWidth={2}
      strokeLinecap="round"
      fill="none"
    >
      <path d={`M${x} ${y - 6}v-5 M${x - 11} ${y - 2}l-4 -3 M${x + 11} ${y - 2}l4 -3`} />
    </g>
  );
}

/** Four-point success star; plays once, then holds. */
export function Star({
  x,
  y,
  r = 6,
  className,
  baseOpacity,
}: {
  x: number;
  y: number;
  r?: number;
  className?: string;
  baseOpacity?: number;
}) {
  const a = r / 3;
  const d = `M${x} ${y - r} l${a} ${r - a} ${r - a} ${a} -${r - a} ${a} -${a} ${r - a} -${a} -${r - a} -${r - a} -${a} ${r - a} -${a} Z`;
  return <path className={className} opacity={baseOpacity} d={d} fill={STAR_GOLD} />;
}

/** Red-X verdict stamp: stamped once, held forever; never pulses. */
export function RedX({
  cx,
  cy,
  arm = 6,
  className,
}: {
  cx: number;
  cy: number;
  arm?: number;
  className?: string;
}) {
  return (
    <path
      className={className}
      d={`M${cx - arm} ${cy - arm} L${cx + arm} ${cy + arm} M${cx + arm} ${cy - arm} L${cx - arm} ${cy + arm}`}
      stroke={DANGER}
      strokeWidth={3}
      strokeLinecap="round"
      fill="none"
    />
  );
}

/** Power plug, prongs pointing down, cord trailing up-right. */
export function Plug({ x, y, className }: { x: number; y: number; className?: string }) {
  const inner = (
    <>
      <path
        d={`M${x} ${y} c0-8 6-10 12-12`}
        stroke={TV_EDGE}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
      />
      <rect x={x - 14} y={y} width={28} height={14} rx={4} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <path
        d={`M${x - 4} ${y + 14}v6 M${x + 4} ${y + 14}v6`}
        stroke={LINE}
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </>
  );
  return className ? <g className={className}>{inner}</g> : inner;
}

/** Wall socket the plug seats into. */
export function Socket({ x, y }: { x: number; y: number }) {
  return (
    <>
      <rect x={x} y={y} width={20} height={15} rx={3} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <path
        d={`M${x + 6} ${y + 5}v6 M${x + 14} ${y + 5}v6`}
        stroke="#101a2c"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  );
}

/** TV-static speckles; positions hand-scattered inside the given screen. */
export function Static({
  pts,
  cls,
}: {
  pts: ReadonlyArray<readonly [number, number]>;
  cls: string;
}) {
  return (
    <g className={cls} fill="#7d92a8">
      {pts.map(([px, py], i) => (
        <rect key={i} x={px} y={py} width={2.5} height={2.5} rx={0.5} />
      ))}
    </g>
  );
}

/** SVG-local reduced-motion block: kill keyframes, pin informative poses. */
export function rmBlock(kills: string[], pins: Array<readonly [string, string]>): string {
  const kill = kills.map((c) => `.${c}{animation:none}`).join("");
  const pin = pins.map(([s, c]) => `${s}{${c}}`).join("");
  return `@media (prefers-reduced-motion:reduce){${kill}${pin}}`;
}

/* ------------------------------ scenes ------------------------------ */

/** 1. waiting-for-host: 1 wide panel, loop 3.2s. */
function SceneWaiting({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-wf-moon{transform-box:fill-box;transform-origin:center;animation:vlsWfMoon 3.2s ease-in-out infinite}
.vls-wf-z1{animation:vlsWfZ 3.2s ease-in-out infinite}
.vls-wf-z2{animation:vlsWfZ 3.2s ease-in-out .45s infinite}
.vls-wf-z3{animation:vlsWfZ 3.2s ease-in-out .9s infinite}
.vls-wf-eyes{transform-box:fill-box;transform-origin:center;animation:vlsWfBlink 3.2s ease-in-out infinite}
.vls-wf-led{animation:vlsWfLed 1.1s ease-in-out infinite}
@keyframes vlsWfMoon{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes vlsWfZ{0%{opacity:0;transform:translateY(3px)}8%{opacity:.9}20%,100%{opacity:0;transform:translateY(-3px)}}
@keyframes vlsWfBlink{0%,66%,74%,100%{transform:scaleY(1)}70%{transform:scaleY(.12)}}
@keyframes vlsWfLed{0%,100%{opacity:1}50%{opacity:.35}}
${rmBlock(
  ["vls-wf-moon", "vls-wf-z1", "vls-wf-z2", "vls-wf-z3", "vls-wf-eyes", "vls-wf-led"],
  [[".vls-wf-z1,.vls-wf-z2,.vls-wf-z3", "opacity:.55"], [".vls-wf-led", "opacity:1"]],
)}
`}</style>
      <Frame x={4} w={312} theme={theme} />
      <Floor x1={24} x2={296} />
      <Pawn x={69} yb={76} s={11} />
      <g className="vls-wf-eyes">
        <circle cx={71} cy={53} r={1.1} fill="#101a2c" />
        <circle cx={74.6} cy={53} r={1.1} fill="#101a2c" />
      </g>
      <rect x={206} y={28} width={64} height={42} rx={8} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <rect x={212} y={34} width={52} height={28} rx={4} fill={TV_SCREEN} />
      <g className="vls-wf-moon">
        <path
          fillRule="evenodd"
          d="M229 39.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 1 1 0-17ZM232.5 42.3a6.3 6.3 0 1 0 0 11.4 6.3 6.3 0 1 0 0-11.4Z"
          fill="#f2e9c9"
        />
      </g>
      <g stroke="#a9bcd4" strokeWidth={2} strokeLinecap="round" fill="none">
        <path className="vls-wf-z1" opacity={0.55} d="M244 51h6l-6 4h6" />
        <path className="vls-wf-z2" opacity={0.55} d="M251 44h7l-7 5h7" />
        <path className="vls-wf-z3" opacity={0.55} d="M258 36h8l-8 6h8" />
      </g>
      <circle className="vls-wf-led" cx={238} cy={76} r={3.5} fill={WARN} />
    </>
  );
}

/** 2/3. connecting P2P / SFU: 3 panels, loop 2.8s. */
function SceneConnecting({ theme, sfu }: { theme: ComicTheme; sfu: boolean }) {
  const k = sfu ? "vls-cs" : "vls-cn";
  const dotKf = sfu
    ? `@keyframes ${k}Dot{0%{transform:translate(0,0);opacity:0}6%{opacity:1}26%{transform:translate(10px,-31px)}40%{transform:translate(36px,-31px);opacity:1}56%{transform:translate(46px,-12px);opacity:1}68%{transform:translate(46px,-12px);opacity:1}78%,100%{transform:translate(46px,-12px);opacity:0}}
@keyframes ${k}Slots{0%,26%{opacity:.25}34%,62%{opacity:1}72%,100%{opacity:.25}}`
    : `@keyframes ${k}Dot{0%{transform:translate(0,0);opacity:0}8%{opacity:1}55%{transform:translate(26px,0);opacity:1}70%{transform:translate(26px,0);opacity:1}80%,100%{transform:translate(26px,0);opacity:0}}`;
  const kills = sfu
    ? [`${k}-line`, `${k}-dot`, `${k}-slots`, `${k}-warm`, `${k}-led`]
    : [`${k}-line`, `${k}-dot`, `${k}-warm`, `${k}-led`];
  const pins: Array<readonly [string, string]> = [
    [`.${k}-dot`, "opacity:0"],
    [`.${k}-warm`, "opacity:.2"],
    [`.${k}-led`, "opacity:1"],
  ];
  if (sfu) pins.push([`.${k}-slots`, "opacity:1"]);
  return (
    <>
      <style>{`
.${k}-line{animation:${k}March 1.1s linear infinite}
.${k}-dot{animation:${k}Dot 2.8s ease-in-out infinite}
${sfu ? `.${k}-slots{animation:${k}Slots 2.8s ease-in-out infinite}` : ""}
.${k}-warm{animation:${k}Warm 2.8s ease-in-out infinite}
.${k}-led{animation:${k}Led .8s ease-in-out infinite}
@keyframes ${k}March{to{stroke-dashoffset:-16}}
${dotKf}
@keyframes ${k}Warm{0%,52%{opacity:0}60%{opacity:.25}66%{opacity:.1}74%{opacity:.3}100%{opacity:.18}}
@keyframes ${k}Led{0%,100%{opacity:1}50%{opacity:.3}}
${rmBlock(kills, pins)}
`}</style>
      <Frame x={8} w={96} theme={theme} />
      <Frame x={112} w={96} theme={theme} />
      <Frame x={216} w={96} theme={theme} />
      <Floor x1={20} x2={92} />
      <Pawn x={56} yb={76} s={11} eyes />
      <Pawn x={128} yb={74} s={7} eyes />
      {sfu ? (
        <>
          <g stroke={LINE} strokeWidth={2.5} strokeLinecap="round" fill="none" strokeDasharray="4 4">
            <path className={`${k}-line`} d="M137 57 L147 26" />
            <path className={`${k}-line`} d="M173 26 L183 45" />
          </g>
          <ServerBox x={148} y={15} slotsClass={`${k}-slots`} />
          <g className={`${k}-dot`}>
            <circle cx={137} cy={57} r={2.5} fill={MINT} />
          </g>
          <rect x={170} y={40} width={24} height={16} rx={3} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={1.5} />
          <circle cx={182} cy={61} r={2} fill={TV_EDGE} />
        </>
      ) : (
        <>
          <path
            className={`${k}-line`}
            d="M137 57 H166"
            stroke={LINE}
            strokeWidth={2.5}
            strokeLinecap="round"
            fill="none"
            strokeDasharray="4 4"
          />
          <g className={`${k}-dot`}>
            <path d="M132 52 l-6 -3 M132 62 l-6 3" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
            <circle cx={140} cy={57} r={2.5} fill={MINT} />
          </g>
          <rect x={170} y={42} width={24} height={16} rx={3} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={1.5} />
          <circle cx={182} cy={63} r={2} fill={TV_EDGE} />
        </>
      )}
      <Floor x1={228} x2={300} />
      <rect x={238} y={26} width={52} height={40} rx={7} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <rect x={244} y={32} width={40} height={24} rx={4} fill={TV_SCREEN} />
      <rect className={`${k}-warm`} x={244} y={32} width={40} height={24} rx={4} fill={SKY} opacity={0} />
      <circle className={`${k}-led`} cx={264} cy={72} r={3.5} fill="#4a84f2" />
    </>
  );
}

/** 4. tap-to-play: 2 panels, loop 2.4s. Companion to the real big button. */
function SceneTap({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-tp-finger{animation:vlsTpFinger 2.4s ease-in-out infinite}
.vls-tp-btn{transform-box:fill-box;transform-origin:center;animation:vlsTpBtn 2.4s ease-in-out infinite}
.vls-tp-ripple{transform-box:fill-box;transform-origin:center;animation:vlsTpRipple 2.4s ease-out infinite}
.vls-tp-flash{animation:vlsTpFlash 2.4s ease-in-out infinite}
.vls-tp-play{transform-box:fill-box;transform-origin:center;animation:vlsTpPlay 2.4s ease-in-out infinite}
.vls-tp-led{animation:vlsTpLed 2.4s ease-in-out infinite}
.vls-tp-arcs{animation:vlsTpArcs 2.4s ease-in-out infinite}
@keyframes vlsTpFinger{0%,18%{transform:translate(0,0)}42%,52%{transform:translate(30px,-18px)}78%,100%{transform:translate(0,0)}}
@keyframes vlsTpBtn{0%,40%{transform:scale(1)}46%{transform:scale(.86)}54%{transform:scale(1.05)}60%,100%{transform:scale(1)}}
@keyframes vlsTpRipple{0%,42%{transform:scale(1);opacity:0}45%{opacity:.75}72%,100%{transform:scale(1.65);opacity:0}}
@keyframes vlsTpFlash{0%,48%{opacity:0}54%{opacity:.4}66%,100%{opacity:0}}
@keyframes vlsTpPlay{0%,50%{transform:scale(1)}57%{transform:scale(1.18)}66%,100%{transform:scale(1)}}
@keyframes vlsTpLed{0%,50%{opacity:.3}56%,82%{opacity:1}100%{opacity:.3}}
@keyframes vlsTpArcs{0%,52%{opacity:0}58%{opacity:.9}64%{opacity:.15}72%{opacity:.9}86%,100%{opacity:0}}
${rmBlock(
  ["vls-tp-finger", "vls-tp-btn", "vls-tp-ripple", "vls-tp-flash", "vls-tp-play", "vls-tp-led", "vls-tp-arcs"],
  [
    [".vls-tp-ripple,.vls-tp-flash", "opacity:0"],
    [".vls-tp-arcs", "opacity:.5"],
    [".vls-tp-led", "opacity:1"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      <circle className="vls-tp-ripple" cx={80} cy={48} r={24} fill="none" stroke={SKY} strokeWidth={3} />
      <g className="vls-tp-btn">
        <circle cx={80} cy={48} r={24} fill="#2f6fed" />
        <path d="M74 39 L91 48 L74 57 Z" fill="#fff" />
      </g>
      <g className="vls-tp-finger">
        <path d="M22 80 l7 -7 M27 85 l7 -7" stroke={FAINT} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={34} cy={72} r={7} fill={INK_STAGE} />
      </g>
      <rect x={200} y={22} width={88} height={52} rx={8} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <rect x={206} y={28} width={76} height={36} rx={4} fill={TV_SCREEN} />
      <rect className="vls-tp-flash" x={206} y={28} width={76} height={36} rx={4} fill={INK_STAGE} opacity={0} />
      <path className="vls-tp-play" d="M236 38 L254 46 L236 54 Z" fill={MINT} />
      <circle className="vls-tp-led" cx={244} cy={80} r={3.5} fill={LIVE} opacity={0.3} />
      <g className="vls-tp-arcs" opacity={0} stroke={MINT} strokeWidth={2.5} strokeLinecap="round" fill="none">
        <path d="M294 38 a12 12 0 0 1 0 16" />
        <path d="M300 33 a20 20 0 0 1 0 26" />
      </g>
    </>
  );
}

/** 5. host-paused: 2 panels, loop 3s. Cozy, not broken — no z's, no red. */
function ScenePaused({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-hp-bars{animation:vlsHpBars 3s ease-in-out infinite}
.vls-hp-led{animation:vlsHpLed 1.1s ease-in-out infinite}
.vls-hp-eyes{transform-box:fill-box;transform-origin:center;animation:vlsHpBlink 3s ease-in-out infinite}
.vls-hp-steam1{animation:vlsHpSteam 3s ease-in-out infinite}
.vls-hp-steam2{animation:vlsHpSteam 3s ease-in-out 1.5s infinite}
@keyframes vlsHpBars{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes vlsHpLed{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes vlsHpBlink{0%,44%,52%,100%{transform:scaleY(1)}48%{transform:scaleY(.12)}}
@keyframes vlsHpSteam{0%{transform:translateY(2px);opacity:0}25%{opacity:.9}55%,100%{transform:translateY(-5px);opacity:0}}
${rmBlock(
  ["vls-hp-bars", "vls-hp-led", "vls-hp-eyes", "vls-hp-steam1", "vls-hp-steam2"],
  [
    [".vls-hp-bars,.vls-hp-led", "opacity:1"],
    [".vls-hp-steam1", "opacity:.55;transform:translateY(-2px)"],
    [".vls-hp-steam2", "opacity:0"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      <rect x={36} y={16} width={88} height={54} rx={9} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <rect x={42} y={22} width={76} height={38} rx={4} fill={TV_SCREEN} />
      <rect x={42} y={22} width={76} height={38} rx={4} fill="#0a101c" opacity={0.5} />
      <g className="vls-hp-bars" fill={INK_STAGE}>
        <rect x={70} y={30} width={9} height={26} rx={3.5} />
        <rect x={85} y={30} width={9} height={26} rx={3.5} />
      </g>
      <circle className="vls-hp-led" cx={80} cy={76} r={3.5} fill={WARN} />
      <Floor x1={176} x2={304} y={78} />
      <path d="M198 78 c0-16 8-22 18-22 s18 6 18 22 Z" fill={YOU} />
      <circle cx={216} cy={50} r={9} fill={YOU} />
      <g className="vls-hp-eyes" fill="#101a2c">
        <circle cx={212.5} cy={49} r={1.5} />
        <circle cx={219.5} cy={49} r={1.5} />
      </g>
      <rect x={240} y={66} width={12} height={12} rx={3} fill="#e4572e" />
      <path d="M252 69 a5 5 0 0 1 0 6" stroke="#e4572e" strokeWidth={2.5} fill="none" />
      <path className="vls-hp-steam1" d="M243 60 q3 -4 0 -8" stroke={LINE} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0} />
      <path className="vls-hp-steam2" d="M249 60 q-3 -4 0 -8" stroke={LINE} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0} />
    </>
  );
}

/** 6. recovering: 3 panels, loop 3.2s. Plug re-seats, LEDs chase, one sweat drop. */
function SceneRecovering({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-rc-spark{animation:vlsRcSpark 3.2s ease-in-out infinite}
.vls-rc-plug{transform-box:fill-box;transform-origin:center;animation:vlsRcPlug 3.2s ease-in-out infinite}
.vls-rc-plug-lines{animation:vlsRcPlugLines 3.2s ease-in-out infinite}
.vls-rc-sweat{transform-box:fill-box;transform-origin:center;animation:vlsRcSweat 3.2s ease-in-out infinite}
.vls-rc-c1{animation:vlsRcC1 3.2s ease-in-out infinite}
.vls-rc-c2{animation:vlsRcC2 3.2s ease-in-out infinite}
.vls-rc-c3{animation:vlsRcC3 3.2s ease-in-out infinite}
@keyframes vlsRcSpark{0%{opacity:0}10%{opacity:1}30%,100%{opacity:.55}}
@keyframes vlsRcPlug{0%{transform:translate(-4px,-9px) rotate(-6deg)}12%{transform:translate(-2px,-4px) rotate(5deg)}22%{transform:translate(0,-1px) rotate(-2deg)}30%,100%{transform:translate(0,0) rotate(0)}}
@keyframes vlsRcPlugLines{0%{opacity:0}6%{opacity:.9}28%,100%{opacity:0}}
@keyframes vlsRcSweat{0%,53%{opacity:0;transform:translateY(0)}56%{opacity:1}72%,100%{opacity:0;transform:translateY(9px)}}
@keyframes vlsRcC1{0%,24%{opacity:.25}32%,58%{opacity:1}66%,100%{opacity:.25}}
@keyframes vlsRcC2{0%,34%{opacity:.25}42%,64%{opacity:1}72%,100%{opacity:.25}}
@keyframes vlsRcC3{0%,44%{opacity:.25}52%,70%{opacity:1}78%,100%{opacity:.25}}
${rmBlock(
  ["vls-rc-spark", "vls-rc-plug", "vls-rc-plug-lines", "vls-rc-sweat", "vls-rc-c1", "vls-rc-c2", "vls-rc-c3"],
  [
    [".vls-rc-plug", "transform:none"],
    [".vls-rc-plug-lines", "opacity:0"],
    [".vls-rc-spark", "opacity:1"],
    [".vls-rc-c1,.vls-rc-c2,.vls-rc-c3", "opacity:1"],
    [".vls-rc-sweat", "opacity:0"],
  ],
)}
`}</style>
      <Frame x={8} w={96} theme={theme} />
      <Frame x={112} w={96} theme={theme} />
      <Frame x={216} w={96} theme={theme} />
      <Floor x1={20} x2={92} />
      <Pawn x={40} yb={76} s={8} eyes />
      <MiniTv x={66} y={44} w={26} h={18} />
      <path d="M48 58 H53 M59 58 H64" stroke={LINE} strokeWidth={2.5} strokeLinecap="round" fill="none" />
      <Spark x={56} y={52} className="vls-rc-spark" />
      <Socket x={170} y={50} />
      <g className="vls-rc-plug-lines" opacity={0}>
        <path d="M156 34 l-7 -4 M158 44 l-8 0" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
      </g>
      <Plug x={180} y={30} className="vls-rc-plug" />
      <Floor x1={228} x2={300} />
      <Pawn x={252} yb={76} s={9} eyes />
      <path
        className="vls-rc-sweat"
        d="M264 46 c2 3 2 5 0 6 c-2 -1 -2 -3 0 -6 Z"
        fill={SKY}
        opacity={0}
      />
      <circle className="vls-rc-c1" cx={272} cy={34} r={3} fill={LIVE} opacity={0.25} />
      <circle className="vls-rc-c2" cx={284} cy={34} r={3} fill={LIVE} opacity={0.25} />
      <circle className="vls-rc-c3" cx={296} cy={34} r={3} fill={LIVE} opacity={0.25} />
    </>
  );
}

/** 7. route-failed: 4 panels, direct and SFU paths both end unavailable. */
function SceneRouteFailed({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-rf-panel{transform-box:fill-box;transform-origin:center;animation:vlsRfIn .5s cubic-bezier(.3,1.5,.5,1) backwards}
.vls-rf-p2{animation-delay:.15s}.vls-rf-p3{animation-delay:.3s}.vls-rf-p4{animation-delay:.45s}
.vls-rf-march{animation:vlsRfMarch .4s linear .4s 3 both}
.vls-rf-x{transform-box:fill-box;transform-origin:center;animation:vlsRfX 3.6s ease-out both}
.vls-rf-spark{animation:vlsRfSpark 3.6s ease-out both}
.vls-rf-dot{animation:vlsRfDot 3.6s ease-in-out both}
.vls-rf-fallback{stroke-dasharray:5 5;animation:vlsRfFallback 3.6s ease-out both,vlsRfFailurePulse 2.6s ease-in-out 3.6s infinite}
.vls-rf-fallback-x{transform-box:fill-box;transform-origin:center;animation:vlsRfFallbackX 3.6s ease-out both,vlsRfFailureX 2.6s ease-in-out 3.6s infinite}
.vls-rf-slots{animation:vlsRfSlots 3.6s ease-out both}
.vls-rf-grey{animation:vlsRfGrey 3.6s ease-out both}
@keyframes vlsRfIn{from{opacity:0;transform:translateY(6px) scale(.9)}}
@keyframes vlsRfMarch{from{stroke-dashoffset:0}to{stroke-dashoffset:-16}}
@keyframes vlsRfX{0%,32%{opacity:0;transform:scale(1.7) rotate(8deg)}40%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
@keyframes vlsRfSpark{0%,32%{opacity:0}35%{opacity:1}44%,100%{opacity:0}}
@keyframes vlsRfDot{0%,44%{transform:translate(0,0);opacity:0}46%{opacity:1}54%{transform:translate(2px,-31px)}60%{transform:translate(18px,-31px)}70%,100%{transform:translate(28px,-11px);opacity:0}}
@keyframes vlsRfFallback{0%,72%{opacity:0}80%,100%{opacity:.42}}
@keyframes vlsRfFallbackX{0%,78%{opacity:0;transform:scale(1.6) rotate(8deg)}86%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
@keyframes vlsRfFailurePulse{0%,100%{opacity:.42;stroke-dashoffset:0}50%{opacity:.72;stroke-dashoffset:-8}}
@keyframes vlsRfFailureX{0%,100%{opacity:1}50%{opacity:.58}}
@keyframes vlsRfSlots{0%,60%{opacity:0}66%,100%{opacity:1}}
@keyframes vlsRfGrey{0%{opacity:.9}70%{opacity:.9}82%,100%{opacity:.15}}
${rmBlock(
  ["vls-rf-panel", "vls-rf-march", "vls-rf-x", "vls-rf-spark", "vls-rf-dot", "vls-rf-fallback", "vls-rf-fallback-x", "vls-rf-slots", "vls-rf-grey"],
  [
    [".vls-rf-fallback", "stroke-dasharray:none;opacity:.42"],
    [".vls-rf-fallback-x,.vls-rf-slots", "opacity:1;transform:none"],
    [".vls-rf-spark,.vls-rf-dot", "opacity:0"],
    [".vls-rf-grey", "opacity:.15"],
  ],
)}
`}</style>
      <g className="vls-rf-panel">
        <Frame x={4} w={72} theme={theme} />
        <path d="M9 68 c0-12 5-17 11-17 s11 5 11 17 Z" fill={YOU} />
        <circle cx={20} cy={42} r={6.5} fill={YOU} />
        <circle cx={17.5} cy={41} r={1.1} fill="#101a2c" />
        <circle cx={22.5} cy={41} r={1.1} fill="#101a2c" />
        <rect x={47} y={36} width={18} height={13} rx={2.5} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={1.5} />
        <circle cx={56} cy={54} r={2} fill={TV_EDGE} />
        <path className="vls-rf-march" d="M28 47 H46" stroke={LINE} strokeWidth={2.5} strokeDasharray="4 4" fill="none" />
      </g>
      <g className="vls-rf-panel vls-rf-p2">
        <Frame x={84} w={72} theme={theme} />
        <path d="M89 68 c0-12 5-17 11-17 s11 5 11 17 Z" fill={YOU} />
        <circle cx={100} cy={42} r={6.5} fill={YOU} />
        <circle cx={97.5} cy={41} r={1.1} fill="#101a2c" />
        <circle cx={102.5} cy={41} r={1.1} fill="#101a2c" />
        <rect x={127} y={36} width={18} height={13} rx={2.5} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={1.5} />
        <circle cx={136} cy={54} r={2} fill={DANGER} />
        <path d="M108 47 H113 M121 47 H126" stroke={LINE} strokeWidth={2.5} fill="none" />
        <g className="vls-rf-spark" opacity={0} stroke={STAR_GOLD} strokeWidth={2} strokeLinecap="round">
          <path d="M117 36 v-5 M106 40 l-4 -3 M128 40 l4 -3" />
        </g>
        <path className="vls-rf-x" d="M111 41 L123 53 M123 41 L111 53" stroke={DANGER} strokeWidth={3} strokeLinecap="round" fill="none" />
      </g>
      <g className="vls-rf-panel vls-rf-p3">
        <Frame x={164} w={72} theme={theme} />
        <path d="M169 68 c0-12 5-17 11-17 s11 5 11 17 Z" fill={YOU} />
        <circle cx={180} cy={42} r={6.5} fill={YOU} />
        <circle cx={177.5} cy={41} r={1.1} fill="#101a2c" />
        <circle cx={182.5} cy={41} r={1.1} fill="#101a2c" />
        <rect x={207} y={36} width={18} height={13} rx={2.5} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={1.5} />
        <circle cx={216} cy={54} r={2} fill={TV_EDGE} />
        <rect x={192} y={10} width={16} height={12} rx={2.5} fill="#0d1526" stroke={LINE} strokeWidth={2} />
        <g className="vls-rf-slots" stroke={LIVE} strokeWidth={2} strokeLinecap="round">
          <path d="M195 14 h10 M195 18 h10" />
        </g>
        <g className="vls-rf-grey" stroke={LINE} strokeWidth={2.5} strokeDasharray="4 4" fill="none">
          <path d="M188 47 L192 16" />
          <path d="M208 16 L216 34" />
        </g>
        <circle className="vls-rf-dot" cx={188} cy={47} r={2.5} fill={MINT} opacity={0} />
      </g>
      <g className="vls-rf-panel vls-rf-p4">
        <Frame x={244} w={72} theme={theme} />
        <path d="M249 68 c0-12 5-17 11-17 s11 5 11 17 Z" fill={YOU} />
        <circle cx={260} cy={42} r={6.5} fill={YOU} />
        <circle cx={257.5} cy={41} r={1.1} fill="#101a2c" />
        <circle cx={262.5} cy={41} r={1.1} fill="#101a2c" />
        <rect x={287} y={36} width={18} height={13} rx={2.5} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={1.5} />
        <circle cx={296} cy={54} r={2} fill={DANGER} />
        <rect x={272} y={10} width={16} height={12} rx={2.5} fill="#0d1526" stroke={LINE} strokeWidth={2} />
        <path d="M275 14 h10 M275 18 h10" stroke={LINE} strokeWidth={2} strokeLinecap="round" />
        <g className="vls-rf-fallback" opacity={0} stroke={LINE} strokeWidth={2.5} fill="none">
          <path d="M268 47 L272 16" />
          <path d="M288 16 L296 34" />
        </g>
        <path
          className="vls-rf-fallback-x"
          d="M288 25 L298 35 M298 25 L288 35"
          stroke={DANGER}
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </>
  );
}

/** 8. playback-failed: 2 panels, loop 3s. Link fine, picture dead. */
function ScenePlaybackFailed({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-pf-s1{animation:vlsPfStaticA .36s steps(3) infinite}
.vls-pf-s2{animation:vlsPfStaticB .36s steps(3) infinite}
.vls-pf-rip{animation:vlsPfRip 3s ease-in-out infinite}
.vls-pf-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsPfTap 3s ease-in-out infinite}
.vls-pf-ring{animation:vlsPfRing 3s ease-in-out infinite}
@keyframes vlsPfStaticA{0%{transform:translate(0,0);opacity:.5}33%{transform:translate(1px,-1px);opacity:.8}66%{transform:translate(-1px,1px);opacity:.35}100%{transform:translate(0,0);opacity:.5}}
@keyframes vlsPfStaticB{0%{transform:translate(0,0);opacity:.35}33%{transform:translate(-1px,1px);opacity:.7}66%{transform:translate(1px,-1px);opacity:.45}100%{transform:translate(0,0);opacity:.35}}
@keyframes vlsPfRip{0%,18%{opacity:.35}22%{opacity:.7}28%{opacity:.35}33%{opacity:.7}42%,100%{opacity:.35}}
@keyframes vlsPfTap{0%,16%{transform:translate(0,0)}20%{transform:translate(4px,0)}24%{transform:translate(0,0)}31%{transform:translate(0,0)}35%{transform:translate(4px,0)}39%,100%{transform:translate(0,0)}}
@keyframes vlsPfRing{0%,55%{opacity:.25}63%{opacity:1}78%,100%{opacity:.25}}
${rmBlock(
  ["vls-pf-s1", "vls-pf-s2", "vls-pf-rip", "vls-pf-pawn", "vls-pf-ring"],
  [
    [".vls-pf-s1,.vls-pf-s2,.vls-pf-rip", "opacity:.35;transform:none"],
    [".vls-pf-ring", "opacity:1"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      <Floor x1={16} x2={60} />
      <Pawn x={34} yb={76} s={8} eyes />
      <path d="M44 62 H68" stroke={LIVE} strokeWidth={2.5} strokeLinecap="round" fill="none" />
      <MiniTv x={70} y={30} w={64} h={40} />
      <Static
        cls="vls-pf-s1"
        pts={[[78, 38], [92, 34], [108, 40], [122, 36], [84, 50], [100, 46], [116, 52], [126, 48]]}
      />
      <Static
        cls="vls-pf-s2"
        pts={[[86, 42], [104, 36], [118, 44], [80, 56], [96, 54], [112, 48], [124, 56], [90, 57]]}
      />
      <Floor x1={176} x2={304} y={78} />
      <Pawn x={200} yb={78} s={9} eyes className="vls-pf-pawn" />
      <MiniTv x={232} y={26} w={66} h={42} />
      <Static
        cls="vls-pf-rip"
        pts={[[240, 34], [254, 32], [270, 38], [284, 34], [246, 46], [262, 44], [278, 48], [252, 52], [268, 54], [284, 50]]}
      />
      <g className="vls-pf-ring" opacity={0.25}>
        <circle cx={306} cy={18} r={9} fill="none" stroke={SKY} strokeWidth={2.5} />
        <path d="M311 11 l3 -2 M312 13 l4 0" stroke={SKY} strokeWidth={2.5} strokeLinecap="round" fill="none" />
      </g>
    </>
  );
}

/** 9. host-offline: 2 panels, loop 3.4s. Plug pulled; dashed crown = gone. */
function SceneHostOffline({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-ho-plug{transform-box:fill-box;transform-origin:50% 0%;animation:vlsHoSway 3.4s ease-in-out infinite}
.vls-ho-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsHoWave 3.4s ease-in-out infinite}
.vls-ho-crown{animation:vlsHoCrown 3.4s ease-in-out infinite}
@keyframes vlsHoSway{0%{transform:rotate(-6deg)}10%{transform:rotate(6deg)}20%{transform:rotate(-5deg)}30%{transform:rotate(4deg)}40%,100%{transform:rotate(0)}}
@keyframes vlsHoWave{0%,10%{transform:rotate(0)}14%{transform:rotate(-8deg)}18%{transform:rotate(8deg)}22%{transform:rotate(-8deg)}26%{transform:rotate(8deg)}30%,100%{transform:rotate(0)}}
@keyframes vlsHoCrown{0%,30%{opacity:.2}40%{opacity:.7}50%,100%{opacity:.2}}
${rmBlock(
  ["vls-ho-plug", "vls-ho-pawn", "vls-ho-crown"],
  [[".vls-ho-plug", "transform:none"], [".vls-ho-crown", "opacity:.5"]],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      <rect x={30} y={22} width={70} height={44} rx={8} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <rect x={36} y={28} width={58} height={30} rx={4} fill="#0a101c" />
      <Moon x={72} y={43} k={0.55} />
      <path d="M65 66 c0 6 -4 8 -8 10" stroke={TV_EDGE} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <Plug x={57} y={76} className="vls-ho-plug" />
      <Floor x1={176} x2={304} y={78} />
      <Pawn x={210} yb={78} s={9} eyes className="vls-ho-pawn" />
      <Crown x={272} y={42} k={1.1} dashed className="vls-ho-crown" baseOpacity={0.5} />
    </>
  );
}

/** 10. no-audio: 2 panels, loop 3s. Before: TV alive (mint play triangle,
 * flicker ticks), three healthy LIVE-green sound arcs. After: picture still
 * alive, sound dashed + red-slashed, and a big you-pawn (s=18) presses BOTH
 * mitten-hands to its head — arms stamp up once and hold, head micro-shakes
 * "I hear nothing". Rest >=44%. */
function SceneNoAudio({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-na-flick{animation:vlsNaFlick 3s ease-in-out infinite}
.vls-na-a1{animation:vlsNaArc 3s ease-in-out infinite}
.vls-na-a2{animation:vlsNaArc 3s ease-in-out -.3s infinite}
.vls-na-a3{animation:vlsNaArc 3s ease-in-out -.6s infinite}
.vls-na-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsNaShake 3s ease-in-out infinite}
.vls-na-arm{transform-box:fill-box;transform-origin:50% 100%;animation:vlsNaArm 3s cubic-bezier(.3,1.4,.5,1) infinite}
.vls-na-slash{transform-box:fill-box;transform-origin:center;animation:vlsNaSlash 3s ease-out infinite}
@keyframes vlsNaFlick{0%{opacity:.15}10%{opacity:.8}20%{opacity:.2}30%{opacity:.7}40%,100%{opacity:.15}}
@keyframes vlsNaArc{0%{opacity:.45}12%{opacity:1}26%{opacity:.45}42%,100%{opacity:.8}}
@keyframes vlsNaArm{0%,8%{transform:scaleY(.05)}20%,100%{transform:scaleY(1)}}
@keyframes vlsNaSlash{0%,22%{opacity:0;transform:scale(1.7)}30%,100%{opacity:1;transform:scale(1)}}
@keyframes vlsNaShake{0%,36%,56%,100%{transform:rotate(0)}40%{transform:rotate(-2.5deg)}44%{transform:rotate(2.5deg)}48%{transform:rotate(-1.8deg)}52%{transform:rotate(1.8deg)}}
${rmBlock(
  ["vls-na-flick", "vls-na-a1", "vls-na-a2", "vls-na-a3", "vls-na-pawn", "vls-na-arm", "vls-na-slash"],
  [
    [".vls-na-flick", "opacity:.5"],
    [".vls-na-a1,.vls-na-a2,.vls-na-a3", "opacity:.8"],
    [".vls-na-slash", "opacity:1;transform:none"],
    [".vls-na-arm,.vls-na-pawn", "transform:none"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      {/* panel 1 (before): picture alive, three healthy sound arcs */}
      <rect x={26} y={20} width={76} height={48} rx={9} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
      <rect x={32} y={26} width={64} height={32} rx={4} fill={TV_SCREEN} />
      <path d="M54 34 L74 42 L54 50 Z" fill={MINT} />
      <g className="vls-na-flick" stroke={SKY} strokeWidth={2} strokeLinecap="round" opacity={0.15}>
        <path d="M38 30v6 M42 40v5" />
        <path d="M92 31v6 M88 41v5" />
      </g>
      <circle cx={64} cy={74} r={3} fill={LIVE} />
      <g stroke={LIVE} strokeWidth={2.5} fill="none" strokeLinecap="round">
        <path className="vls-na-a1" d="M106 36a10 10 0 0 1 0 16" />
        <path className="vls-na-a2" d="M112 31a16 16 0 0 1 0 26" />
        <path className="vls-na-a3" d="M118 26a22 22 0 0 1 0 36" />
      </g>
      {/* panel 2 (after): picture still alive on the mini TV, but the sound
          arcs arrive dashed and carry a stamped red slash; big pawn (s=18)
          presses both mitten-hands to its head — arms are body-green with a
          dark halo outline so the pose reads on both themes. */}
      <MiniTv x={172} y={30} w={42} h={30} />
      <path d="M187 37.5 L199 43 L187 48.5 Z" fill={MINT} />
      <Floor x1={176} x2={308} y={85} />
      <g
        stroke={LINE}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
        strokeDasharray="4 3"
        opacity={0.5}
      >
        <path d="M218 38a8 8 0 0 1 0 12" />
        <path d="M223 33.5a14 14 0 0 1 0 21" />
        <path d="M228 29a20 20 0 0 1 0 32" />
      </g>
      <path
        className="vls-na-slash"
        d="M216 29 L250 63"
        stroke={DANGER}
        strokeWidth={3.5}
        strokeLinecap="round"
        fill="none"
      />
      <g className="vls-na-pawn">
        <path d="M264 85 c0-19.8 8.1-27.9 18-27.9 s18 8.1 18 27.9 Z" fill={YOU} />
        <circle cx={282} cy={49} r={10.8} fill={YOU} />
        <circle cx={276} cy={48} r={2} fill="#101a2c" />
        <circle cx={281} cy={48} r={2} fill="#101a2c" />
        <g className="vls-na-arm">
          <path d="M267 72 Q256 57 272 45" stroke="#101a2c" strokeWidth={6.5} strokeLinecap="round" fill="none" />
          <path d="M267 72 Q256 57 272 45" stroke={YOU} strokeWidth={3.5} strokeLinecap="round" fill="none" />
        </g>
        <g className="vls-na-arm">
          <path d="M297 72 Q308 57 292 45" stroke="#101a2c" strokeWidth={6.5} strokeLinecap="round" fill="none" />
          <path d="M297 72 Q308 57 292 45" stroke={YOU} strokeWidth={3.5} strokeLinecap="round" fill="none" />
        </g>
      </g>
    </>
  );
}

/** 11. room-not-found: 2 paper panels, loop 3s. The door isn't there. */
function SceneNotFound({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-rn-knock{animation:vlsRnKnock 3s ease-in-out infinite}
.vls-rn-kn{animation:vlsRnKn 3s ease-in-out infinite}
.vls-rn-solid{animation:vlsRnSolid 3s ease-in-out infinite}
.vls-rn-ghost{animation:vlsRnGhost 3s ease-in-out infinite}
.vls-rn-puff{animation:vlsRnPuff 3s ease-in-out infinite}
@keyframes vlsRnKnock{0%{transform:translateX(0)}6%{transform:translateX(5px)}12%{transform:translateX(0)}18%{transform:translateX(5px)}25%,100%{transform:translateX(0)}}
@keyframes vlsRnKn{0%,3%{opacity:0}7%{opacity:.9}11%{opacity:0}19%{opacity:.9}24%,100%{opacity:0}}
@keyframes vlsRnSolid{0%,30%{opacity:1}45%,80%{opacity:0}92%,100%{opacity:1}}
@keyframes vlsRnGhost{0%,30%{opacity:0}45%,80%{opacity:.9}92%,100%{opacity:0}}
@keyframes vlsRnPuff{0%,38%{opacity:0;transform:translateY(3px)}50%{opacity:.6}68%,100%{opacity:0;transform:translateY(-4px)}}
${rmBlock(
  ["vls-rn-knock", "vls-rn-kn", "vls-rn-solid", "vls-rn-ghost", "vls-rn-puff"],
  [[".vls-rn-solid", "opacity:0"], [".vls-rn-ghost", "opacity:.9"], [".vls-rn-puff,.vls-rn-kn", "opacity:0"]],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      <g className="vls-rn-knock">
        <path d="M52 74 c0-11 5-16 11-16 s11 5 11 16 Z" fill={YOU} />
        <circle cx={63} cy={49} r={6} fill={YOU} />
        <circle cx={66} cy={48} r={1} fill="#101a2c" />
        <circle cx={70} cy={48} r={1} fill="#101a2c" />
      </g>
      <g className="vls-rn-kn" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" opacity={0}>
        <path d="M84 36l-7-3M82 46h-8M84 56l-7 3" />
      </g>
      <Door x={96} y={18} />
      <g className="vls-rn-solid">
        <Door x={250} y={18} />
      </g>
      <g className="vls-rn-ghost" opacity={0}>
        <rect
          x={250}
          y={18}
          width={32}
          height={54}
          rx={5}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={2.5}
          strokeDasharray="5 4"
        />
      </g>
      <g className="vls-rn-puff" fill="var(--ink)" opacity={0}>
        <circle cx={250} cy={30} r={3} />
        <circle cx={262} cy={24} r={4} />
        <circle cx={272} cy={32} r={2.5} />
      </g>
    </>
  );
}

/** 12. access-denied: 2 paper panels, loop 3s. Door there, won't open. */
function SceneAccessDenied({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-ad-door{transform-box:fill-box;transform-origin:center;animation:vlsAdShake 3s ease-in-out infinite}
.vls-ad-x{transform-box:fill-box;transform-origin:center;animation:vlsAdX 3s ease-out infinite}
@keyframes vlsAdShake{0%{transform:translateX(0)}3%{transform:translateX(-3px)}6%{transform:translateX(3px)}9%{transform:translateX(-2px)}12%{transform:translateX(2px)}15%,100%{transform:translateX(0)}}
@keyframes vlsAdX{0%,18%{opacity:0;transform:scale(1.6) rotate(8deg)}24%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
${rmBlock(["vls-ad-door", "vls-ad-x"], [[".vls-ad-x", "opacity:1;transform:scale(1) rotate(8deg)"]])}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      <Pawn x={48} yb={76} s={9} eyes />
      <rect x={60} y={38} width={16} height={11} rx={2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
      <circle cx={72} cy={43.5} r={1.6} fill="var(--ink)" />
      <Door x={100} y={18} />
      <rect x={112} y={40} width={10} height={13} rx={2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5} />
      <circle cx={117} cy={44} r={1.6} fill="var(--ink)" />
      <Pawn x={190} yb={76} s={9} eyes />
      <rect x={202} y={46} width={16} height={11} rx={2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
      <circle cx={214} cy={51.5} r={1.6} fill="var(--ink)" />
      <RedX cx={210} cy={51.5} arm={5.5} className="vls-ad-x" />
      <g className="vls-ad-door">
        <Door x={242} y={18} />
        <rect x={254} y={40} width={10} height={13} rx={2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5} />
        <circle cx={259} cy={44} r={2} fill={DANGER} />
      </g>
    </>
  );
}

/** 13. invalid-invite: 2 paper panels, loop 3.2s. The ticket is broken. */
function SceneInvalidInvite({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-ii-l{transform-box:fill-box;transform-origin:center;animation:vlsIiL 3.2s ease-in-out infinite}
.vls-ii-r{transform-box:fill-box;transform-origin:center;animation:vlsIiR 3.2s ease-in-out infinite}
.vls-ii-x{transform-box:fill-box;transform-origin:center;animation:vlsIiX 3.2s ease-out infinite}
@keyframes vlsIiL{0%{transform:translate(0,0) rotate(0)}35%,100%{transform:translate(-3px,1px) rotate(-5deg)}}
@keyframes vlsIiR{0%{transform:translate(0,0) rotate(0)}35%,100%{transform:translate(3px,-1px) rotate(5deg)}}
@keyframes vlsIiX{0%,38%{opacity:0;transform:scale(1.6) rotate(8deg)}45%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
${rmBlock(
  ["vls-ii-l", "vls-ii-r", "vls-ii-x"],
  [
    [".vls-ii-l", "transform:translate(-3px,1px) rotate(-5deg)"],
    [".vls-ii-r", "transform:translate(3px,-1px) rotate(5deg)"],
    [".vls-ii-x", "opacity:1;transform:scale(1) rotate(8deg)"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      <Pawn x={48} yb={76} s={9} eyes />
      <rect x={62} y={40} width={20} height={13} rx={2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
      <path d="M62 42 L72 48 L82 42" stroke="var(--ink)" strokeWidth={1.5} fill="none" />
      <Pawn x={186} yb={76} s={9} eyes />
      <g className="vls-ii-l">
        <path
          d="M228 38 H241 L238 42 L242 46 L238 50 L241 54 H228 Z"
          fill="var(--paper)"
          stroke="var(--ink)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </g>
      <g className="vls-ii-r">
        <path
          d="M252 38 H241 L244 42 L240 46 L244 50 L241 54 H252 Z"
          fill="var(--paper)"
          stroke="var(--ink)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </g>
      <RedX cx={240} cy={46} arm={6} className="vls-ii-x" />
    </>
  );
}

/** 14. room-full: 2 paper panels, loop 3.2s. Cute first, verdict clear. */
function SceneRoomFull({ theme }: { theme: ComicTheme }) {
  const crowd = [
    "var(--pawn-1)",
    "var(--pawn-2)",
    "var(--pawn-3)",
    "var(--pawn-4)",
    "var(--pawn-5)",
    "var(--pawn-6)",
    "var(--pawn-7)",
  ];
  return (
    <>
      <style>{`
.vls-fl-c1{animation:vlsFlSquish 3.2s ease-in-out infinite}
.vls-fl-c2{animation:vlsFlSquish 3.2s ease-in-out .09s infinite}
.vls-fl-c3{animation:vlsFlSquish 3.2s ease-in-out .18s infinite}
.vls-fl-c4{animation:vlsFlSquish 3.2s ease-in-out .27s infinite}
.vls-fl-c5{animation:vlsFlSquish 3.2s ease-in-out .36s infinite}
.vls-fl-c6{animation:vlsFlSquish 3.2s ease-in-out .45s infinite}
.vls-fl-c7{animation:vlsFlSquish 3.2s ease-in-out .54s infinite}
.vls-fl-you{transform-box:fill-box;transform-origin:50% 100%;animation:vlsFlBob 3.2s ease-in-out infinite}
.vls-fl-ghost{animation:vlsFlGhost 3.2s ease-in-out infinite}
@keyframes vlsFlSquish{0%{transform:translateY(0)}8%{transform:translateY(-1.5px)}16%,100%{transform:translateY(0)}}
@keyframes vlsFlBob{0%,14%{transform:translate(0,0)}20%{transform:translate(0,-3px)}26%,30%{transform:translate(0,0)}36%{transform:translate(0,-3px)}44%,100%{transform:translate(0,0)}}
@keyframes vlsFlGhost{0%,45%{opacity:.55}50%{opacity:.15}52%{opacity:.5}55%,100%{opacity:0}}
${rmBlock(
  ["vls-fl-c1", "vls-fl-c2", "vls-fl-c3", "vls-fl-c4", "vls-fl-c5", "vls-fl-c6", "vls-fl-c7", "vls-fl-you", "vls-fl-ghost"],
  [[".vls-fl-ghost", "opacity:0"]],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} />
      {crowd.map((color, i) => (
        <Pawn key={i} x={40 + i * 12} yb={56} s={5.5} color={color} className={`vls-fl-c${i + 1}`} />
      ))}
      <rect x={30} y={48} width={92} height={20} rx={10} fill="var(--couch)" />
      <rect x={24} y={62} width={104} height={16} rx={8} fill="var(--couch)" />
      <g className="vls-fl-you">
        <Pawn x={240} yb={64} s={7} eyes />
      </g>
      <rect x={196} y={58} width={100} height={22} rx={11} fill="var(--couch)" />
      <rect
        className="vls-fl-ghost"
        x={268}
        y={40}
        width={22}
        height={16}
        rx={4}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={2}
        strokeDasharray="4 3"
        opacity={0.55}
      />
    </>
  );
}

/** 15. warning: 1 wide panel, loop 2.6s. Persistent condition: the you-pawn
 * stands beside the big Hearth coal-bowl warning glyph; heat-rays rise in a
 * staggered 0-55% window, the pawn blinks at 70%, rest >=50%. */
function SceneWarning({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-wn-ray1{animation:vlsWnRay 2.6s ease-out infinite}
.vls-wn-ray2{animation:vlsWnRay 2.6s ease-out .25s infinite}
.vls-wn-ray3{animation:vlsWnRay 2.6s ease-out .5s infinite}
.vls-wn-eyes{transform-box:fill-box;transform-origin:center;animation:vlsWnBlink 2.6s ease-in-out infinite}
@keyframes vlsWnRay{0%{opacity:0;transform:translateY(3px)}9%{opacity:1}24%{transform:translateY(-2px)}50%,100%{transform:translateY(-2px);opacity:1}}
@keyframes vlsWnBlink{0%,66%,74%,100%{transform:scaleY(1)}70%{transform:scaleY(.12)}}
${rmBlock(
  ["vls-wn-ray1", "vls-wn-ray2", "vls-wn-ray3", "vls-wn-eyes"],
  [[".vls-wn-ray1,.vls-wn-ray2,.vls-wn-ray3", "opacity:1;transform:none"]],
)}
`}</style>
      <Frame x={4} w={312} theme={theme} />
      <Floor x1={24} x2={296} />
      <Pawn x={96} yb={76} s={11} />
      <g className="vls-wn-eyes">
        <circle cx={98} cy={53} r={1.1} fill="#101a2c" />
        <circle cx={101.6} cy={53} r={1.1} fill="#101a2c" />
      </g>
      {/* Hearth warning glyph x3.5 (~54% panel height), bowl feet on the floor:
          M6 13a6 6 0 0 0 12 0 + rays M12 9V5.5 / M8.5 9.5 7 7.5 / M15.5 9.5 17 7.5,
          baked at origin (168, 9.5). */}
      <path
        d="M189 55 a21 21 0 0 0 42 0"
        stroke={WARN}
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
      />
      <g stroke={WARN} strokeWidth={2.5} strokeLinecap="round" fill="none">
        <g className="vls-wn-ray1" opacity={0}>
          <path d="M197.75 42.75 L192.5 35.75" />
          <path d="M188.5 41 l-4 -3.5" stroke={FAINT} strokeWidth={2} />
        </g>
        <g className="vls-wn-ray2" opacity={0}>
          <path d="M210 41 V28.75" />
        </g>
        <g className="vls-wn-ray3" opacity={0}>
          <path d="M222.25 42.75 L227.5 35.75" />
          <path d="M231.5 41 l4 -3.5" stroke={FAINT} strokeWidth={2} />
        </g>
      </g>
    </>
  );
}

/* ------------------------------ component ------------------------------ */
const SCENES: Record<ComicKind, (props: { theme: ComicTheme }) => ReactNode> = {
  "waiting-for-host": SceneWaiting,
  "connecting-p2p": (p) => <SceneConnecting {...p} sfu={false} />,
  "connecting-sfu": (p) => <SceneConnecting {...p} sfu />,
  "tap-to-play": SceneTap,
  "host-paused": ScenePaused,
  recovering: SceneRecovering,
  "route-failed": SceneRouteFailed,
  "playback-failed": ScenePlaybackFailed,
  "host-offline": SceneHostOffline,
  "no-audio": SceneNoAudio,
  "room-not-found": SceneNotFound,
  "access-denied": SceneAccessDenied,
  "invalid-invite": SceneInvalidInvite,
  "room-full": SceneRoomFull,
  warning: SceneWarning,
};

/**
 * Self-contained pictorial state strip. Renders a 320x96 inline SVG at
 * width min(320px, 86%). The SVG is aria-hidden: wrap it in a role="status"
 * container with a localized aria-label (README §4).
 */
export const Comic = memo(function Comic({
  kind,
  size,
  theme,
}: {
  kind: ComicKind;
  size?: number;
  theme?: ComicTheme;
}) {
  const resolvedTheme = theme ?? DEFAULT_THEME[kind];
  const style: CSSProperties = {
    width: size != null ? `${size}px` : "min(320px, 86%)",
    height: "auto",
    display: "block",
  };
  return (
    <svg
      viewBox="0 0 320 96"
      style={style}
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {SCENES[kind]({ theme: resolvedTheme })}
    </svg>
  );
});
