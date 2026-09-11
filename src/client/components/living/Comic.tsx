// Panel comics (四宫格漫画): pictorial state strips that carry meaning with no
// human language. Each
// scene has its own vls- prefixed keyframes. Shared presentation owns tone,
// duration and repetition; settled states and reduced motion share informative
// poses. SSR-safe: pure static markup, no hooks.

import { memo, type CSSProperties, type ReactNode } from "react";
import { HostMark } from "./HostMark";
import { PersonShape } from "./Pawn";
import { comicStyle, getComicPresentation, type ComicMotion, type ComicTone } from "./comic-presentation";
import type { ComicKind, ComicTheme } from "../../ui/visual-kinds";

export type { ComicKind, ComicTheme };

const DEFAULT_THEME: Record<ComicKind, ComicTheme> = {
  "waiting-for-host": "stage",
  "connecting-p2p": "stage",
  "connecting-sfu": "stage",
  "signal-connecting": "paper",
  "signal-recovering": "paper",
  "signal-offline": "paper",
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
  "bandwidth-limited": "paper",
  "encoder-limited": "paper",
  warning: "paper",
};

/* ------------------------------------------------------------------ *
 * Cast + idiom helpers. Keep animated transform classes on an outer
 * wrapper so CSS motion cannot replace an inner positioning transform.
 * ------------------------------------------------------------------ */

