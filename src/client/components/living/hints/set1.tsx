// Hint set 1 — sharing lifecycle: start/stop/pause/resume/source/fullscreen/reconnect.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
import {
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
  TV_BODY,
  TV_EDGE,
  WARN,
  YOU,
  rmBlock,
} from "../Comic";
import type { HintScene, Set1Kind } from "./index";

/* hint-share-start: [dark TV + pawn reaching toward it] → [TV bright, mint
   glow, rays + Star]. The after panel replays one power-on beat per loop
   (CRT screen-on → rays → star → pawn hop), then rests lit ~60%. */
const SceneShareStart: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-hs-reach{transform-box:fill-box;transform-origin:50% 100%;animation:vlsHsReach 3.2s ease-in-out infinite}
.vls-hs-intent{animation:vlsHsIntent 3.2s ease-in-out infinite}
.vls-hs-crt{transform-box:fill-box;transform-origin:center;animation:vlsHsCrt 3.2s ease-out infinite}
.vls-hs-rays{animation:vlsHsRays 3.2s ease-out infinite}
.vls-hs-star{transform-box:fill-box;transform-origin:center;animation:vlsHsStar 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
.vls-hs-hop{animation:vlsHsHop 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
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
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <Floor x1={14} x2={146} y={78} />
    <MiniTv x={55} y={24} w={66} h={42} />
    <circle cx={88} cy={73} r={3} fill={TV_EDGE} />
    <g className="vls-hs-reach">
      <path d="M20 78 c0-11 4.5-15.5 10-15.5 s10 4.5 10 15.5 Z" fill={YOU} />
      <circle cx={30} cy={58} r={6} fill={YOU} />
      <circle cx={31.5} cy={57.5} r={1.2} fill="#101a2c" />
      <circle cx={34.9} cy={57.5} r={1.2} fill="#101a2c" />
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
      <Pawn x={184} yb={78} s={9} eyes />
    </g>
  </>
);

/* hint-share-stop: [bright TV, pawn watching] → [TV dims, chin LED out, small
   Moon, pawn content]. Calm power-down: dim + LED-out beat, moon settles. */
const SceneShareStop: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-hx-eyes{transform-box:fill-box;transform-origin:center;animation:vlsHxBlink 3.4s ease-in-out infinite}
.vls-hx-dim{animation:vlsHxDim 3.4s ease-out infinite}
.vls-hx-led{animation:vlsHxLed 3.4s ease-out infinite}
.vls-hx-moon{animation:vlsHxMoon 3.4s ease-in-out infinite}
.vls-hx-settle{animation:vlsHxSettle 3.4s cubic-bezier(.3,1.5,.5,1) infinite}
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
    <Frame x={164} w={152} theme={theme} />
    <Floor x1={14} x2={146} y={78} />
    <MiniTv x={47} y={24} w={66} h={42} />
    <rect x={51.62} y={28.62} width={56.76} height={27.72} rx={4} fill={MINT} />
    <path d="M73 37 L87 42.5 L73 48 Z" fill="#101a2c" />
    <g stroke={MINT} strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M62 17 l-6 -7 M80 14 V6 M98 17 l6 -7" />
    </g>
    <circle cx={80} cy={73} r={3} fill={LIVE} />
    <path d="M15 78 c0-9.9 4.05-13.95 9-13.95 s9 4.05 9 13.95 Z" fill={YOU} />
    <circle cx={24} cy={60} r={5.4} fill={YOU} />
    <g className="vls-hx-eyes" fill="#101a2c">
      <circle cx={24} cy={59.5} r={1.1} />
      <circle cx={27.6} cy={59.5} r={1.1} />
    </g>
    <Floor x1={174} x2={306} y={78} />
    <MiniTv x={207} y={24} w={66} h={42} />
    <rect className="vls-hx-dim" x={211.62} y={28.62} width={56.76} height={27.72} rx={4} fill="#0a101c" />
    <circle cx={240} cy={73} r={3} fill={TV_EDGE} />
    <circle className="vls-hx-led" cx={240} cy={73} r={3} fill={LIVE} opacity={0} />
    <g className="vls-hx-moon">
      <Moon x={240} y={42} k={0.8} />
    </g>
    <g className="vls-hx-settle">
      <path d="M187 78 c0-9.9 4.05-13.95 9-13.95 s9 4.05 9 13.95 Z" fill={YOU} />
      <circle cx={196} cy={60} r={5.4} fill={YOU} />
      <path
        d="M191.8 59.5 q1.7 -2.2 3.4 0 M198.8 59.5 q1.7 -2.2 3.4 0"
        stroke="#101a2c"
        strokeWidth={1.8}
        strokeLinecap="round"
        fill="none"
      />
    </g>
  </>
);

/* hint-pause: [TV alive, motion lines] → [same picture frozen + pause-bars
   stamp + amber LED]. Reuses the host-paused idiom (dim + bars + amber). */
