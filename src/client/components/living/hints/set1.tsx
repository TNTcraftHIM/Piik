// Hint set 1 — sharing lifecycle: start/stop/pause/resume/source/fullscreen/reconnect.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
import {
  BrowserWindow,
  FAINT,
  Floor,
  Frame,
  INK_STAGE,
  LIVE,
  MINT,
  MiniTv,
  Moon,
  Pawn,
  Plug,
  SKY,
  Socket,
  Spark,
  Star,
  TV_EDGE,
  TV_SCREEN,
  WARN,
  rmBlock,
} from "../Comic";
import type { HintScene, Set1Kind } from "../../../ui/visual-kinds";
import { Glyph } from "../../../ui/icons";

function SourceWindow({ x, y, alternate = false }: { x: number; y: number; alternate?: boolean }) {
  return <>
    <rect x={x} y={y} width={46} height={32} rx={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    <path d={`M${x} ${y + 7}h46 M${x + 38} ${y + 2}l3 3m0-3-3 3`} stroke="var(--ink)" strokeWidth={1.5} fill="none" />
    {alternate
      ? <circle cx={x + 23} cy={y + 20} r={7} fill={WARN} />
      : <path d={`M${x + 8} ${y + 27}l10-14 7 8 5-5 8 11Z`} fill={SKY} />}
  </>;
}

/* hint-share-start: [dark TV + pawn reaching toward it] → [TV bright, mint
   glow, rays + Star]. The after panel demonstrates one power-on beat
   (screen brightens → rays → star → pawn hop), then rests lit. */
const SceneShareStart: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-hs-reach{transform-box:fill-box;transform-origin:50% 100%;animation:vlsHsReach var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hs-intent{animation:vlsHsIntent var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hs-crt{transform-box:fill-box;transform-origin:center;animation:vlsHsCrt var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-hs-rays{animation:vlsHsRays var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-hs-star{transform-box:fill-box;transform-origin:center;animation:vlsHsStar var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
.vls-hs-hop{animation:vlsHsHop var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
@keyframes vlsHsReach{0%{transform:rotate(0)}10%{transform:rotate(7deg)}26%{transform:rotate(7deg)}40%,100%{transform:rotate(0)}}
@keyframes vlsHsIntent{0%{opacity:0}10%{opacity:.9}26%{opacity:.9}40%,100%{opacity:0}}
@keyframes vlsHsCrt{0%{transform:scaleY(.06);opacity:.5}12%,100%{transform:scaleY(1);opacity:1}}
@keyframes vlsHsRays{0%,8%{opacity:0;transform:translateY(2px)}18%,100%{opacity:1;transform:translateY(0)}}
@keyframes vlsHsStar{0%,18%{opacity:0;transform:scale(0)}26%{opacity:1;transform:scale(1.25)}33%,100%{opacity:1;transform:scale(1)}}
@keyframes vlsHsHop{0%,26%{transform:translateY(0)}33%{transform:translateY(-6px)}40%,100%{transform:translateY(0)}}
${rmBlock(
  ["vls-hs-reach", "vls-hs-intent", "vls-hs-crt", "vls-hs-rays", "vls-hs-star", "vls-hs-hop"],
  [
    [".vls-hs-crt,.vls-hs-rays,.vls-hs-star", "opacity:1;transform:none"],
    [".vls-hs-intent", "opacity:0"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <Floor x1={14} x2={146} y={78} />
    <MiniTv x={55} y={24} w={66} h={42} />
    <circle cx={88} cy={73} r={3} fill={TV_EDGE} />
    <g className="vls-hs-reach">
      <Pawn x={30} yb={78} s={9} eyes host gaze={2} />
    </g>
    <g className="vls-hs-intent" opacity={0} stroke={FAINT} strokeWidth={2.5} strokeLinecap="round">
      <path d="M43 45 l7 -5 M46 55 l8 -3" />
    </g>
    <Floor x1={174} x2={306} y={78} />
    <MiniTv x={207} y={24} w={66} h={42} />
    <g className="vls-hs-crt">
      <rect x={211.62} y={28.62} width={56.76} height={27.72} rx={4} fill={MINT} />
      <path d="M233 37 L247 42.5 L233 48 Z" fill="#101a2c" />
    </g>
    <g className="vls-hs-rays" stroke={MINT} strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M222 17 l-6 -7 M240 14 V6 M258 17 l6 -7" />
    </g>
    <Star x={272} y={15} r={7} className="vls-hs-star" />
    <circle cx={240} cy={73} r={3} fill={LIVE} />
    <g className="vls-hs-hop">
      <Pawn x={184} yb={78} s={9} eyes host />
    </g>
  </>
);

/* hint-share-stop: [bright TV, pawn watching] → [TV dims, chin LED out, small
   Moon, pawn content]. Calm power-down: dim + LED-out beat, moon settles. */
const SceneShareStop: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-hx-eyes{transform-box:fill-box;transform-origin:center;animation:vlsHxBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hx-dim{animation:vlsHxDim var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-hx-led{animation:vlsHxLed var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-hx-moon{animation:vlsHxMoon var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-hx-settle{animation:vlsHxSettle var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
@keyframes vlsHxBlink{0%,44%,52%,100%{transform:scaleY(1)}48%{transform:scaleY(.12)}}
@keyframes vlsHxDim{0%{opacity:0}14%,100%{opacity:1}}
@keyframes vlsHxLed{0%{opacity:1}14%,100%{opacity:0}}
@keyframes vlsHxMoon{0%,16%{opacity:0;transform:translateY(3px)}28%{opacity:1;transform:translateY(0)}38%{transform:translateY(-2px)}50%,100%{opacity:1;transform:translateY(0)}}
@keyframes vlsHxSettle{0%,48%{transform:translateY(0)}54%{transform:translateY(-2px)}60%,100%{transform:translateY(0)}}
${rmBlock(
  ["vls-hx-eyes", "vls-hx-dim", "vls-hx-led", "vls-hx-moon", "vls-hx-settle"],
  [
    [".vls-hx-dim", "opacity:1"],
    [".vls-hx-led", "opacity:0"],
    [".vls-hx-moon", "opacity:1;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <Floor x1={14} x2={146} y={78} />
    <MiniTv x={47} y={24} w={66} h={42} />
    <rect x={51.62} y={28.62} width={56.76} height={27.72} rx={4} fill={MINT} />
    <path d="M73 37 L87 42.5 L73 48 Z" fill="#101a2c" />
    <g stroke={MINT} strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M62 17 l-6 -7 M80 14 V6 M98 17 l6 -7" />
    </g>
    <circle cx={80} cy={73} r={3} fill={LIVE} />
    <Pawn x={24} yb={78} s={8} eyes host gaze={2} eyeClassName="vls-hx-eyes" />
    <Floor x1={174} x2={306} y={78} />
    <MiniTv x={207} y={24} w={66} h={42} />
    <rect className="vls-hx-dim" x={211.62} y={28.62} width={56.76} height={27.72} rx={4} fill="#0a101c" />
    <circle cx={240} cy={73} r={3} fill={TV_EDGE} />
    <circle className="vls-hx-led" cx={240} cy={73} r={3} fill={LIVE} opacity={0} />
    <g className="vls-hx-moon">
      <Moon x={240} y={42} k={0.8} />
    </g>
    <g className="vls-hx-settle">
      <Pawn x={196} yb={78} s={8} eyes="closed" host />
    </g>
  </>
);

/* hint-pause: [TV alive, motion lines] → [same picture frozen + pause-bars
   stamp + amber LED]. Reuses the host-paused idiom (dim + bars + amber). */
const ScenePause: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-pz-flick{animation:vlsPzFlick var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-pz-hold{animation:vlsPzHold var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pz-bars{transform-box:fill-box;transform-origin:center;animation:vlsPzBars var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
:where(svg[data-comic-motion="still"]) .vls-pz-bars{animation-name:vlsPzRest}
@keyframes vlsPzFlick{0%{opacity:.5}10%{opacity:.9}20%{opacity:.2}32%{opacity:.85}44%,100%{opacity:.5}}
@keyframes vlsPzHold{0%{opacity:0}12%,100%{opacity:1}}
@keyframes vlsPzBars{0%,5%{opacity:0;transform:scale(1.45)}16%,100%{opacity:1;transform:scale(1)}}
@keyframes vlsPzRest{0%,36%,100%{transform:none}14%{transform:scale(1.15)}}
${rmBlock(
  ["vls-pz-flick", "vls-pz-hold"],
  [[".vls-pz-flick", "opacity:.5"], [".vls-pz-hold", "opacity:1;transform:none"]],
)}
${rmBlock(["vls-pz-bars"], [[".vls-pz-bars", "opacity:1;transform:none"]], false)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <MiniTv x={44} y={22} w={72} h={46} />
    <path d="M73 34 L89 42.2 L73 50.4 Z" fill={MINT} />
    <g className="vls-pz-flick" stroke={SKY} strokeWidth={2} strokeLinecap="round" opacity={0.5}>
      <path d="M54 33 v7 M58 45 v6 M106 34 v6 M102 46 v5" />
    </g>
    <circle cx={80} cy={74} r={3} fill={LIVE} />
    <MiniTv x={204} y={22} w={72} h={46} />
    <path d="M233 34 L249 42.2 L233 50.4 Z" fill={MINT} />
    <g className="vls-pz-hold">
      <rect x={209.04} y={27.06} width={61.92} height={30.36} rx={4} fill="#0a101c" opacity={0.45} />
      <circle cx={240} cy={74} r={3} fill={WARN} />
    </g>
    <circle cx={240} cy={74} r={3} fill={LIVE} opacity={0.35} />
    <g className="vls-pz-bars" fill={INK_STAGE}>
      <rect x={229} y={30.5} width={8.5} height={23.5} rx={3.5} />
      <rect x={242.5} y={30.5} width={8.5} height={23.5} rx={3.5} />
    </g>
  </>
);

/* hint-resume: [frozen picture + pause bars] → [bars gone, play triangle
   springs, motion lines return]. Before panel is perfectly still = frozen. */
const SceneResume: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-rs-play{transform-box:fill-box;transform-origin:center;animation:vlsRsPlay var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
.vls-rs-led{animation:vlsRsLed var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-rs-flick{animation:vlsRsFlick var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
:where(svg[data-comic-motion="still"]) .vls-rs-play{animation-name:vlsRsRest}
@keyframes vlsRsPlay{0%{transform:scale(.55);opacity:.5}14%{transform:scale(1.18);opacity:1}22%,100%{transform:scale(1);opacity:1}}
@keyframes vlsRsLed{0%{opacity:.2}10%,100%{opacity:1}}
@keyframes vlsRsFlick{0%,12%{opacity:0}20%{opacity:.9}30%{opacity:.25}40%{opacity:.85}54%,100%{opacity:.5}}
@keyframes vlsRsRest{0%,36%,100%{transform:none}14%{transform:translateX(-3px)}}
${rmBlock(
  ["vls-rs-led", "vls-rs-flick"],
  [[".vls-rs-led", "opacity:1;transform:none"], [".vls-rs-flick", "opacity:.5"]],
)}
${rmBlock(["vls-rs-play"], [[".vls-rs-play", "opacity:1;transform:none"]], false)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <MiniTv x={44} y={22} w={72} h={46} />
    <path d="M73 34 L89 42.2 L73 50.4 Z" fill={MINT} />
    <rect x={49.04} y={27.06} width={61.92} height={30.36} rx={4} fill="#0a101c" opacity={0.45} />
    <g fill={INK_STAGE}>
      <rect x={69} y={30.5} width={8.5} height={23.5} rx={3.5} />
      <rect x={82.5} y={30.5} width={8.5} height={23.5} rx={3.5} />
    </g>
    <circle cx={80} cy={74} r={3} fill={WARN} />
    <MiniTv x={204} y={22} w={72} h={46} />
    <path className="vls-rs-play" d="M233 34 L249 42.2 L233 50.4 Z" fill={MINT} />
    <g className="vls-rs-flick" stroke={SKY} strokeWidth={2} strokeLinecap="round" opacity={0}>
      <path d="M214 33 v7 M218 45 v6 M266 34 v6 M262 46 v5" />
    </g>
    <circle className="vls-rs-led" cx={240} cy={74} r={3} fill={LIVE} />
  </>
);

/* Switch the selected capture window; the two contents retain their identity. */
const SceneSwitchSource: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-sw-d1{animation:vlsSwD1 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-sw-d2{animation:vlsSwD2 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
:where(svg[data-comic-motion="still"]) .vls-sw-selected{animation:vlsSwSelected var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsSwD1{0%{transform:translate(0,0);opacity:0}8%{opacity:1}22%{transform:translate(11px,-6px)}36%{transform:translate(22px,0);opacity:1}46%,100%{transform:translate(22px,0);opacity:0}}
@keyframes vlsSwD2{0%{transform:translate(0,0);opacity:0}8%{opacity:1}22%{transform:translate(-11px,6px)}36%{transform:translate(-22px,0);opacity:1}46%,100%{transform:translate(-22px,0);opacity:0}}
@keyframes vlsSwSelected{0%,38%,100%{transform:none}14%{transform:translateY(-4px)}}
${rmBlock(["vls-sw-d1", "vls-sw-d2"], [[".vls-sw-d1,.vls-sw-d2", "opacity:0;transform:none"]])}
${rmBlock(["vls-sw-selected"], [[".vls-sw-selected", "transform:none"]], false)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <SourceWindow x={27} y={28} />
    <SourceWindow x={87} y={28} alternate />
    <SourceWindow x={187} y={28} />
    <SourceWindow x={247} y={28} alternate />
    <g stroke={LIVE} strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M41 70l5 5 10-10" />
      <path className="vls-sw-selected" d="M261 70l5 5 10-10" />
    </g>
    <g stroke={SKY} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M229 29 C236 16 244 16 251 29 M244.5 26.5 L251 29 L249 22.5" />
      <path d="M251 63 C244 76 236 76 229 63 M235.5 65.5 L229 63 L231 69.5" />
    </g>
    <circle className="vls-sw-d1" cx={229} cy={29} r={2.5} fill={MINT} opacity={0} />
    <circle className="vls-sw-d2" cx={251} cy={63} r={2.5} fill={MINT} opacity={0} />
  </>
);

/* Reconnect asks the transport to try again; this prospective action cannot
   claim a successful connection or a delivered frame. */
const SceneReconnect: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-rj-spark{animation:vlsRjSpark var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rj-plug{transform-box:fill-box;transform-origin:50% 100%;animation:vlsRjPlug var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsRjSpark{0%,100%{opacity:.55}15%{opacity:1}}
@keyframes vlsRjPlug{0%{transform:translate(-2px,-8px) rotate(-6deg)}10%{transform:translate(-1px,-3px) rotate(4deg)}20%{transform:translate(0,-1px) rotate(-2deg)}28%,100%{transform:none}}
${rmBlock(
  ["vls-rj-spark", "vls-rj-plug"],
  [
    [".vls-rj-spark", "opacity:1"],
    [".vls-rj-plug", "transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <Socket x={90} y={52} />
    <Plug x={80} y={23} />
    <Spark x={93} y={49} className="vls-rj-spark" />
    <Socket x={250} y={52} />
    <g className="vls-rj-plug">
      <Plug x={260} y={36} />
    </g>
    <path d="M281 24a8 8 0 1 1-7 12m0 0v-5m0 5h5" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </>
);

function CaptureHint({ theme, target }: Parameters<HintScene>[0] & { target: "browser" | "window" | "display" | "camera" }) {
  return <>
    <style>{`
.vls-capture-choice{animation:vlsCaptureChoice var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsCaptureChoice{0%,10%{opacity:.35;transform:translate(3px,3px)}28%,100%{opacity:1;transform:none}}
${rmBlock(["vls-capture-choice"], [[".vls-capture-choice", "opacity:1;transform:none"]])}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    {target === "browser" ? <>
      <BrowserWindow x={29} y={20} w={100} h={58} />
      <rect x={39} y={35} width={80} height={30} rx={3} fill="var(--wall-2)" stroke={SKY} strokeWidth={2} />
      <path d="M44 58l10-14 7 8 5-5 8 11Z" fill={SKY} />
      <rect x={83} y={42} width={24} height={3} rx={1.5} fill={FAINT} />
      <rect x={83} y={50} width={18} height={3} rx={1.5} fill={FAINT} />
    </> : target === "window" ? <>
      <g opacity={.35}><SourceWindow x={38} y={24} alternate /></g>
      <SourceWindow x={60} y={41} />
    </> : target === "camera" ? <>
      <g transform="translate(30 31)"><Glyph name="camera" size={32} /></g>
      <Pawn x={91} yb={73} s={13} eyes color={SKY} />
    </> : <>
      <rect x={29} y={21} width={100} height={54} rx={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
      <path d="M79 75v9m-16 0h32" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />
      <SourceWindow x={64} y={31} />
      <path d="M38 31h8m-8 8h8m-8 8h8" stroke={SKY} strokeWidth={4} />
    </>}
    <g transform={target === "window" ? "translate(-16 0)" : undefined}>
      <path className="vls-capture-choice" d="M113 57v17l5-5 4 8 4-2-4-8h7Z" fill={LIVE} stroke="var(--paper)" strokeWidth={1.5} strokeLinejoin="round" />
    </g>
    <MiniTv x={213} y={23} w={76} h={48} />
    {target === "display" ? <g className="vls-capture-choice">
      <path d="M225 34h4m-4 6h4m-4 6h4" stroke={SKY} strokeWidth={2.5} />
      <rect x={237} y={34} width={37} height={23} rx={2} fill={TV_SCREEN} stroke={SKY} strokeWidth={1.5} />
      <path d="M237 39h37 M243 53l7-10 5 6 4-4 7 8Z" stroke={SKY} strokeWidth={1} fill={SKY} />
    </g> : target === "camera" ? <g className="vls-capture-choice"><Pawn x={251} yb={63} s={10} eyes color={SKY} /></g>
      : <path className="vls-capture-choice" d="M229 54l10-14 7 8 5-5 8 11Z" fill={SKY} />}
    <Pawn x={190} yb={78} s={8} eyes host />
  </>;
}

function MicrophoneHint({ theme, mode }: Parameters<HintScene>[0] & { mode: "on" | "off" | "volume" }) {
  return <>
    <style>{`
.vls-mic-voice{animation:vlsMicVoice var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsMicVoice{0%,10%{opacity:0;transform:translateX(-3px)}24%,48%{opacity:1;transform:none}68%,100%{opacity:0;transform:translateX(3px)}}
.vls-mic-gain{animation:vlsMicGain var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsMicGain{0%,12%{transform:translateX(0)}40%,100%{transform:translateX(28px)}}
${rmBlock(["vls-mic-voice"], [[".vls-mic-voice", "opacity:1;transform:none"]])}
${rmBlock(["vls-mic-gain"], [[".vls-mic-gain", "transform:translateX(28px)"]])}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    {[0, 160].map((x, index) => <g key={x} transform={`translate(${x} 0)`}>
      <Pawn x={53} yb={76} s={14} eyes host />
      <g transform="translate(78 38)"><Glyph name="microphone" size={27} /></g>
      {mode === "volume" ? <>
        <path d="M113 46q5 6 0 12" stroke={MINT} strokeWidth={2.5} strokeLinecap="round" fill="none" />
        {index === 1 && <path className="vls-mic-voice" d="M120 40q10 12 0 24m7-29q15 17 0 34" stroke={MINT} strokeWidth={2.5} strokeLinecap="round" fill="none" />}
        <path d="M89 82h40" stroke={FAINT} strokeWidth={3} strokeLinecap="round" />
        <circle className={index === 1 ? "vls-mic-gain" : undefined} cx={94} cy={82} r={4} fill={SKY} />
      </> : (index === 0 ? mode === "on" : mode === "off")
        ? <path d="m77 67 31-33" stroke={WARN} strokeWidth={3} strokeLinecap="round" />
        : <path className="vls-mic-voice" d="M113 44q7 8 0 16m7-21q12 13 0 26" stroke={MINT} strokeWidth={2.5} strokeLinecap="round" fill="none" />}
    </g>)}
  </>;
}

export const SET1_SCENES: Record<Set1Kind, HintScene> = {
  "hint-microphone-on": (props) => <MicrophoneHint {...props} mode="on" />,
  "hint-microphone-off": (props) => <MicrophoneHint {...props} mode="off" />,
  "hint-microphone-volume": (props) => <MicrophoneHint {...props} mode="volume" />,
  "hint-share-start": SceneShareStart,
  "hint-share-stop": SceneShareStop,
  "hint-pause": ScenePause,
  "hint-resume": SceneResume,
  "hint-switch-source": SceneSwitchSource,
  "hint-reconnect": SceneReconnect,
  "hint-capture-browser": (props) => <CaptureHint {...props} target="browser" />,
  "hint-capture-camera": (props) => <CaptureHint {...props} target="camera" />,
  "hint-capture-window": (props) => <CaptureHint {...props} target="window" />,
  "hint-capture-display": (props) => <CaptureHint {...props} target="display" />,
};