/* Control hints reuse these scene objects and stable identity colours. */
export const YOU = "#2fa66a";
export const LIVE = "var(--live)";
export const WARN = "var(--warn)";
export const DANGER = "var(--danger)";
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
  result = false,
}: {
  x: number;
  w: number;
  theme: ComicTheme;
  result?: boolean;
}) {
  const paper = theme === "paper";
  const border = paper ? "var(--ink)" : "#48597a";
  return (
    <rect
      x={x}
      y={4}
      width={w}
      height={88}
      rx={w > 100 ? 14 : 12}
      fill={paper ? "var(--paper)" : "#0d1526"}
      stroke={result ? `var(--comic-tone, ${border})` : border}
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

/** Mini participant, feet centered on (x, yb); s is the head diameter. */
export function Pawn({
  x,
  yb,
  s,
  color = YOU,
  eyes = false,
  host,
  gaze,
  eyeClassName,
  className,
}: {
  x: number;
  yb: number;
  s: number;
  color?: string;
  eyes?: boolean | "closed";
  host?: boolean;
  gaze?: number;
  eyeClassName?: string;
  className?: string;
}) {
  const scale = s / 16;
  const inner = <g transform={`translate(${r2(x - 24 * scale)} ${r2(yb - 50 * scale)}) scale(${scale})`} fill={color}>
    <PersonShape eyes={eyes} gaze={gaze} eyeClassName={eyeClassName} host={host} />
  </g>;
  return className ? <g className={className}>{inner}</g> : inner;
}

/** Shared or watched media: the same TV silhouette in every scene. */
export function MiniTv({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const antenna = Math.min(5, h * 0.16);
  const foot = Math.min(4, h * 0.12);
  return (
    <>
      <path
        d={`M${r2(x + w * 0.38)} ${r2(y - antenna)} L${r2(x + w * 0.5)} ${y} L${r2(x + w * 0.62)} ${r2(y - antenna)} M${r2(x + w * 0.25)} ${y + h} l${-foot} ${foot} M${r2(x + w * 0.75)} ${y + h} l${foot} ${foot}`}
        fill="none"
        stroke={TV_EDGE}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

/** Browser UI, not the media itself; children use the scene's coordinates. */
export function BrowserWindow({ x, y, w, h, children }: {
  x: number; y: number; w: number; h: number; children?: ReactNode;
}) {
  const bar = Math.min(9, h * 0.2);
  return <>
    <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    <path d={`M${x} ${y + bar} H${x + w}`} stroke="var(--ink)" strokeWidth={1.5} />
    <g fill={FAINT}>
      <circle cx={x + 4} cy={y + bar / 2} r={1} />
      <circle cx={x + 8} cy={y + bar / 2} r={1} />
      <rect x={x + w * 0.3} y={y + bar / 2 - 1} width={w * 0.5} height={2} rx={1} />
    </g>
    {children}
  </>;
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
    <g transform={`translate(${r2(x)} ${r2(y)}) scale(${k})`}>
      <path
        d="M0 -8.5A8.5 8.5 0 1 0 0 8.5A6.2 8.5 0 0 1 0 -8.5Z"
        fill="#f2e9c9"
      />
    </g>
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
      stroke={`var(--comic-tone, ${DANGER})`}
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

/** Settled and reduced-motion scenes share the same informative poses. */
export function rmBlock(kills: string[], pins: Array<readonly [string, string]>): string {
  const rules = [...kills.map((c) => [`.${c}`, "animation:none"] as const), ...pins];
  const block = (scope: string) => rules.map(([selectors, styles]) =>
    `${selectors.split(",").map((selector) => scope + selector.trim()).join(",")}{${styles}}`,
  ).join("");
  return `${block('svg[data-comic-motion="still"] ')}@media (prefers-reduced-motion:reduce){${block("")}}`;
}

/* ------------------------------ scenes ------------------------------ */

/** 1. waiting-for-host: 1 wide panel. */
function SceneWaiting({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-wf-moon{transform-box:fill-box;transform-origin:center;animation:vlsWfMoon var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-wf-z1{animation:vlsWfZ var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-wf-z2{animation:vlsWfZ var(--comic-duration,3.2s) ease-in-out .45s var(--comic-repeat,1) both}
.vls-wf-z3{animation:vlsWfZ var(--comic-duration,3.2s) ease-in-out .9s var(--comic-repeat,1) both}
.vls-wf-eyes{transform-box:fill-box;transform-origin:center;animation:vlsWfBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-wf-led{animation:vlsWfLed var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsWfMoon{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes vlsWfZ{0%{opacity:0;transform:translateY(3px)}8%{opacity:.9}20%,100%{opacity:0;transform:translateY(-3px)}}
@keyframes vlsWfBlink{0%,66%,74%,100%{transform:scaleY(1)}70%{transform:scaleY(.12)}}
@keyframes vlsWfLed{0%,100%{opacity:1}50%{opacity:.35}}
${rmBlock(
  ["vls-wf-moon", "vls-wf-z1", "vls-wf-z2", "vls-wf-z3", "vls-wf-eyes", "vls-wf-led"],
  [[".vls-wf-z1,.vls-wf-z2,.vls-wf-z3", "opacity:.55"], [".vls-wf-led", "opacity:1"]],
)}
`}</style>
      <Frame x={4} w={312} theme={theme} result />
      <Floor x1={24} x2={296} />
      <Pawn x={69} yb={76} s={11} eyes gaze={2} eyeClassName="vls-wf-eyes" />
      <MiniTv x={206} y={28} w={64} h={42} />
      <g className="vls-wf-moon">
        <Moon x={229} y={48} />
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

/** 2/3. connecting P2P / SFU: 3 panels. */
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
.${k}-line{animation:${k}March var(--comic-duration,3.2s) linear var(--comic-repeat,1) both}
.${k}-dot{animation:${k}Dot var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
${sfu ? `.${k}-slots{animation:${k}Slots var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}` : ""}
.${k}-warm{animation:${k}Warm var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.${k}-led{animation:${k}Led var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes ${k}March{to{stroke-dashoffset:-16}}
${dotKf}
@keyframes ${k}Warm{0%,52%{opacity:0}60%{opacity:.25}66%{opacity:.1}74%{opacity:.3}100%{opacity:.18}}
@keyframes ${k}Led{0%,100%{opacity:1}50%{opacity:.3}}
${rmBlock(kills, pins)}
`}</style>
      <Frame x={8} w={96} theme={theme} />
      <Frame x={112} w={96} theme={theme} />
      <Frame x={216} w={96} theme={theme} result />
      <Floor x1={20} x2={92} />
      <Pawn x={56} yb={76} s={11} eyes />
      <Pawn x={128} yb={74} s={7} eyes color={SKY} />
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
          <MiniTv x={170} y={40} w={24} h={16} />
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
          <MiniTv x={170} y={42} w={24} h={16} />
          <circle cx={182} cy={63} r={2} fill={TV_EDGE} />
        </>
      )}
      <Floor x1={228} x2={300} />
      <MiniTv x={238} y={26} w={52} h={40} />
      <rect className={`${k}-warm`} x={244} y={32} width={40} height={24} rx={4} fill={SKY} opacity={0} />
      <circle className={`${k}-led`} cx={264} cy={72} r={3.5} fill="#4a84f2" />
    </>
  );
}

/** The page's control link, not a media path: no TV or video packets here. */
function SceneSignal({ theme, state }: {
  theme: ComicTheme;
  state: "connecting" | "recovering" | "offline";
}) {
  const color = state === "connecting" ? SKY : state === "recovering" ? WARN : FAINT;
  return (
    <>
      <style>{`
.vls-signal-message{animation:vlsSignalMessage var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-signal-retry{transform-box:fill-box;transform-origin:center;animation:vlsSignalRetry var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsSignalMessage{0%{transform:translateX(0);opacity:0}8%{opacity:1}40%{transform:translateX(82px);opacity:1}55%,100%{transform:translateX(82px);opacity:0}}
@keyframes vlsSignalRetry{0%{transform:rotate(0)}55%,100%{transform:rotate(360deg)}}
${rmBlock(["vls-signal-message", "vls-signal-retry"], [
  [".vls-signal-message", "opacity:1;transform:translateX(41px)"],
  [".vls-signal-retry", "transform:none"],
])}
`}</style>
      <Frame x={4} w={312} theme={theme} result />
      <BrowserWindow x={24} y={23} w={96} h={50}>
        <circle cx={37} cy={43} r={3} fill={color} />
        <path d="M47 43h56 M34 55h36 M77 55h26 M34 64h69" stroke={LINE} strokeWidth={2} strokeLinecap="round" />
      </BrowserWindow>
      <ServerBox x={254} y={25} w={42} h={46} />
      <path
        d={state === "connecting" ? "M130 48H244" : "M130 48H164 M204 48H244"}
        stroke={color}
        strokeWidth={2.5}
        strokeDasharray="4 5"
        strokeLinecap="round"
        fill="none"
      />
      {state === "connecting" ? (
        <>
          <path d="M140 42l-6 6 6 6 M234 42l6 6-6 6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <g className="vls-signal-message">
            <rect x={136} y={40} width={16} height={13} rx={2} fill="var(--paper)" stroke={color} strokeWidth={2} />
            <path d="M137 42l7 5 7-5" stroke={color} strokeWidth={1.5} strokeLinejoin="round" fill="none" />
          </g>
        </>
      ) : state === "recovering" ? (
        <g className="vls-signal-retry" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M175 43a11 11 0 0 1 19-2l2 3 M190 44h6v-6 M193 53a11 11 0 0 1-19 2l-2-3 M178 52h-6v6" />
        </g>
      ) : (
        <g stroke={color} strokeWidth={2.5} strokeLinecap="round" fill="none">
          <path d="M174 43h5 M174 53h5 M189 43h5 M189 53h5 M176 59l16-22" />
        </g>
      )}
    </>
  );
}

/** 4. tap-to-play: 2 panels. Companion to the real big button. */
function SceneTap({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-tp-finger{animation:vlsTpFinger var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-tp-btn{transform-box:fill-box;transform-origin:center;animation:vlsTpBtn var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-tp-ripple{transform-box:fill-box;transform-origin:center;animation:vlsTpRipple var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-tp-flash{animation:vlsTpFlash var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-tp-play{transform-box:fill-box;transform-origin:center;animation:vlsTpPlay var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-tp-led{animation:vlsTpLed var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-tp-arcs{animation:vlsTpArcs var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
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
      <Frame x={164} w={152} theme={theme} result />
      <circle className="vls-tp-ripple" cx={80} cy={48} r={24} fill="none" stroke={SKY} strokeWidth={3} />
      <g className="vls-tp-btn">
        <circle cx={80} cy={48} r={24} fill="#2f6fed" />
        <path d="M74 39 L91 48 L74 57 Z" fill="#fff" />
      </g>
      <g className="vls-tp-finger">
        <path d="M22 80 l7 -7 M27 85 l7 -7" stroke={FAINT} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={34} cy={72} r={7} fill={INK_STAGE} />
      </g>
      <MiniTv x={200} y={22} w={88} h={52} />
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

/** 5. host-paused: 2 panels. Cozy, not broken — no z's, no red. */
function ScenePaused({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-hp-bars{animation:vlsHpBars var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hp-led{animation:vlsHpLed var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hp-eyes{transform-box:fill-box;transform-origin:center;animation:vlsHpBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hp-steam1{animation:vlsHpSteam var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hp-steam2{animation:vlsHpSteam var(--comic-duration,3.2s) ease-in-out 1.5s var(--comic-repeat,1) both}
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
      <Frame x={164} w={152} theme={theme} result />
      <MiniTv x={36} y={16} w={88} h={54} />
      <rect x={42} y={22} width={76} height={38} rx={4} fill="#0a101c" opacity={0.5} />
      <g className="vls-hp-bars" fill={INK_STAGE}>
        <rect x={70} y={30} width={9} height={26} rx={3.5} />
        <rect x={85} y={30} width={9} height={26} rx={3.5} />
      </g>
      <circle className="vls-hp-led" cx={80} cy={76} r={3.5} fill={WARN} />
      <Floor x1={176} x2={304} y={78} />
      <Pawn x={216} yb={78} s={14} eyes eyeClassName="vls-hp-eyes" />
      <rect x={240} y={66} width={12} height={12} rx={3} fill="#e4572e" />
      <path d="M252 69 a5 5 0 0 1 0 6" stroke="#e4572e" strokeWidth={2.5} fill="none" />
      <path className="vls-hp-steam1" d="M243 60 q3 -4 0 -8" stroke={LINE} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0} />
      <path className="vls-hp-steam2" d="M249 60 q-3 -4 0 -8" stroke={LINE} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0} />
    </>
  );
}

/** 6. recovering: 3 panels. Plug re-seats, LEDs chase, one sweat drop. */
function SceneRecovering({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-rc-spark{animation:vlsRcSpark var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rc-plug{transform-box:fill-box;transform-origin:center;animation:vlsRcPlug var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rc-plug-lines{animation:vlsRcPlugLines var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rc-sweat{transform-box:fill-box;transform-origin:center;animation:vlsRcSweat var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rc-c1{animation:vlsRcC1 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rc-c2{animation:vlsRcC2 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rc-c3{animation:vlsRcC3 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
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
      <Frame x={216} w={96} theme={theme} result />
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
      <circle className="vls-rc-c1" cx={272} cy={34} r={3} fill={`var(--comic-tone, ${WARN})`} opacity={0.25} />
      <circle className="vls-rc-c2" cx={284} cy={34} r={3} fill={`var(--comic-tone, ${WARN})`} opacity={0.25} />
      <circle className="vls-rc-c3" cx={296} cy={34} r={3} fill={`var(--comic-tone, ${WARN})`} opacity={0.25} />
    </>
  );
}

/** 7. route-failed: the viewer cannot reach the same TV; no route history implied. */
function SceneRouteFailed({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-rf-panel{transform-box:fill-box;transform-origin:center;animation:vlsRfIn var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
.vls-rf-p2{animation-delay:.2s}
.vls-rf-march{animation:vlsRfMarch var(--comic-duration,3.2s) linear .4s var(--comic-repeat,1) both}
.vls-rf-x{transform-box:fill-box;transform-origin:center;animation:vlsRfX var(--comic-duration,3.2s) ease-out .8s var(--comic-repeat,1) both}
.vls-rf-sweat{animation:vlsRfSweat var(--comic-duration,3.2s) ease-in-out 1.2s var(--comic-repeat,1) both}
@keyframes vlsRfIn{from{opacity:0;transform:translateY(6px) scale(.9)}}
@keyframes vlsRfMarch{from{stroke-dashoffset:0}to{stroke-dashoffset:-16}}
@keyframes vlsRfX{from{opacity:0;transform:scale(1.5)}to{opacity:1;transform:scale(1)}}
@keyframes vlsRfSweat{0%,65%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(3px)}}
${rmBlock(
  ["vls-rf-panel", "vls-rf-march", "vls-rf-x", "vls-rf-sweat"],
  [
    [".vls-rf-x", "opacity:1;transform:none"],
    [".vls-rf-sweat", "opacity:.7;transform:none"],
  ],
)}
`}</style>
      <g className="vls-rf-panel">
        <Frame x={4} w={152} theme={theme} />
        <Floor x1={16} x2={144} />
        <Pawn x={32} yb={76} s={10} eyes />
        <MiniTv x={94} y={36} w={44} h={30} />
        <path className="vls-rf-march" d="M44 55 H61 M75 55 H92" stroke={LINE} strokeWidth={2.5} strokeDasharray="4 4" strokeLinecap="round" fill="none" />
        <path d="M66 49 l-3 6 7 0 -3 6" stroke={DANGER} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>
      <g className="vls-rf-panel vls-rf-p2">
        <Frame x={164} w={152} theme={theme} result />
        <Floor x1={176} x2={304} />
        <Pawn x={192} yb={76} s={10} eyes />
        <MiniTv x={254} y={36} w={44} h={30} />
        <circle cx={288} cy={62} r={2} fill={DANGER} />
        <path d="M204 55 H218 M238 55 H252" stroke={FAINT} strokeWidth={2.5} strokeLinecap="round" fill="none" />
        <RedX cx={228} cy={55} arm={6} className="vls-rf-x" />
        <path className="vls-rf-sweat" d="M206 46 c2 3 2 5 0 6 c-2 -1 -2 -3 0 -6 Z" fill={SKY} opacity={0.35} />
      </g>
    </>
  );
}

/** 8. playback-failed: 2 panels. The current picture is unavailable. */
function ScenePlaybackFailed({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-pf-s1{animation:vlsPfStaticA var(--comic-duration,3.2s) steps(3) var(--comic-repeat,1) both}
.vls-pf-s2{animation:vlsPfStaticB var(--comic-duration,3.2s) steps(3) var(--comic-repeat,1) both}
.vls-pf-rip{animation:vlsPfRip var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-pf-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsPfTap var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-pf-ring{animation:vlsPfRing var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
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
      <Frame x={164} w={152} theme={theme} result />
      <Floor x1={16} x2={60} />
      <Pawn x={34} yb={76} s={8} eyes />
      <path d="M44 62 H68" stroke={LINE} strokeWidth={2.5} strokeLinecap="round" fill="none" />
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

/** 9. host-offline: 2 panels. Plug pulled; dashed Host crown = gone. */
function SceneHostOffline({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-ho-plug{transform-box:fill-box;transform-origin:50% 0%;animation:vlsHoSway var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ho-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsHoWave var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ho-badge{animation:vlsHoBadge var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsHoSway{0%{transform:rotate(-6deg)}10%{transform:rotate(6deg)}20%{transform:rotate(-5deg)}30%{transform:rotate(4deg)}40%,100%{transform:rotate(0)}}
@keyframes vlsHoWave{0%,10%{transform:rotate(0)}14%{transform:rotate(-8deg)}18%{transform:rotate(8deg)}22%{transform:rotate(-8deg)}26%{transform:rotate(8deg)}30%,100%{transform:rotate(0)}}
@keyframes vlsHoBadge{0%,30%{opacity:.2}40%{opacity:.7}50%,100%{opacity:.2}}
${rmBlock(
  ["vls-ho-plug", "vls-ho-pawn", "vls-ho-badge"],
  [[".vls-ho-plug", "transform:none"], [".vls-ho-badge", "opacity:.5"]],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} result />
      <MiniTv x={30} y={22} w={70} h={44} />
      <rect x={36} y={28} width={58} height={30} rx={4} fill="#0a101c" />
      <path d="M65 66 c0 6 -4 8 -8 10" stroke={TV_EDGE} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <Plug x={57} y={76} className="vls-ho-plug" />
      <Floor x1={176} x2={304} y={78} />
      <Pawn x={210} yb={78} s={9} eyes className="vls-ho-pawn" />
      <HostMark x={257} y={43} width={30} dashed className="vls-ho-badge" opacity={0.5} />
    </>
  );
}

/** 10. no-audio: 2 panels. Before: TV alive (mint play triangle,
 * flicker ticks), three healthy LIVE-green sound arcs. After: picture still
 * alive, sound dashed + red-slashed, and a big you-pawn (s=18) presses BOTH
 * mitten-hands to its head — arms stamp up once and hold, head micro-shakes
 * "I hear nothing". Rest >=44%. */
function SceneNoAudio({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-na-flick{animation:vlsNaFlick var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-na-a1{animation:vlsNaArc var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-na-a2{animation:vlsNaArc var(--comic-duration,3.2s) ease-in-out -.3s var(--comic-repeat,1) both}
.vls-na-a3{animation:vlsNaArc var(--comic-duration,3.2s) ease-in-out -.6s var(--comic-repeat,1) both}
.vls-na-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsNaShake var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-na-arm{transform-box:fill-box;transform-origin:50% 100%;animation:vlsNaArm var(--comic-duration,3.2s) cubic-bezier(.3,1.4,.5,1) var(--comic-repeat,1) both}
.vls-na-slash{transform-box:fill-box;transform-origin:center;animation:vlsNaSlash var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsNaFlick{0%{opacity:.15}10%{opacity:.8}20%{opacity:.2}30%{opacity:.7}40%,100%{opacity:.15}}
@keyframes vlsNaArc{0%{opacity:.45}12%{opacity:1}26%{opacity:.45}42%,100%{opacity:.8}}
@keyframes vlsNaArm{0%,8%{opacity:0;transform:translateY(10px)}20%,100%{opacity:1;transform:translateY(0)}}
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
      <Frame x={164} w={152} theme={theme} result />
      {/* panel 1 (before): picture alive, three healthy sound arcs */}
      <MiniTv x={26} y={20} w={76} h={48} />
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
          arcs arrive dashed and carry a stamped red slash; the pawn raises
          two floating round hands toward its ears. */}
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
        <Pawn x={282} yb={85} s={16} eyes gaze={-2} />
        <g className="vls-na-arm">
          <circle cx={269} cy={52} r={3.5} fill={YOU} />
        </g>
        <g className="vls-na-arm">
          <circle cx={295} cy={52} r={3.5} fill={YOU} />
        </g>
      </g>
    </>
  );
}

/** 11. room-not-found: 2 paper panels. The door isn't there. */
function SceneNotFound({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-rn-knock{animation:vlsRnKnock var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rn-kn{animation:vlsRnKn var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rn-solid{animation:vlsRnSolid var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rn-ghost{animation:vlsRnGhost var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rn-puff{animation:vlsRnPuff var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
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
      <Frame x={164} w={152} theme={theme} result />
      <g className="vls-rn-knock">
        <Pawn x={63} yb={74} s={11} eyes gaze={2} />
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

/** 12. access-denied: 2 paper panels. Door there, won't open. */
function SceneAccessDenied({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-ad-door{transform-box:fill-box;transform-origin:center;animation:vlsAdShake var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ad-x{transform-box:fill-box;transform-origin:center;animation:vlsAdX var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsAdShake{0%{transform:translateX(0)}3%{transform:translateX(-3px)}6%{transform:translateX(3px)}9%{transform:translateX(-2px)}12%{transform:translateX(2px)}15%,100%{transform:translateX(0)}}
@keyframes vlsAdX{0%,18%{opacity:0;transform:scale(1.6) rotate(8deg)}24%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
${rmBlock(["vls-ad-door", "vls-ad-x"], [[".vls-ad-x", "opacity:1;transform:scale(1) rotate(8deg)"]])}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} result />
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

/** 13. invalid-invite: 2 paper panels. The ticket is broken. */
function SceneInvalidInvite({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-ii-l{transform-box:fill-box;transform-origin:center;animation:vlsIiL var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ii-r{transform-box:fill-box;transform-origin:center;animation:vlsIiR var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ii-x{transform-box:fill-box;transform-origin:center;animation:vlsIiX var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
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
      <Frame x={164} w={152} theme={theme} result />
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

/** 14. room-full: 2 paper panels. Cute first, verdict clear. */
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
.vls-fl-c1{animation:vlsFlSquish var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-fl-c2{animation:vlsFlSquish var(--comic-duration,3.2s) ease-in-out .09s var(--comic-repeat,1) both}
.vls-fl-c3{animation:vlsFlSquish var(--comic-duration,3.2s) ease-in-out .18s var(--comic-repeat,1) both}
.vls-fl-c4{animation:vlsFlSquish var(--comic-duration,3.2s) ease-in-out .27s var(--comic-repeat,1) both}
.vls-fl-c5{animation:vlsFlSquish var(--comic-duration,3.2s) ease-in-out .36s var(--comic-repeat,1) both}
.vls-fl-c6{animation:vlsFlSquish var(--comic-duration,3.2s) ease-in-out .45s var(--comic-repeat,1) both}
.vls-fl-c7{animation:vlsFlSquish var(--comic-duration,3.2s) ease-in-out .54s var(--comic-repeat,1) both}
.vls-fl-you{transform-box:fill-box;transform-origin:50% 100%;animation:vlsFlBob var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-fl-ghost{animation:vlsFlGhost var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsFlSquish{0%{transform:translateY(0)}8%{transform:translateY(-1.5px)}16%,100%{transform:translateY(0)}}
@keyframes vlsFlBob{0%,14%{transform:translate(0,0)}20%{transform:translate(0,-3px)}26%,30%{transform:translate(0,0)}36%{transform:translate(0,-3px)}44%,100%{transform:translate(0,0)}}
@keyframes vlsFlGhost{0%,45%{opacity:.55}50%{opacity:.15}52%{opacity:.5}55%,100%{opacity:0}}
${rmBlock(
  ["vls-fl-c1", "vls-fl-c2", "vls-fl-c3", "vls-fl-c4", "vls-fl-c5", "vls-fl-c6", "vls-fl-c7", "vls-fl-you", "vls-fl-ghost"],
  [[".vls-fl-ghost", "opacity:0"]],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} result />
      <path d="M34 78v6m86-6v6M202 78v6m88-6v6" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
      <rect x={26} y={58} width={102} height={19} rx={9} fill="var(--couch)" stroke="none" />
      {crowd.map((color, i) => (
        <Pawn key={i} x={40 + i * 12} yb={67} s={5.5} color={color} eyes className={`vls-fl-c${i + 1}`} />
      ))}
      <g fill="var(--couch-dark)" stroke="none">
        <rect x={26} y={69} width={102} height={10} rx={4} />
        <rect x={22} y={63} width={11} height={16} rx={5} />
        <rect x={121} y={63} width={11} height={16} rx={5} />
        <rect x={196} y={58} width={100} height={19} rx={9} fill="var(--couch)" />
      </g>
      <g className="vls-fl-you">
        <Pawn x={240} yb={67} s={7} eyes />
      </g>
      <g fill="var(--couch-dark)" stroke="none">
        <rect x={196} y={69} width={100} height={10} rx={4} />
        <rect x={192} y={63} width={11} height={16} rx={5} />
        <rect x={289} y={63} width={11} height={16} rx={5} />
      </g>
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

/** Native bandwidth adaptation: a roomy path narrows, then the delivered
 * picture shrinks. The route owner is deliberately absent; this describes the
 * Browser report without guessing which physical link is responsible. */
function SceneBandwidthLimited({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-bw-flow-a{animation:vlsBwFlowA var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-bw-flow-b{animation:vlsBwFlowB var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-bw-throat{transform-box:fill-box;transform-origin:center;animation:vlsBwThroat var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-bw-small{transform-box:fill-box;transform-origin:center;animation:vlsBwSmall var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsBwFlowA{0%,12%{transform:translateX(-8px);opacity:0}26%,58%{transform:none;opacity:1}72%,100%{transform:translateX(8px);opacity:0}}
@keyframes vlsBwFlowB{0%,32%{transform:translateX(-7px);opacity:0}48%,72%{transform:none;opacity:1}86%,100%{transform:translateX(5px);opacity:0}}
@keyframes vlsBwThroat{0%,30%,100%{transform:scaleY(1)}48%,76%{transform:scaleY(.62)}}
@keyframes vlsBwSmall{0%,42%{transform:scale(1)}58%,100%{transform:scale(.82)}}
${rmBlock(
  ["vls-bw-flow-a", "vls-bw-flow-b", "vls-bw-throat", "vls-bw-small"],
  [
    [".vls-bw-flow-a,.vls-bw-flow-b", "opacity:1;transform:none"],
    [".vls-bw-throat", "transform:scaleY(.62)"],
    [".vls-bw-small", "transform:scale(.82)"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} result />
      <Floor x1={18} x2={142} />
      <Floor x1={178} x2={302} />
      <Pawn x={28} yb={76} s={7} eyes />
      <path d="M45 48H90" stroke={SKY} strokeWidth={8} strokeLinecap="round" />
      <g className="vls-bw-flow-a" fill={MINT}>
        <circle cx={55} cy={48} r={3.5} />
        <circle cx={68} cy={48} r={3.5} />
        <circle cx={81} cy={48} r={3.5} />
      </g>
      <MiniTv x={94} y={34} w={44} h={26} />
      <path
        className="vls-bw-throat"
        d="M181 38H208L226 45V53L208 60H181"
        fill="none"
        stroke={WARN}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      <path d="M226 49H250" stroke={WARN} strokeWidth={4} strokeLinecap="round" />
      <g className="vls-bw-flow-b" fill={STAR_GOLD}>
        <circle cx={192} cy={49} r={3.2} />
        <circle cx={207} cy={49} r={3.2} />
        <circle cx={239} cy={49} r={2.6} />
      </g>
      <g className="vls-bw-small">
        <MiniTv x={254} y={41} w={34} h={20} />
      </g>
      <Pawn x={298} yb={76} s={6.5} eyes />
    </>
  );
}

/** Native CPU adaptation: frames queue at the encoder, one falls away, and
 * the delivered picture shrinks. */
function SceneEncoderLimited({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-en-frame-a{animation:vlsEnFlow var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-en-frame-b{animation:vlsEnFlow var(--comic-duration,3.2s) ease-in-out .3s var(--comic-repeat,1) both}
.vls-en-drop{transform-box:fill-box;transform-origin:center;animation:vlsEnDrop var(--comic-duration,3.2s) ease-in var(--comic-repeat,1) both}
.vls-en-heat{animation:vlsEnHeat var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-en-small{transform-box:fill-box;transform-origin:center;animation:vlsEnSmall var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsEnFlow{0%,12%{transform:translateX(-7px);opacity:0}28%,60%{transform:none;opacity:1}76%,100%{transform:translateX(8px);opacity:0}}
@keyframes vlsEnDrop{0%,42%{transform:none;opacity:1}64%,100%{transform:translateY(16px) rotate(12deg);opacity:0}}
@keyframes vlsEnHeat{0%,34%{transform:translateY(3px);opacity:0}48%,72%{transform:none;opacity:1}86%,100%{opacity:0}}
@keyframes vlsEnSmall{0%,46%{transform:scale(1)}62%,100%{transform:scale(.82)}}
${rmBlock(
  ["vls-en-frame-a", "vls-en-frame-b", "vls-en-drop", "vls-en-heat", "vls-en-small"],
  [
    [".vls-en-frame-a,.vls-en-frame-b,.vls-en-heat", "opacity:1;transform:none"],
    [".vls-en-drop", "opacity:0;transform:translateY(16px)"],
    [".vls-en-small", "transform:scale(.82)"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} result />
      <Floor x1={18} x2={142} />
      <Floor x1={178} x2={302} />
      <Pawn x={27} yb={76} s={6.5} eyes />
      <g fill="none" stroke={SKY} strokeWidth={2.5}>
        <rect x={52} y={34} width={36} height={28} rx={5} />
        <path d="M58 30v4m8-4v4m8-4v4m8-4v4M58 62v4m8-4v4m8-4v4m8-4v4" />
      </g>
      <g className="vls-en-frame-a" fill={MINT}>
        <rect x={96} y={38} width={8} height={8} rx={1.5} />
        <rect x={108} y={38} width={8} height={8} rx={1.5} />
      </g>
      <MiniTv x={119} y={37} w={28} h={17} />
      <g fill="none" stroke={WARN} strokeWidth={2.5}>
        <rect x={184} y={34} width={38} height={28} rx={5} />
        <path d="M190 30v4m8-4v4m8-4v4m8-4v4M190 62v4m8-4v4m8-4v4m8-4v4" />
      </g>
      <g className="vls-en-heat" stroke={WARN} strokeWidth={2} strokeLinecap="round">
        <path d="M191 26l-3-6m13 6v-7m10 7l4-6" />
      </g>
      <g className="vls-en-frame-b" fill={STAR_GOLD}>
        <rect x={229} y={35} width={8} height={8} rx={1.5} />
        <rect x={241} y={35} width={8} height={8} rx={1.5} />
      </g>
      <g className="vls-en-drop">
        <rect x={241} y={49} width={8} height={8} rx={1.5} fill={DANGER} />
        <RedX cx={245} cy={53} arm={3} />
      </g>
      <g className="vls-en-small">
        <MiniTv x={258} y={41} w={34} h={20} />
      </g>
      <Pawn x={301} yb={76} s={6} eyes />
    </>
  );
}

/** Generic warning: 1 wide panel. Persistent condition: the you-pawn
 * stands beside the big Hearth coal-bowl warning glyph; heat-rays rise in a
 * staggered 0-55% window, the pawn blinks at 70%, rest >=50%. */
function SceneWarning({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-wn-ray1{animation:vlsWnRay var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-wn-ray2{animation:vlsWnRay var(--comic-duration,3.2s) ease-out .25s var(--comic-repeat,1) both}
.vls-wn-ray3{animation:vlsWnRay var(--comic-duration,3.2s) ease-out .5s var(--comic-repeat,1) both}
.vls-wn-eyes{transform-box:fill-box;transform-origin:center;animation:vlsWnBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsWnRay{0%{opacity:0;transform:translateY(3px)}9%{opacity:1}24%{transform:translateY(-2px)}50%,100%{transform:translateY(-2px);opacity:1}}
@keyframes vlsWnBlink{0%,66%,74%,100%{transform:scaleY(1)}70%{transform:scaleY(.12)}}
${rmBlock(
  ["vls-wn-ray1", "vls-wn-ray2", "vls-wn-ray3", "vls-wn-eyes"],
  [[".vls-wn-ray1,.vls-wn-ray2,.vls-wn-ray3", "opacity:1;transform:none"]],
)}
`}</style>
      <Frame x={4} w={312} theme={theme} result />
      <Floor x1={24} x2={296} />
      <Pawn x={96} yb={76} s={11} eyes gaze={2} eyeClassName="vls-wn-eyes" />
      {/* Hearth warning glyph x3.5 (~54% panel height), bowl feet on the floor:
          M6 13a6 6 0 0 0 12 0 + rays M12 9V5.5 / M8.5 9.5 7 7.5 / M15.5 9.5 17 7.5,
          baked at origin (168, 9.5). */}
      <path
        d="M189 55 a21 21 0 0 0 42 0"
        stroke="var(--comic-tone, var(--warn))"
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
      />
      <g stroke="var(--comic-tone, var(--warn))" strokeWidth={2.5} strokeLinecap="round" fill="none">
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
  "signal-connecting": (p) => <SceneSignal {...p} state="connecting" />,
  "signal-recovering": (p) => <SceneSignal {...p} state="recovering" />,
  "signal-offline": (p) => <SceneSignal {...p} state="offline" />,
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
  "bandwidth-limited": SceneBandwidthLimited,
  "encoder-limited": SceneEncoderLimited,
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
  tone,
  motion,
}: {
  kind: ComicKind;
  size?: number;
  theme?: ComicTheme;
  tone?: ComicTone;
  motion?: ComicMotion;
}) {
  const resolvedTheme = theme ?? DEFAULT_THEME[kind];
  const presentation = getComicPresentation(kind);
  const resolvedTone = tone ?? presentation.tone;
  const resolvedMotion = motion ?? presentation.motion;
  const style = {
    ...comicStyle(resolvedTone, resolvedMotion),
    "--comic-neutral": resolvedTheme === "paper" ? "var(--ink)" : "#48597a",
    width: size != null ? `${size}px` : "min(320px, 86%)",
    height: "auto",
    display: "block",
  } as CSSProperties;
  return (
    <svg
      viewBox="0 0 320 96"
      style={style}
      data-comic-tone={resolvedTone}
      data-comic-motion={resolvedMotion}
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {SCENES[kind]({ theme: resolvedTheme })}
    </svg>
  );
});