const ScenePause: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-pz-flick{animation:vlsPzFlick 3s ease-in-out infinite}
.vls-pz-hold{animation:vlsPzHold 3s ease-out infinite}
.vls-pz-bars{transform-box:fill-box;transform-origin:center;animation:vlsPzBars 3s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsPzFlick{0%{opacity:.5}10%{opacity:.9}20%{opacity:.2}32%{opacity:.85}44%,100%{opacity:.5}}
@keyframes vlsPzHold{0%{opacity:0}12%,100%{opacity:1}}
@keyframes vlsPzBars{0%,5%{opacity:0;transform:scale(1.45)}16%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-pz-flick", "vls-pz-hold", "vls-pz-bars"],
  [[".vls-pz-flick", "opacity:.5"], [".vls-pz-hold,.vls-pz-bars", "opacity:1;transform:none"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={WARN} />
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
.vls-rs-play{transform-box:fill-box;transform-origin:center;animation:vlsRsPlay 3s cubic-bezier(.3,1.5,.5,1) infinite}
.vls-rs-led{animation:vlsRsLed 3s ease-out infinite}
.vls-rs-flick{animation:vlsRsFlick 3s ease-in-out infinite}
@keyframes vlsRsPlay{0%{transform:scale(.55);opacity:.5}14%{transform:scale(1.18);opacity:1}22%,100%{transform:scale(1);opacity:1}}
@keyframes vlsRsLed{0%{opacity:.2}10%,100%{opacity:1}}
@keyframes vlsRsFlick{0%,12%{opacity:0}20%{opacity:.9}30%{opacity:.25}40%{opacity:.85}54%,100%{opacity:.5}}
${rmBlock(
  ["vls-rs-play", "vls-rs-led", "vls-rs-flick"],
  [[".vls-rs-play,.vls-rs-led", "opacity:1;transform:none"], [".vls-rs-flick", "opacity:.5"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
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

/* hint-switch-source: [two monitor cards, left lit] → [right lit, swap arcs
   with two dots exchanging seats — the Hearth switch do-si-do]. */
const SceneSwitchSource: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-sw-d1{animation:vlsSwD1 3.2s ease-in-out infinite}
.vls-sw-d2{animation:vlsSwD2 3.2s ease-in-out infinite}
@keyframes vlsSwD1{0%{transform:translate(0,0);opacity:0}8%{opacity:1}22%{transform:translate(11px,-6px)}36%{transform:translate(22px,0);opacity:1}46%,100%{transform:translate(22px,0);opacity:0}}
@keyframes vlsSwD2{0%{transform:translate(0,0);opacity:0}8%{opacity:1}22%{transform:translate(-11px,6px)}36%{transform:translate(-22px,0);opacity:1}46%,100%{transform:translate(-22px,0);opacity:0}}
${rmBlock(["vls-sw-d1", "vls-sw-d2"], [[".vls-sw-d1,.vls-sw-d2", "opacity:0;transform:none"]])}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={SKY} />
    <rect x={27} y={28} width={46} height={32} rx={6} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
    <rect x={32} y={32} width={36} height={16} rx={3} fill={MINT} />
    <circle cx={50} cy={54} r={2.5} fill={LIVE} />
    <rect x={87} y={28} width={46} height={32} rx={6} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
    <rect x={92} y={32} width={36} height={16} rx={3} fill="#16233c" />
    <circle cx={110} cy={54} r={2.5} fill={TV_EDGE} />
    <rect x={187} y={28} width={46} height={32} rx={6} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
    <rect x={192} y={32} width={36} height={16} rx={3} fill="#16233c" />
    <circle cx={210} cy={54} r={2.5} fill={TV_EDGE} />
    <rect x={247} y={28} width={46} height={32} rx={6} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
    <rect x={252} y={32} width={36} height={16} rx={3} fill={MINT} />
    <circle cx={270} cy={54} r={2.5} fill={LIVE} />
    <g stroke={SKY} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M229 29 C236 16 244 16 251 29 M244.5 26.5 L251 29 L249 22.5" />
      <path d="M251 63 C244 76 236 76 229 63 M235.5 65.5 L229 63 L231 69.5" />
    </g>
    <circle className="vls-sw-d1" cx={229} cy={29} r={2.5} fill={MINT} opacity={0} />
    <circle className="vls-sw-d2" cx={251} cy={63} r={2.5} fill={MINT} opacity={0} />
  </>
);

/* hint-reconnect: [Plug out of Socket, small Spark at the gap] → [Plug seats
   with a wiggle, LIVE dot pops]. Same plug language as recovering. */
const SceneReconnect: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-rj-spark{animation:vlsRjSpark 3.2s ease-in-out infinite}
.vls-rj-plug{transform-box:fill-box;transform-origin:50% 100%;animation:vlsRjPlug 3.2s ease-in-out infinite}
.vls-rj-led{transform-box:fill-box;transform-origin:center;animation:vlsRjLed 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsRjSpark{0%,100%{opacity:.55}15%{opacity:1}}
@keyframes vlsRjPlug{0%{transform:translate(-2px,-8px) rotate(-6deg)}10%{transform:translate(-1px,-3px) rotate(4deg)}20%{transform:translate(0,-1px) rotate(-2deg)}28%,100%{transform:none}}
@keyframes vlsRjLed{0%,24%{opacity:0;transform:scale(.4)}32%{opacity:1;transform:scale(1.3)}40%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-rj-spark", "vls-rj-plug", "vls-rj-led"],
  [
    [".vls-rj-spark", "opacity:1"],
    [".vls-rj-plug", "transform:none"],
    [".vls-rj-led", "opacity:1;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <Socket x={90} y={52} />
    <Plug x={80} y={23} />
    <Spark x={93} y={49} className="vls-rj-spark" />
    <Socket x={250} y={52} />
    <g className="vls-rj-plug">
      <Plug x={260} y={36} />
    </g>
    <circle className="vls-rj-led" cx={284} cy={38} r={3.5} fill={LIVE} />
  </>
);

export const SET1_SCENES: Record<Set1Kind, HintScene> = {
  "hint-share-start": SceneShareStart,
  "hint-share-stop": SceneShareStop,
  "hint-pause": ScenePause,
  "hint-resume": SceneResume,
  "hint-switch-source": SceneSwitchSource,
  "hint-reconnect": SceneReconnect,
};
