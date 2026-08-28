// Hint set 4 — people & misc: topology, close, admit/deny, rename, theme, join-go, route p2p/sfu.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
// Absolute coordinates only: any element whose class animates `transform`
// carries no transform attribute — positions are baked into path data.
import {
  Crown,
  Door,
  FAINT,
  Frame,
  LIVE,
  MINT,
  Pawn,
  RedX,
  SKY,
  ServerBox,
  Spark,
  Star,
  STAR_GOLD,
  TV_SCREEN,
  rmBlock,
} from "../Comic";
import type { HintScene, Set4Kind } from "./index";

const INK = "var(--ink)";
const WALL2 = "var(--wall-2)";
const EYE = "#101a2c";

/* hint-topology: [one crowned pawn alone] → [crowned pawn with two leaf
   pawns on live-green edges]. Loop 3.2s: leaves hop in turn (8-20%, 26-38%),
   everyone blinks at 62%; rest >=55%. */
const HintTopology: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-top-eyes{transform-box:fill-box;transform-origin:center;animation:vlsTopBlink 3.2s ease-in-out infinite}
.vls-top-leaf1{transform-box:fill-box;transform-origin:50% 100%;animation:vlsTopHop1 3.2s ease-in-out infinite}
.vls-top-leaf2{transform-box:fill-box;transform-origin:50% 100%;animation:vlsTopHop2 3.2s ease-in-out infinite}
@keyframes vlsTopBlink{0%,58%,66%,100%{transform:scaleY(1)}62%{transform:scaleY(.12)}}
@keyframes vlsTopHop1{0%,8%{transform:translateY(0)}14%{transform:translateY(-4px)}20%,100%{transform:translateY(0)}}
@keyframes vlsTopHop2{0%,26%{transform:translateY(0)}32%{transform:translateY(-4px)}38%,100%{transform:translateY(0)}}
${rmBlock(
  ["vls-top-eyes", "vls-top-leaf1", "vls-top-leaf2"],
  [[".vls-top-eyes,.vls-top-leaf1,.vls-top-leaf2", "transform:none"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <Crown x={80} y={47} />
    <Pawn x={80} yb={78} s={12} />
    <g className="vls-top-eyes" fill={EYE}>
      <circle cx={77.4} cy={54} r={1.3} />
      <circle cx={82.6} cy={54} r={1.3} />
    </g>
    <g stroke={LIVE} strokeWidth={3} strokeLinecap="round" fill="none">
      <path d="M240 47 C231 55 222 58 213 65" />
      <path d="M240 47 C249 55 258 58 267 65" />
    </g>
    <Pawn x={240} yb={46} s={7} />
    <g className="vls-top-eyes" fill={EYE}>
      <circle cx={237.8} cy={32} r={0.9} />
      <circle cx={242.2} cy={32} r={0.9} />
    </g>
    <Crown x={240} y={27} k={0.75} />
    <Pawn x={210} yb={80} s={7} color={SKY} eyes className="vls-top-leaf1" />
    <Pawn x={270} yb={80} s={7} color={MINT} eyes className="vls-top-leaf2" />
  </>
);

/* hint-close: [open card] → [card folds away + small RedX stamp]. Loop 3.4s:
   card wobbles (10-28%), folds out (40-52%), X stamps once at 56-62% and
   holds; rest 62-100%. */
const HintClose: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-cls-card{transform-box:fill-box;transform-origin:center;animation:vlsClsCard 3.4s ease-in-out infinite}
.vls-cls-x{transform-box:fill-box;transform-origin:center;animation:vlsClsX 3.4s ease-out infinite}
@keyframes vlsClsCard{0%,10%{transform:rotate(0);opacity:1}16%{transform:rotate(2.5deg)}22%{transform:rotate(-2.5deg)}28%,40%{transform:rotate(0);opacity:1}52%,100%{transform:rotate(-14deg) translate(-12px,20px) scale(.55);opacity:0}}
@keyframes vlsClsX{0%,56%{opacity:0;transform:scale(1.6) rotate(8deg)}62%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
${rmBlock(
  ["vls-cls-card", "vls-cls-x"],
  [
    [".vls-cls-card", "opacity:0;transform:none"],
    [".vls-cls-x", "opacity:1;transform:scale(1) rotate(8deg)"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <rect x={52} y={22} width={56} height={50} rx={8} fill={WALL2} stroke={INK} strokeWidth={2.5} />
    <g stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0.5}>
      <path d="M62 36 q4 -5 8 0 t8 0 t8 0" />
      <path d="M62 48 q4 -5 8 0 t8 0" />
    </g>
    <g className="vls-cls-card">
      <rect x={212} y={22} width={56} height={50} rx={8} fill={WALL2} stroke={INK} strokeWidth={2.5} />
      <g stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0.5}>
        <path d="M222 36 q4 -5 8 0 t8 0 t8 0" />
        <path d="M222 48 q4 -5 8 0 t8 0" />
      </g>
    </g>
    <RedX cx={266} cy={24} arm={6.5} className="vls-cls-x" />
  </>
);

/* hint-admit: [pawn knocking at a shut door] → [door open, pawn hops in,
   star]. Loop 3.2s: two knocks 0-24%, hop-in 10-26%, star pop 30-42%;
   rest ~58%. */
const HintAdmit: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-adm-knock{animation:vlsAdmKnock 3.2s ease-in-out infinite}
.vls-adm-kn{animation:vlsAdmKn 3.2s ease-in-out infinite}
.vls-adm-hop{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmHop 3.2s cubic-bezier(.3,1.4,.5,1) infinite}
.vls-adm-star{transform-box:fill-box;transform-origin:center;animation:vlsAdmStar 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsAdmKnock{0%{transform:translateX(0)}6%{transform:translateX(4px)}12%{transform:translateX(0)}18%{transform:translateX(4px)}24%,100%{transform:translateX(0)}}
@keyframes vlsAdmKn{0%,3%{opacity:0}7%{opacity:.9}11%{opacity:0}15%{opacity:.9}22%,100%{opacity:0}}
@keyframes vlsAdmHop{0%,10%{transform:translate(-40px,0)}18%{transform:translate(-18px,-9px)}26%,100%{transform:translate(0,0)}}
@keyframes vlsAdmStar{0%,30%{opacity:0;transform:scale(0)}36%{opacity:1;transform:scale(1.25)}42%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-adm-knock", "vls-adm-kn", "vls-adm-hop", "vls-adm-star"],
  [
    [".vls-adm-kn", "opacity:0"],
    [".vls-adm-hop,.vls-adm-star", "transform:none"],
    [".vls-adm-star", "opacity:1"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <g className="vls-adm-knock">
      <Pawn x={63} yb={76} s={9} eyes />
    </g>
    <g className="vls-adm-kn" stroke={INK} strokeWidth={2} strokeLinecap="round" opacity={0}>
      <path d="M84 36l-7-3M82 46h-8M84 56l-7 3" />
    </g>
    <Door x={96} y={18} />
    <rect x={242} y={18} width={38} height={56} rx={5} fill={TV_SCREEN} stroke={INK} strokeWidth={2.5} />
    <path d="M242 18 L262 25 L262 67 L242 74 Z" fill={WALL2} stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
    <circle cx={257} cy={46} r={1.8} fill={INK} />
    <g className="vls-adm-hop">
      <Pawn x={271} yb={74} s={8} eyes />
    </g>
    <Star x={288} y={24} className="vls-adm-star" baseOpacity={0} />
  </>
);

/* hint-deny: [pawn at a shut door] → [door stays shut, pawn turned away
   waving bye with a head-tilt; footprints trail back]. Gentle: no RedX.
   Loop 3.2s: two knocks 0-24%, wave 32-52%; rest ~48%. */
const HintDeny: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-dny-kn{animation:vlsDnyKn 3.2s ease-in-out infinite}
.vls-dny-wave{transform-box:fill-box;transform-origin:50% 100%;animation:vlsDnyWave 3.2s ease-in-out infinite}
@keyframes vlsDnyKn{0%,3%{opacity:0}7%{opacity:.9}11%{opacity:0}15%{opacity:.9}22%,100%{opacity:0}}
@keyframes vlsDnyWave{0%,32%{transform:rotate(0)}36%{transform:rotate(-8deg)}40%{transform:rotate(8deg)}44%{transform:rotate(-8deg)}48%{transform:rotate(8deg)}52%,100%{transform:rotate(0)}}
${rmBlock(
  ["vls-dny-kn", "vls-dny-wave"],
  [[".vls-dny-kn", "opacity:0"], [".vls-dny-wave", "transform:none"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <Pawn x={60} yb={76} s={9} eyes />
    <g className="vls-dny-kn" stroke={INK} strokeWidth={2} strokeLinecap="round" opacity={0}>
      <path d="M88 36l-7-3M86 46h-8M88 56l-7 3" />
    </g>
    <Door x={96} y={18} />
    <Door x={252} y={18} />
    <g fill={INK} opacity={0.35}>
      <circle cx={222} cy={72} r={1.5} />
      <circle cx={232} cy={68} r={1.5} />
    </g>
    <g className="vls-dny-wave">
      <Pawn x={206} yb={76} s={9} />
      <circle cx={202.5} cy={58} r={1} fill={EYE} />
      <circle cx={206} cy={58} r={1} fill={EYE} />
    </g>
  </>
);

/* hint-rename: [blank name tag] → [pencil writes a squiggle on the tag +
   spark]. Loop 3.2s: pencil rides the pen tip left→right wiggling (6-34%)
   as the line draws, spark pops 38-46%, holds; rest 54%. */
const HintRename: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-rnm-line{stroke-dasharray:1;animation:vlsRnmLine 3.2s ease-in-out infinite}
.vls-rnm-pencil{transform-box:fill-box;transform-origin:0% 100%;animation:vlsRnmPencil 3.2s ease-in-out infinite}
.vls-rnm-spark{transform-box:fill-box;transform-origin:center;animation:vlsRnmSpark 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsRnmLine{0%,6%{stroke-dashoffset:1}34%,100%{stroke-dashoffset:0}}
@keyframes vlsRnmPencil{0%,6%{transform:translate(-30px,0) rotate(0)}12%{transform:translate(-21px,0) rotate(-6deg)}18%{transform:translate(-13px,0) rotate(5deg)}24%{transform:translate(-6px,0) rotate(-5deg)}30%{transform:translate(-2px,0) rotate(4deg)}34%,100%{transform:translate(0,0) rotate(0)}}
@keyframes vlsRnmSpark{0%,38%{opacity:0;transform:scale(.4)}44%{opacity:1;transform:scale(1.2)}50%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-rnm-line", "vls-rnm-pencil", "vls-rnm-spark"],
  [
    [".vls-rnm-line", "stroke-dashoffset:0"],
    [".vls-rnm-pencil", "transform:none"],
    [".vls-rnm-spark", "opacity:1;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <rect x={44} y={30} width={72} height={30} rx={8} fill={WALL2} stroke={INK} strokeWidth={2.5} />
    <circle cx={55} cy={45} r={2.5} fill="var(--paper)" stroke={INK} strokeWidth={1.5} />
    <path d="M66 45 h40" stroke={INK} strokeWidth={2} strokeLinecap="round" strokeDasharray="3 4" opacity={0.3} />
    <rect x={204} y={30} width={72} height={30} rx={8} fill={WALL2} stroke={INK} strokeWidth={2.5} />
    <circle cx={215} cy={45} r={2.5} fill="var(--paper)" stroke={INK} strokeWidth={1.5} />
    <path
      className="vls-rnm-line"
      d="M224 45 q5 -7 10 0 t10 0 t10 0"
      pathLength={1}
      stroke={INK}
      strokeWidth={2.5}
      strokeLinecap="round"
      fill="none"
    />
    <g className="vls-rnm-pencil">
      <polygon points="254.3,39.7 265.6,28.4 270.6,33.4 259.3,44.7" fill={STAR_GOLD} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
      <polygon points="254.3,39.7 259.3,44.7 254,45" fill={INK} />
    </g>
    <Spark x={266} y={24} className="vls-rnm-spark" />
  </>
);

/* hint-theme: single wide panel — sun and moon on a two-arrow do-si-do.
   Loop 3s: sun owns 0-38%, crossfade 38-50%, moon owns 50-88%, fade back;
   arrows static. */
const HintTheme: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-thm-sun{transform-box:fill-box;transform-origin:center;animation:vlsThmSun 3s ease-in-out infinite}
.vls-thm-moon{transform-box:fill-box;transform-origin:center;animation:vlsThmMoon 3s ease-in-out infinite}
@keyframes vlsThmSun{0%,38%{opacity:1;transform:scale(1)}50%,88%{opacity:.45;transform:scale(.92)}100%{opacity:1;transform:scale(1)}}
@keyframes vlsThmMoon{0%,38%{opacity:.45;transform:scale(.92)}50%,88%{opacity:1;transform:scale(1)}100%{opacity:.45;transform:scale(.92)}}
${rmBlock(
  ["vls-thm-sun", "vls-thm-moon"],
  [[".vls-thm-sun,.vls-thm-moon", "opacity:1;transform:none"]],
)}
`}</style>
    <Frame x={4} w={312} theme={theme} />
    <g stroke={INK} strokeWidth={2.5} strokeLinecap="round" fill="none" opacity={0.55}>
      <path d="M100 34 A90 90 0 0 1 220 34" />
      <path d="M212 27 L220 34 L212 41" />
      <path d="M220 62 A90 90 0 0 0 100 62" />
      <path d="M108 55 L100 62 L108 69" />
    </g>
    <g className="vls-thm-sun">
      <g stroke={INK} strokeWidth={2.5} strokeLinecap="round">
        <path d="M125 48h5 M90 48h5 M117.5 61l2.5 4.3 M102.5 35l-2.5-4.3 M102.5 61l-2.5 4.3 M117.5 35l2.5-4.3" />
      </g>
      <circle cx={110} cy={48} r={11} fill={STAR_GOLD} stroke={INK} strokeWidth={2} />
    </g>
    <g className="vls-thm-moon">
      <circle cx={210} cy={48} r={11} fill={INK} />
      <circle cx={214} cy={44} r={9} fill="var(--paper)" />
      <circle cx={228} cy={32} r={1.8} fill={STAR_GOLD} />
      <circle cx={232} cy={48} r={1.4} fill={STAR_GOLD} />
    </g>
  </>
);

/* hint-join-go: [pawn beside 4 filled code slots] → [pawn hops through an
   open door + star]. Loop 3.2s: blink at 62%, hop-in 8-24%, star 28-42%;
   rest ~58%. */
const HintJoinGo: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-jgo-eyes{transform-box:fill-box;transform-origin:center;animation:vlsJgoBlink 3.2s ease-in-out infinite}
.vls-jgo-hop{transform-box:fill-box;transform-origin:50% 100%;animation:vlsJgoHop 3.2s cubic-bezier(.3,1.4,.5,1) infinite}
.vls-jgo-star{transform-box:fill-box;transform-origin:center;animation:vlsJgoStar 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsJgoBlink{0%,58%,66%,100%{transform:scaleY(1)}62%{transform:scaleY(.12)}}
@keyframes vlsJgoHop{0%,8%{transform:translate(-38px,0)}16%{transform:translate(-18px,-10px)}24%,100%{transform:translate(0,0)}}
@keyframes vlsJgoStar{0%,28%{opacity:0;transform:scale(0)}34%{opacity:1;transform:scale(1.25)}42%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-jgo-eyes", "vls-jgo-hop", "vls-jgo-star"],
  [
    [".vls-jgo-eyes,.vls-jgo-hop,.vls-jgo-star", "transform:none"],
    [".vls-jgo-star", "opacity:1"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <Pawn x={32} yb={76} s={9} />
    <g className="vls-jgo-eyes" fill={EYE}>
      <circle cx={34.6} cy={58} r={1} />
      <circle cx={38.2} cy={58} r={1} />
    </g>
    <g fill={WALL2} stroke={INK} strokeWidth={2}>
      <rect x={58} y={32} width={15} height={24} rx={4} />
      <rect x={79} y={32} width={15} height={24} rx={4} />
      <rect x={100} y={32} width={15} height={24} rx={4} />
      <rect x={121} y={32} width={15} height={24} rx={4} />
    </g>
    <g fill={INK}>
      <circle cx={65.5} cy={44} r={2.5} />
      <circle cx={86.5} cy={44} r={2.5} />
      <circle cx={107.5} cy={44} r={2.5} />
      <circle cx={128.5} cy={44} r={2.5} />
    </g>
    <rect x={224} y={16} width={40} height={58} rx={5} fill={TV_SCREEN} stroke={INK} strokeWidth={2.5} />
    <path d="M224 16 L246 24 L246 68 L224 74 Z" fill={WALL2} stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
    <circle cx={241} cy={45} r={1.8} fill={INK} />
    <g className="vls-jgo-hop">
      <Pawn x={255} yb={76} s={9} eyes />
    </g>
    <Star x={280} y={22} className="vls-jgo-star" baseOpacity={0} />
  </>
);

/* hint-route-p2p: [two pawns apart] → [direct live-green arc pawn→pawn,
   live dot on the apex]. Loop 3.2s: arc draws 6-28%, both pawns hop 30-42%,
   panel-1 pair blinks at 64%; rest ~58%. */
const HintRouteP2p: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-p2p-eyes{transform-box:fill-box;transform-origin:center;animation:vlsP2pBlink 3.2s ease-in-out infinite}
.vls-p2p-arc{stroke-dasharray:1;animation:vlsP2pArc 3.2s ease-in-out infinite}
.vls-p2p-hop{animation:vlsP2pHop 3.2s ease-in-out infinite}
@keyframes vlsP2pBlink{0%,60%,68%,100%{transform:scaleY(1)}64%{transform:scaleY(.12)}}
@keyframes vlsP2pArc{0%,6%{stroke-dashoffset:1}28%,100%{stroke-dashoffset:0}}
@keyframes vlsP2pHop{0%,30%{transform:translateY(0)}36%{transform:translateY(-4px)}42%,100%{transform:translateY(0)}}
${rmBlock(
  ["vls-p2p-eyes", "vls-p2p-arc", "vls-p2p-hop"],
  [
    [".vls-p2p-arc", "stroke-dashoffset:0"],
    [".vls-p2p-eyes,.vls-p2p-hop", "transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <Pawn x={42} yb={74} s={9} />
    <g className="vls-p2p-eyes" fill={EYE}>
      <circle cx={45} cy={56} r={1} />
      <circle cx={48.5} cy={56} r={1} />
    </g>
    <Pawn x={118} yb={74} s={9} color={SKY} />
    <g className="vls-p2p-eyes" fill={EYE}>
      <circle cx={111.5} cy={56} r={1} />
      <circle cx={115} cy={56} r={1} />
    </g>
    <g fill={FAINT}>
      <circle cx={74} cy={60} r={1.5} />
      <circle cx={88} cy={60} r={1.5} />
    </g>
    <g className="vls-p2p-hop">
      <Pawn x={202} yb={74} s={9} eyes />
      <Pawn x={278} yb={74} s={9} color={SKY} eyes />
    </g>
    <path
      className="vls-p2p-arc"
      d="M213 58 Q240 30 267 58"
      pathLength={1}
      stroke={LIVE}
      strokeWidth={3}
      strokeLinecap="round"
      fill="none"
    />
    <circle cx={240} cy={44} r={3.5} fill={LIVE} />
  </>
);

/* hint-route-sfu: [two pawns apart] → [two live-green arcs detour up
   through a lit server box]. Loop 3.2s: left arc 6-24%, right arc 14-32%,
   both pawns hop 34-46%, panel-1 pair blinks at 64%; rest ~54%. */
const HintRouteSfu: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-sfu-eyes{transform-box:fill-box;transform-origin:center;animation:vlsSfuBlink 3.2s ease-in-out infinite}
.vls-sfu-a1{stroke-dasharray:1;animation:vlsSfuA1 3.2s ease-in-out infinite}
.vls-sfu-a2{stroke-dasharray:1;animation:vlsSfuA2 3.2s ease-in-out infinite}
.vls-sfu-hop{animation:vlsSfuHop 3.2s ease-in-out infinite}
@keyframes vlsSfuBlink{0%,60%,68%,100%{transform:scaleY(1)}64%{transform:scaleY(.12)}}
@keyframes vlsSfuA1{0%,6%{stroke-dashoffset:1}24%,100%{stroke-dashoffset:0}}
@keyframes vlsSfuA2{0%,14%{stroke-dashoffset:1}32%,100%{stroke-dashoffset:0}}
@keyframes vlsSfuHop{0%,34%{transform:translateY(0)}40%{transform:translateY(-4px)}46%,100%{transform:translateY(0)}}
${rmBlock(
  ["vls-sfu-eyes", "vls-sfu-a1", "vls-sfu-a2", "vls-sfu-hop"],
  [
    [".vls-sfu-a1,.vls-sfu-a2", "stroke-dashoffset:0"],
    [".vls-sfu-eyes,.vls-sfu-hop", "transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} accent={LIVE} />
    <Pawn x={42} yb={74} s={9} />
    <g className="vls-sfu-eyes" fill={EYE}>
      <circle cx={45} cy={56} r={1} />
      <circle cx={48.5} cy={56} r={1} />
    </g>
    <Pawn x={118} yb={74} s={9} color={SKY} />
    <g className="vls-sfu-eyes" fill={EYE}>
      <circle cx={111.5} cy={56} r={1} />
      <circle cx={115} cy={56} r={1} />
    </g>
    <g fill={FAINT}>
      <circle cx={74} cy={60} r={1.5} />
      <circle cx={88} cy={60} r={1.5} />
    </g>
    <ServerBox x={228} y={12} lit />
    <g className="vls-sfu-hop">
      <Pawn x={200} yb={76} s={9} eyes />
      <Pawn x={280} yb={76} s={9} color={SKY} eyes />
    </g>
    <path
      className="vls-sfu-a1"
      d="M209 60 Q219 34 232 29"
      pathLength={1}
      stroke={LIVE}
      strokeWidth={3}
      strokeLinecap="round"
      fill="none"
    />
    <path
      className="vls-sfu-a2"
      d="M271 60 Q261 34 248 29"
      pathLength={1}
      stroke={LIVE}
      strokeWidth={3}
      strokeLinecap="round"
      fill="none"
    />
  </>
);

export const SET4_SCENES: Record<Set4Kind, HintScene> = {
  "hint-topology": HintTopology,
  "hint-close": HintClose,
  "hint-admit": HintAdmit,
  "hint-deny": HintDeny,
  "hint-rename": HintRename,
  "hint-theme": HintTheme,
  "hint-join-go": HintJoinGo,
  "hint-route-p2p": HintRouteP2p,
  "hint-route-sfu": HintRouteSfu,
};
