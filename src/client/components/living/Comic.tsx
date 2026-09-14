// Panel comics (四宫格漫画): pictorial state strips that carry meaning with no
// human language. Each
// scene has its own vls- prefixed keyframes. Shared presentation owns tone,
// duration and repetition; settled states and reduced motion share informative
// poses. SSR-safe: pure static markup, no hooks.

import { memo, type CSSProperties, type ReactNode } from "react";
import { HostMark } from "./HostMark";
import { Glyph } from "../../ui/icons";
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
  "signal-connected": "paper",
  "signal-failed": "paper",
  "media-playing": "stage",
  "media-ready": "paper",
  "share-live": "stage",
  "share-ended": "stage",
  "room-closed": "paper",
  "room-code-invalid": "paper",
  "page-refresh": "paper",
  "site-access": "paper",
  "source-switching": "stage",
  "source-starting": "stage",
  "preview-paused": "stage",
  "update-available": "paper",
  "debug-start": "paper",
  "debug-export-failed": "paper",
  "copy-failed": "paper",
  "source-failed": "stage",
  "settings-failed": "paper",
  "name-invalid": "paper",
  "transport-connected": "paper",
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
export const YOU = "var(--you)";
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
  const inner = <g transform={`translate(${r2(x - 24 * scale)} ${r2(yb - 50 * scale)}) scale(${scale})`} fill={color}
    style={{ "--comic-blink-delay": `${Math.round(x * .8)}ms` } as CSSProperties}>
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

/** Invitation URL: the same 24-unit chain as the link control icon. */
export function InviteLink({ x, y, size = 24, className }: {
  x: number; y: number; size?: number; className?: string;
}) {
  return <g className={className}>
    <g transform={`translate(${x} ${y})`} color="var(--ink)">
      <Glyph name="link" size={size} />
    </g>
  </g>;
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

/** Hold operation results in settled scenes; decorative subject motion may opt
 * out. System and preview reduced motion always use the explicit final pose. */
export function rmBlock(kills: string[], pins: Array<readonly [string, string]>, holdOnStill = true): string {
  const rules = [...kills.map((c) => [`.${c}`, "animation:none"] as const), ...pins];
  const block = (scope: string) => rules.map(([selectors, styles]) =>
    `${selectors.split(",").map((selector) => scope + selector.trim()).join(",")}{${styles}}`,
  ).join("");
  return `${holdOnStill ? block('svg[data-comic-motion="still"] ') : ""}${block('[data-comic-reduced-motion] ')}@media (prefers-reduced-motion:reduce){${block("")}}`;
}

/* ------------------------------ scenes ------------------------------ */

/** 1. waiting-for-host: 1 wide panel. */
function SceneWaiting({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-wf-z1{animation:vlsWfZNear var(--comic-duration,3.2s) ease-out 1 both}
.vls-wf-z2{animation:vlsWfZFar var(--comic-duration,3.2s) ease-out 1 both}
@keyframes vlsWfZNear{0%{opacity:.85;transform:translate(-5px,10px)}42%,100%{opacity:.65;transform:none}}
@keyframes vlsWfZFar{0%,6%{opacity:.75;transform:translate(-12px,14px)}48%,100%{opacity:.55;transform:none}}
${rmBlock(
  ["vls-wf-z1", "vls-wf-z2"],
  [[".vls-wf-z1", "opacity:.65;transform:none"], [".vls-wf-z2", "opacity:.55;transform:none"]],
  false,
)}
`}</style>
      <Frame x={4} w={312} theme={theme} result />
      <Floor x1={24} x2={296} />
      <Pawn x={69} yb={76} s={11} eyes gaze={2} />
      <MiniTv x={206} y={28} w={64} h={42} />
      <Moon x={229} y={48} />
      <g stroke={LINE} strokeWidth={2.5} strokeLinecap="round" fill="none">
        <path className="vls-wf-z1" opacity={0.65} d="M246 40h8l-8 6h8" />
        <g className="vls-wf-z2" opacity={0.55}>
          <path d="M258 28h9l-9 7h9" />
          <path d="M273 14h10l-10 8h10" />
        </g>
      </g>
      <circle cx={238} cy={76} r={3.5} fill={WARN} />
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
function SceneSignal({ theme, state, peer = false }: {
  theme: ComicTheme;
  state: "connecting" | "recovering" | "offline" | "connected" | "failed";
  peer?: boolean;
}) {
  const color = "var(--comic-tone, var(--ink))";
  return (
    <>
      <style>{`
.vls-signal-message{animation:vlsSignalMessage var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-signal-retry{transform-box:fill-box;transform-origin:center;animation:vlsSignalRetry var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-signal-result{transform-box:fill-box;transform-origin:center;animation:vlsSignalResult var(--comic-duration,3.2s) ease-out 1 both}
@keyframes vlsSignalMessage{0%{transform:translateX(0);opacity:0}8%{opacity:1}40%{transform:translateX(82px);opacity:1}55%,100%{transform:translateX(82px);opacity:0}}
@keyframes vlsSignalRetry{0%{transform:rotate(0)}55%,100%{transform:rotate(360deg)}}
@keyframes vlsSignalResult{0%,8%,42%,100%{transform:none}20%{transform:scale(.9)}30%{transform:scale(1.04)}}
${rmBlock(["vls-signal-message", "vls-signal-retry"], [
  [".vls-signal-message", "opacity:1;transform:translateX(41px)"],
  [".vls-signal-retry", "transform:none"],
])}
${rmBlock(["vls-signal-result"], [[".vls-signal-result", "transform:none"]], false)}
`}</style>
      <Frame x={4} w={312} theme={theme} result />
      <BrowserWindow x={24} y={23} w={96} h={50}>
        <circle cx={37} cy={43} r={3} fill={color} />
        <path d="M47 43h56 M34 55h36 M77 55h26 M34 64h69" stroke={LINE} strokeWidth={2} strokeLinecap="round" />
      </BrowserWindow>
      {peer ? <BrowserWindow x={251} y={25} w={47} h={46} /> : <ServerBox x={254} y={25} w={42} h={46} />}
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
      ) : state === "connected" ? (
        <path className="vls-signal-result" d="M174 48l7 7 14-17" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : state === "failed" ? (
        <RedX cx={184} cy={48} arm={8} className="vls-signal-result" />
      ) : (
        <g className="vls-signal-result" stroke={color} strokeWidth={2.5} strokeLinecap="round" fill="none">
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
@keyframes vlsHpSteam{0%{transform:translateY(2px);opacity:.4}20%{opacity:.9}45%,100%{transform:translateY(-2px);opacity:.55}}
${rmBlock(
  ["vls-hp-bars", "vls-hp-led", "vls-hp-eyes", "vls-hp-steam2"],
  [
    [".vls-hp-bars,.vls-hp-led", "opacity:1"],
    [".vls-hp-steam2", "opacity:0"],
  ],
)}
${rmBlock(["vls-hp-steam1"], [[".vls-hp-steam1", "opacity:.55;transform:translateY(-2px)"]], false)}
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
      <Pawn x={216} yb={78} s={14} eyes host eyeClassName="vls-hp-eyes" />
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
.vls-rf-sweat{animation:vlsRfSweat var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsRfIn{from{opacity:0;transform:translateY(6px) scale(.9)}}
@keyframes vlsRfMarch{from{stroke-dashoffset:0}to{stroke-dashoffset:-16}}
@keyframes vlsRfX{from{opacity:0;transform:scale(1.5)}to{opacity:1;transform:scale(1)}}
@keyframes vlsRfSweat{0%,50%,100%{opacity:.7;transform:translateY(0)}24%{opacity:1;transform:translateY(3px)}}
${rmBlock(
  ["vls-rf-panel", "vls-rf-march", "vls-rf-x"],
  [
    [".vls-rf-x", "opacity:1;transform:none"],
  ],
)}
${rmBlock(["vls-rf-sweat"], [[".vls-rf-sweat", "opacity:.7;transform:none"]], false)}
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
  ["vls-pf-s2", "vls-pf-rip", "vls-pf-pawn", "vls-pf-ring"],
  [
    [".vls-pf-s2,.vls-pf-rip", "opacity:.35;transform:none"],
    [".vls-pf-ring", "opacity:1"],
  ],
)}
${rmBlock(["vls-pf-s1"], [[".vls-pf-s1", "opacity:.5;transform:none"]], false)}
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
@keyframes vlsHoSway{0%{transform:rotate(-3deg)}14%{transform:rotate(3deg)}28%{transform:rotate(-2deg)}42%,100%{transform:rotate(0)}}
@keyframes vlsHoWave{0%,10%{transform:rotate(0)}14%{transform:rotate(-8deg)}18%{transform:rotate(8deg)}22%{transform:rotate(-8deg)}26%{transform:rotate(8deg)}30%,100%{transform:rotate(0)}}
@keyframes vlsHoBadge{0%,30%{opacity:.2}40%{opacity:.7}50%,100%{opacity:.2}}
${rmBlock(
  ["vls-ho-pawn", "vls-ho-badge"],
  [[".vls-ho-badge", "opacity:.5"]],
)}
${rmBlock(["vls-ho-plug"], [[".vls-ho-plug", "transform:none"]], false)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} result />
      <MiniTv x={30} y={22} w={70} h={44} />
      <rect x={36} y={28} width={58} height={30} rx={4} fill="#0a101c" />
      <path d="M65 66 c0 4 -4 6 -8 7" stroke={TV_EDGE} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <Plug x={57} y={73} className="vls-ho-plug" />
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
@keyframes vlsNaShake{0%,10%,42%,100%{transform:rotate(0)}16%{transform:rotate(-2.5deg)}22%{transform:rotate(2.5deg)}28%{transform:rotate(-1.8deg)}34%{transform:rotate(1.8deg)}}
${rmBlock(
  ["vls-na-flick", "vls-na-a1", "vls-na-a2", "vls-na-a3", "vls-na-arm", "vls-na-slash"],
  [
    [".vls-na-flick", "opacity:.5"],
    [".vls-na-a1,.vls-na-a2,.vls-na-a3", "opacity:.8"],
    [".vls-na-slash", "opacity:1;transform:none"],
    [".vls-na-arm", "transform:none"],
  ],
)}
${rmBlock(["vls-na-pawn"], [[".vls-na-pawn", "transform:none"]], false)}
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
          arcs arrive dashed and carry an unavailable mark; the pawn raises
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
        stroke="var(--comic-tone)"
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
  ["vls-rn-kn", "vls-rn-solid", "vls-rn-ghost", "vls-rn-puff"],
  [[".vls-rn-solid", "opacity:0"], [".vls-rn-ghost", "opacity:.9"], [".vls-rn-puff,.vls-rn-kn", "opacity:0"]],
)}
${rmBlock(["vls-rn-knock"], [[".vls-rn-knock", "transform:none"]], false)}
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
${rmBlock(["vls-ad-x"], [[".vls-ad-x", "opacity:1;transform:scale(1) rotate(8deg)"]])}
${rmBlock(["vls-ad-door"], [[".vls-ad-door", "transform:none"]], false)}
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

/** 13. invalid-invite: this invitation URL cannot admit the viewer. */
function SceneInvalidInvite({ theme }: { theme: ComicTheme }) {
  return (
    <>
      <style>{`
.vls-ii-link{animation:vlsIiLink var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsIiLink{0%,8%,36%,100%{transform:none}17%{transform:translateX(-4px)}26%{transform:translateX(3px)}}
${rmBlock(["vls-ii-link"], [[".vls-ii-link", "transform:none"]], false)}
`}</style>
      <Frame x={4} w={312} theme={theme} result />
      <Pawn x={53} yb={81} s={15} eyes gaze={2} />
      <BrowserWindow x={94} y={15} w={200} h={65}>
        <rect x={106} y={33} width={176} height={35} rx={5} fill="var(--wall-2)" stroke={FAINT} strokeWidth={1.5} />
        <InviteLink x={114} y={34} size={32} className="vls-ii-link" />
        <path d="M160 44h69m-69 12h52" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
        <RedX cx={264} cy={51} arm={8} />
      </BrowserWindow>
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
  ["vls-fl-c1", "vls-fl-c2", "vls-fl-c3", "vls-fl-c5", "vls-fl-c6", "vls-fl-c7", "vls-fl-you", "vls-fl-ghost"],
  [[".vls-fl-ghost", "opacity:0"]],
)}
${rmBlock(["vls-fl-c4"], [[".vls-fl-c4", "transform:none"]], false)}
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
@keyframes vlsBwFlowA{0%,8%{transform:translateX(-6px);opacity:.45}36%,100%{transform:none;opacity:1}}
@keyframes vlsBwFlowB{0%,18%{transform:translateX(-5px);opacity:.45}46%,100%{transform:none;opacity:1}}
@keyframes vlsBwThroat{0%,30%,100%{transform:scaleY(1)}48%,76%{transform:scaleY(.62)}}
@keyframes vlsBwSmall{0%,42%{transform:scale(1)}58%,100%{transform:scale(.82)}}
${rmBlock(
  ["vls-bw-throat", "vls-bw-small"],
  [
    [".vls-bw-throat", "transform:scaleY(.62)"],
    [".vls-bw-small", "transform:scale(.82)"],
  ],
)}
${rmBlock(["vls-bw-flow-a", "vls-bw-flow-b"], [[".vls-bw-flow-a,.vls-bw-flow-b", "opacity:1;transform:none"]], false)}
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
@keyframes vlsEnHeat{0%,8%{transform:translateY(3px);opacity:.4}36%,100%{transform:none;opacity:1}}
@keyframes vlsEnSmall{0%,46%{transform:scale(1)}62%,100%{transform:scale(.82)}}
${rmBlock(
  ["vls-en-frame-a", "vls-en-frame-b", "vls-en-drop", "vls-en-small"],
  [
    [".vls-en-frame-a,.vls-en-frame-b", "opacity:1;transform:none"],
    [".vls-en-drop", "opacity:0;transform:translateY(16px)"],
    [".vls-en-small", "transform:scale(.82)"],
  ],
)}
${rmBlock(["vls-en-heat"], [[".vls-en-heat", "opacity:1;transform:none"]], false)}
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
  ["vls-wn-ray1", "vls-wn-ray3", "vls-wn-eyes"],
  [[".vls-wn-ray1,.vls-wn-ray3", "opacity:1;transform:none"]],
)}
${rmBlock(["vls-wn-ray2"], [[".vls-wn-ray2", "opacity:1;transform:translateY(-2px)"]], false)}
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

function SceneMediaStatus({ theme, state }: {
  theme: ComicTheme; state: "playing" | "ready" | "sharing" | "ended" | "preview-paused";
}) {
  const preview = state === "preview-paused";
  const colour = "var(--comic-tone, var(--ink))";
  return <>
    <style>{`
.vls-media-watcher{transform-origin:54px 77px;animation:vlsMediaWatch var(--comic-duration,3.2s) ease-in-out 1 both}
.vls-media-ended{animation-name:vlsMediaRest}
@keyframes vlsMediaWatch{0%{transform:none}18%{transform:translateX(3px) rotate(4deg)}42%,100%{transform:none}}
@keyframes vlsMediaRest{0%{transform:translateX(5px) rotate(3deg)}28%,100%{transform:none}}
${rmBlock(["vls-media-watcher"], [], false)}
`}</style>
    <Frame x={4} w={312} theme={theme} result />
    <Floor x1={24} x2={296} />
    <Pawn x={54} yb={77} s={13} eyes host={state === "sharing" || state === "ended" || preview} gaze={2}
      className={`vls-media-watcher${state === "ended" ? " vls-media-ended" : ""}`} />
    {preview ? <>
      <BrowserWindow x={92} y={18} w={106} h={60}>
        <MiniTv x={115} y={38} w={60} h={30} />
        <path d="M137 44v13m8-13v13" stroke={colour} strokeWidth={4} />
      </BrowserWindow>
      <path d="M207 49h17m-6-6 6 6-6 6" stroke={LINE} strokeWidth={2} fill="none" />
      <MiniTv x={234} y={32} w={59} h={35} />
      <path d="m258 41 13 8-13 8Z" fill={LIVE} />
    </> : <>
      <MiniTv x={130} y={21} w={124} h={53} />
      {state === "ready"
        ? <path d="m175 47 12 11 24-26" stroke={colour} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        : state === "ended"
          ? <rect x={182} y={36} width={23} height={23} rx={3} fill={INK_STAGE} />
          : <path d="m183 32 27 16-27 16Z" fill={colour} />}
    </>}
  </>;
}

function SceneRoomEntry({ theme, state }: {
  theme: ComicTheme; state: "closed" | "invalid" | "password";
}) {
  const colour = "var(--comic-tone, var(--ink))";
  return <>
    <style>{`
.vls-entry-closed{transform-origin:51px 76px;animation:vlsEntryStepBack var(--comic-duration,3.2s) ease-in-out 1 both}
.vls-entry-invalid{animation:vlsEntryRefuse var(--comic-duration,3.2s) ease-in-out 1 both}
.vls-entry-key{transform-origin:215px 53px;animation:vlsEntryKey var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsEntryStepBack{0%{transform:translateX(6px) rotate(4deg)}30%,100%{transform:none}}
@keyframes vlsEntryRefuse{0%{transform:none}10%{transform:translateX(-3px)}18%{transform:translateX(3px)}26%,100%{transform:none}}
@keyframes vlsEntryKey{0%{transform:translateX(10px) rotate(8deg)}32%,100%{transform:none}}
${rmBlock(["vls-entry-closed", "vls-entry-invalid", "vls-entry-key"], [], false)}
`}</style>
    <Frame x={4} w={312} theme={theme} result />
    <Floor x1={24} x2={296} />
    <Pawn x={51} yb={76} s={12} eyes gaze={2} className={state === "closed" ? "vls-entry-closed" : undefined} />
    {state === "password" ? <BrowserWindow x={95} y={15} w={195} h={62}>
      <rect x={154} y={44} width={30} height={24} rx={4} fill="var(--paper)" stroke={colour} strokeWidth={2.5} />
      <path d="M161 44v-8a8 8 0 0 1 16 0v8" stroke={colour} strokeWidth={2.5} fill="none" />
      <g className="vls-entry-key">
        <circle cx={215} cy={53} r={7} stroke={colour} strokeWidth={2.5} fill="none" />
        <path d="M222 53h22m-5 0v6m-8-6v4" stroke={colour} strokeWidth={2.5} fill="none" />
      </g>
    </BrowserWindow> : state === "invalid" ? <>
      <g className="vls-entry-invalid">{[104, 133, 162, 191].map((x, index) => <g key={x}>
        <rect x={x} y={34} width={22} height={29} rx={4} fill="var(--paper)" stroke={index === 3 ? colour : LINE} strokeWidth={2} />
        {index < 3 && <circle cx={x + 11} cy={48} r={3} fill={LINE} />}
      </g>)}</g>
      <RedX cx={251} cy={48} arm={10} />
    </> : <>
      <Door x={166} y={18} />
      <path d="M208 31h51" stroke={colour} strokeWidth={3} />
      <rect x={221} y={41} width={24} height={24} rx={3} fill={colour} />
    </>}
  </>;
}

function SceneBrowserAction({ theme, action }: {
  theme: ComicTheme; action: "refresh" | "update" | "debug" | "export-failed" | "copy-failed" | "settings-failed";
}) {
  const colour = "var(--comic-tone, var(--ink))";
  return <>
    <style>{`
.vls-browser-refresh{transform-origin:235px 55px;animation:vlsBrowserRefresh var(--comic-duration,3.2s) ease-in-out 1 both}
.vls-browser-update,.vls-browser-debug{animation:vlsBrowserLift var(--comic-duration,3.2s) ease-in-out 1 both}
.vls-browser-export-failed,.vls-browser-copy-failed,.vls-browser-settings-failed{animation:vlsBrowserRefuse var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsBrowserRefresh{0%{transform:rotate(-360deg) scale(.72)}32%{transform:rotate(-30deg) scale(.72)}44%,100%{transform:none}}
@keyframes vlsBrowserLift{0%{transform:translateY(6px)}18%{transform:translateY(-2px)}34%,100%{transform:none}}
@keyframes vlsBrowserRefuse{0%{transform:none}10%{transform:translateX(-3px)}18%{transform:translateX(3px)}26%,100%{transform:none}}
${rmBlock(["vls-browser-refresh", "vls-browser-update", "vls-browser-debug", "vls-browser-export-failed", "vls-browser-copy-failed", "vls-browser-settings-failed"], [], false)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <BrowserWindow x={18} y={20} w={113} h={58}>
      {action === "settings-failed" ? <>
        <path d="M35 44h68M35 55h68M35 66h68" stroke={LINE} strokeWidth={2.5} />
        <g fill="var(--paper)" stroke={LINE} strokeWidth={2.5}>
          <circle cx={54} cy={44} r={4} /><circle cx={82} cy={55} r={4} /><circle cx={65} cy={66} r={4} />
        </g>
      </> : action === "debug" || action === "export-failed"
        ? <path d="M37 63V51m17 12V41m17 22V48m17 15V37" stroke={LINE} strokeWidth={7} strokeLinecap="round" />
        : <path d="M33 44h63M33 55h47M33 66h63" stroke={LINE} strokeWidth={3} strokeLinecap="round" />}
    </BrowserWindow>
    {action === "settings-failed" ? <BrowserWindow x={179} y={20} w={113} h={58}>
      <path d="M197 44h67M197 55h67M197 66h67" stroke={LINE} strokeWidth={2.5} />
      <g className="vls-browser-settings-failed" fill="var(--paper)" stroke={LINE} strokeWidth={2.5}>
        <circle cx={216} cy={44} r={4} /><circle cx={244} cy={55} r={4} /><circle cx={227} cy={66} r={4} />
      </g>
      <RedX cx={280} cy={69} arm={9} />
    </BrowserWindow> : action === "refresh" || action === "debug" ? <BrowserWindow x={179} y={20} w={113} h={58}>
      {action === "refresh" ? <path className="vls-browser-refresh" d="M218 44a18 18 0 1 1-1 20m1-20h14m-14 0V31" stroke={colour} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" /> : <>
        <path className="vls-browser-debug" d="M193 64V53m15 11V44m15 20V50" stroke={LINE} strokeWidth={6} strokeLinecap="round" />
        <circle cx={262} cy={52} r={11} fill="none" stroke={colour} strokeWidth={2.5} />
        <circle cx={262} cy={52} r={5} fill={colour} />
      </>}
    </BrowserWindow> : <>
      <rect x={199} y={27} width={48} height={50} rx={5} fill="var(--paper)" stroke={LINE} strokeWidth={2.5} />
      <g className={`vls-browser-${action}`}>
        <rect x={217} y={15} width={48} height={50} rx={5} fill="var(--paper)" stroke={colour} strokeWidth={2.5} />
        <path d="M226 31h28M226 42h20M226 53h28" stroke={LINE} strokeWidth={2.5} strokeLinecap="round" />
      </g>
      {action === "update"
        ? <path d="M283 72V35m-8 8 8-8 8 8" stroke={colour} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        : <RedX cx={273} cy={70} arm={10} />}
    </>}
  </>;
}

function SceneSourceSwitching({ theme, state = "switching" }: {
  theme: ComicTheme; state?: "switching" | "starting" | "failed";
}) {
  return <>
    <style>{`
.vls-source-switch{animation:vlsSourceSwitch var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-source-return{animation-name:vlsSourceReturn}
.vls-source-host{transform-origin:39px 76px;animation:vlsSourceHost var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsSourceSwitch{0%{transform:translateX(-5px);opacity:.55}25%{transform:translateX(5px);opacity:1}45%,100%{transform:none;opacity:1}}
@keyframes vlsSourceReturn{0%{transform:translateX(5px);opacity:.55}25%{transform:translateX(-5px);opacity:1}45%,100%{transform:none;opacity:1}}
@keyframes vlsSourceHost{0%{transform:translateX(4px) rotate(4deg)}30%,100%{transform:none}}
${rmBlock(["vls-source-switch"], [[".vls-source-switch", "opacity:1"]])}
${rmBlock(["vls-source-host"], [], false)}
`}</style>
    <Frame x={4} w={312} theme={theme} result />
    <Pawn x={39} yb={76} s={10} eyes host gaze={2} className={state === "failed" ? "vls-source-host" : undefined} />
    <BrowserWindow x={75} y={24} w={71} h={47}>
      <path d="M87 61l18-23 11 14 8-8 12 17Z" fill={SKY} />
    </BrowserWindow>
    {state === "switching" ? <BrowserWindow x={225} y={24} w={71} h={47}>
      <circle cx={260} cy={50} r={11} fill={SKY} />
    </BrowserWindow> : <MiniTv x={225} y={26} w={71} h={43} />}
    {state === "failed" ? <RedX cx={185} cy={51} arm={11} /> : <g stroke="var(--comic-tone, var(--action))" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path className="vls-source-switch" d={state === "switching" ? "M158 42h51m-9-8 9 8-9 8" : "M158 51h51m-9-8 9 8-9 8"} />
      {state === "switching" && <path className="vls-source-switch vls-source-return" d="M209 61h-51m9-8-9 8 9 8" />}
    </g>}
  </>;
}

function SceneNameInvalid({ theme }: { theme: ComicTheme }) {
  return <>
    <style>{`
.vls-name-card{animation:vlsNameRefuse var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsNameRefuse{0%{transform:none}10%{transform:translateX(-3px)}18%{transform:translateX(3px)}26%,100%{transform:none}}
${rmBlock(["vls-name-card"], [], false)}
`}</style>
    <Frame x={4} w={312} theme={theme} result />
    <Pawn x={71} yb={76} s={16} eyes gaze={2} />
    <g className="vls-name-card">
      <rect x={125} y={27} width={136} height={39} rx={10} fill="var(--paper)" stroke={LINE} strokeWidth={2.5} />
      <path d="M142 40h66M142 52h47" stroke={LINE} strokeWidth={3} strokeLinecap="round" />
    </g>
    <RedX cx={246} cy={64} arm={10} />
  </>;
}

/* ------------------------------ component ------------------------------ */
const SCENES: Record<ComicKind, (props: { theme: ComicTheme }) => ReactNode> = {
  "waiting-for-host": SceneWaiting,
  "connecting-p2p": (p) => <SceneConnecting {...p} sfu={false} />,
  "connecting-sfu": (p) => <SceneConnecting {...p} sfu />,
  "signal-connecting": (p) => <SceneSignal {...p} state="connecting" />,
  "signal-recovering": (p) => <SceneSignal {...p} state="recovering" />,
  "signal-offline": (p) => <SceneSignal {...p} state="offline" />,
  "signal-connected": (p) => <SceneSignal {...p} state="connected" />,
  "transport-connected": (p) => <SceneSignal {...p} state="connected" peer />,
  "signal-failed": (p) => <SceneSignal {...p} state="failed" />,
  "media-playing": (p) => <SceneMediaStatus {...p} state="playing" />,
  "media-ready": (p) => <SceneMediaStatus {...p} state="ready" />,
  "share-live": (p) => <SceneMediaStatus {...p} state="sharing" />,
  "share-ended": (p) => <SceneMediaStatus {...p} state="ended" />,
  "preview-paused": (p) => <SceneMediaStatus {...p} state="preview-paused" />,
  "room-closed": (p) => <SceneRoomEntry {...p} state="closed" />,
  "room-code-invalid": (p) => <SceneRoomEntry {...p} state="invalid" />,
  "site-access": (p) => <SceneRoomEntry {...p} state="password" />,
  "page-refresh": (p) => <SceneBrowserAction {...p} action="refresh" />,
  "update-available": (p) => <SceneBrowserAction {...p} action="update" />,
  "debug-start": (p) => <SceneBrowserAction {...p} action="debug" />,
  "debug-export-failed": (p) => <SceneBrowserAction {...p} action="export-failed" />,
  "copy-failed": (p) => <SceneBrowserAction {...p} action="copy-failed" />,
  "source-switching": SceneSourceSwitching,
  "source-starting": (p) => <SceneSourceSwitching {...p} state="starting" />,
  "source-failed": (p) => <SceneSourceSwitching {...p} state="failed" />,
  "settings-failed": (p) => <SceneBrowserAction {...p} action="settings-failed" />,
  "name-invalid": SceneNameInvalid,
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
      key={kind}
      viewBox="0 0 320 96"
      style={style}
      data-comic-tone={resolvedTone}
      data-comic-motion={resolvedMotion}
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g className="lr-comic-content">{SCENES[kind]({ theme: resolvedTheme })}</g>
    </svg>
  );
});
