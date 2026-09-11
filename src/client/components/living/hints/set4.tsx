// Hint set 4 — people & misc: topology, close, rename, theme, join-go, route p2p/sfu.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
// Absolute coordinates only: any element whose class animates `transform`
// carries no transform attribute — positions are baked into path data.
import {
  BrowserWindow,
  FAINT,
  Frame,
  LIVE,
  MiniTv,
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
import type { ComicTheme } from "../Comic";
import type { HintScene, Set4Kind } from "../../../ui/visual-kinds";

const INK = "var(--ink)";
const WALL2 = "var(--wall-2)";

/* hint-topology: [one pawn with a Host badge] → [host with two leaf
   pawns on live-green edges]. Demo: leaves hop in turn (8-20%, 26-38%),
   everyone blinks at 62%; rest >=55%. */
const HintTopology: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-top-eyes{transform-box:fill-box;transform-origin:center;animation:vlsTopBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-top-leaf1{transform-box:fill-box;transform-origin:50% 100%;animation:vlsTopHop1 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-top-leaf2{transform-box:fill-box;transform-origin:50% 100%;animation:vlsTopHop2 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsTopBlink{0%,58%,66%,100%{transform:scaleY(1)}62%{transform:scaleY(.12)}}
@keyframes vlsTopHop1{0%,8%{transform:translateY(0)}14%{transform:translateY(-4px)}20%,100%{transform:translateY(0)}}
@keyframes vlsTopHop2{0%,26%{transform:translateY(0)}32%{transform:translateY(-4px)}38%,100%{transform:translateY(0)}}
${rmBlock(
  ["vls-top-eyes", "vls-top-leaf1", "vls-top-leaf2"],
  [[".vls-top-eyes,.vls-top-leaf1,.vls-top-leaf2", "transform:none"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <Pawn x={80} yb={78} s={12} eyes host eyeClassName="vls-top-eyes" />
    <g stroke={LIVE} strokeWidth={3} strokeLinecap="round" fill="none">
      <path d="M240 47 C231 50 218 52 210 56" />
      <path d="M240 47 C249 50 262 52 270 56" />
    </g>
    <Pawn x={240} yb={46} s={7} eyes host eyeClassName="vls-top-eyes" />
    <Pawn x={210} yb={80} s={7} color={SKY} eyes className="vls-top-leaf1" />
    <Pawn x={270} yb={80} s={7} color={STAR_GOLD} eyes className="vls-top-leaf2" />
  </>
);

/* hint-close: [open card] → [card folds away + small RedX stamp]. Demo:
   card wobbles (10-28%), folds out (40-52%), X stamps once at 56-62% and
   holds; rest 62-100%. */
const HintClose: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-cls-card{transform-box:fill-box;transform-origin:center;animation:vlsClsCard var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-cls-x{transform-box:fill-box;transform-origin:center;animation:vlsClsX var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
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
    <Frame x={164} w={152} theme={theme} result />
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

/* hint-rename: [blank name tag] → [pencil writes a squiggle on the tag +
   spark]. Demo: pencil rides the pen tip left→right wiggling (6-34%)
   as the line draws, spark pops 38-46%, holds; rest 54%. */
const HintRename: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-rnm-line{stroke-dasharray:1;animation:vlsRnmLine var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rnm-pencil{transform-box:fill-box;transform-origin:0% 100%;animation:vlsRnmPencil var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rnm-spark{transform-box:fill-box;transform-origin:center;animation:vlsRnmSpark var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
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
    <Frame x={164} w={152} theme={theme} result />
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

/* Show the next theme, with a short reveal and a readable final hold. */
const ThemeHint = ({ theme, light }: { theme: ComicTheme; light: boolean }) => (
  <>
    <style>{`
.vls-thm-next{transform-box:fill-box;transform-origin:center;animation:vlsThmNext var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsThmNext{0%,12%{opacity:.15;transform:scale(.75)}36%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-thm-next"],
  [[".vls-thm-next", "opacity:1;transform:none"]],
)}
`}</style>
    {[4, 164].map((x, index) => {
      const daylight = index ? light : !light;
      return <g key={x}>
        <Frame x={x} w={152} theme={theme} result={index === 1} />
        <rect x={x + 34} y={19} width={84} height={59} rx={10} fill={daylight ? "#f2e9c9" : TV_SCREEN} stroke={FAINT} strokeWidth={2} />
        <g className={index ? "vls-thm-next" : undefined}>
          {daylight ? <>
            <circle cx={x + 76} cy={48} r={12} fill={STAR_GOLD} stroke="#364358" strokeWidth={2} />
            <path d={`M${x + 76} 27 v4 M${x + 76} 65 v4 M${x + 55} 48 h4 M${x + 93} 48 h4 M${x + 61} 33 l3 3 M${x + 88} 60 l3 3 M${x + 61} 63 l3 -3 M${x + 88} 36 l3 -3`} stroke="#364358" strokeWidth={2} strokeLinecap="round" />
          </> : <>
            <path d={`M${x + 82} 32 a17 17 0 1 0 8 27 a18 18 0 0 1 -8 -27`} fill="#f2e9c9" />
            <Star x={x + 101} y={34} r={4} />
          </>}
        </g>
      </g>;
    })}
  </>
);

/* hint-join-go: [pawn beside 4 filled code slots] → [pawn hops through an
   open door + star]. Demo: blink at 62%, hop-in 8-24%, star 28-42%;
   rest ~58%. */
const HintJoinGo: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-jgo-eyes{transform-box:fill-box;transform-origin:center;animation:vlsJgoBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-jgo-hop{transform-box:fill-box;transform-origin:50% 100%;animation:vlsJgoHop var(--comic-duration,3.2s) cubic-bezier(.3,1.4,.5,1) var(--comic-repeat,1) both}
.vls-jgo-star{transform-box:fill-box;transform-origin:center;animation:vlsJgoStar var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
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
    <Frame x={164} w={152} theme={theme} result />
    <Pawn x={32} yb={76} s={9} eyes gaze={2} eyeClassName="vls-jgo-eyes" />
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

function TheaterHint({
  theme,
  exit,
}: {
  theme: Parameters<HintScene>[0]["theme"];
  exit: boolean;
}) {
  const motion = exit ? "vlsThExit" : "vlsThEnter";
  const stageClass = exit ? "vls-th-exit-stage" : "vls-th-enter-stage";
  return (
    <>
      <style>{`
.${stageClass}{transform-box:fill-box;transform-origin:center;animation:${motion} var(--comic-duration,3.2s) cubic-bezier(.3,1.25,.5,1) var(--comic-repeat,1) both}
.vls-th-arrows{animation:vlsThArrows var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsThEnter{0%,8%{transform:scale(.72)}28%,100%{transform:scale(1)}}
@keyframes vlsThExit{0%,8%{transform:scale(1.28)}28%,100%{transform:scale(1)}}
@keyframes vlsThArrows{0%,8%{opacity:0}20%,44%{opacity:1}58%,100%{opacity:.38}}
${rmBlock(
  [stageClass, "vls-th-arrows"],
  [
    [`.${stageClass}`, "transform:none"],
    [".vls-th-arrows", "opacity:.38"],
  ],
)}
`}</style>
      <Frame x={4} w={152} theme={theme} />
      <Frame x={164} w={152} theme={theme} result />
      <BrowserWindow x={16} y={12} w={128} h={72} />
      <BrowserWindow x={176} y={12} w={128} h={72} />
      {exit ? (
        <>
          <MiniTv x={28} y={32} w={104} h={44} />
          <g className={stageClass}>
            <MiniTv x={212} y={39} w={56} h={30} />
          </g>
          <path d="M198 76H282" stroke={INK} strokeWidth={2} strokeLinecap="round" />
          <rect x={222} y={78} width={36} height={3} rx={1.5} fill="var(--couch)" />
          <g className="vls-th-arrows" stroke={LIVE} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M196 32l13 11m0-9v9h-9M284 32l-13 11m0-9v9h9M196 72l13-11m0 9v-9h-9M284 72l-13-11m0 9v-9h9" />
          </g>
        </>
      ) : (
        <>
          <MiniTv x={52} y={39} w={56} h={30} />
          <path d="M38 76H122" stroke={INK} strokeWidth={2} strokeLinecap="round" />
          <rect x={62} y={78} width={36} height={3} rx={1.5} fill="var(--couch)" />
          <g className={stageClass}>
            <MiniTv x={188} y={32} w={104} h={44} />
          </g>
          <g className="vls-th-arrows" stroke={LIVE} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M211 46l-13-12m0 9v-9h9M269 46l13-12m0 9v-9h-9M211 58l-13 12m0-9v9h9M269 58l13 12m0-9v9h-9" />
          </g>
        </>
      )}
    </>
  );
}

const HintTheater: HintScene = ({ theme }) => (
  <TheaterHint theme={theme} exit={false} />
);

const HintTheaterExit: HintScene = ({ theme }) => (
  <TheaterHint theme={theme} exit />
);

/* hint-route-p2p: [two pawns apart] → [direct live-green arc pawn→pawn,
   live dot on the apex]. Demo: arc draws 6-28%, both pawns hop 30-42%,
   panel-1 pair blinks at 64%; rest ~58%. */
const HintRouteP2p: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-p2p-eyes{transform-box:fill-box;transform-origin:center;animation:vlsP2pBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-p2p-arc{stroke-dasharray:1;animation:vlsP2pArc var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-p2p-hop{animation:vlsP2pHop var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
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
    <Frame x={164} w={152} theme={theme} result />
    <Pawn x={42} yb={74} s={9} eyes gaze={2} eyeClassName="vls-p2p-eyes" />
    <Pawn x={118} yb={74} s={9} color={SKY} eyes gaze={-2} eyeClassName="vls-p2p-eyes" />
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

// Unavailable server forwarding still leaves the ordinary direct route.
const HintRouteP2pRequired: HintScene = ({ theme }) => (
  <>
    <HintRouteP2p theme={theme} />
    <ServerBox x={64} y={16} w={32} h={24} />
    <RedX cx={80} cy={28} arm={7} />
  </>
);

/* hint-route-sfu: [two pawns apart] → [two live-green arcs detour up
   through a lit server box]. Demo: left arc 6-24%, right arc 14-32%,
   both pawns hop 34-46%, panel-1 pair blinks at 64%; rest ~54%. */
const HintRouteSfu: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-sfu-eyes{transform-box:fill-box;transform-origin:center;animation:vlsSfuBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-sfu-a1{stroke-dasharray:1;animation:vlsSfuA1 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-sfu-a2{stroke-dasharray:1;animation:vlsSfuA2 var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-sfu-hop{animation:vlsSfuHop var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
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
    <Frame x={164} w={152} theme={theme} result />
    <Pawn x={42} yb={74} s={9} eyes gaze={2} eyeClassName="vls-sfu-eyes" />
    <Pawn x={118} yb={74} s={9} color={SKY} eyes gaze={-2} eyeClassName="vls-sfu-eyes" />
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

// The home mark distinguishes local sharing from a public direct route.
const HintClientLocal: HintScene = ({ theme }) => (
  <>
    <HintRouteP2p theme={theme} />
    <g fill="none" stroke={LIVE} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M173 20 180 14 187 20v7h-14Z" />
      <path d="M178 27v-5h4v5" />
    </g>
  </>
);

const HintClientSite: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-site-page{animation:vlsSitePage var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-site-star{transform-box:fill-box;transform-origin:center;animation:vlsSiteStar var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
@keyframes vlsSitePage{0%,8%{transform:translateY(4px);opacity:0}28%,100%{transform:none;opacity:1}}
@keyframes vlsSiteStar{0%,28%{opacity:0;transform:scale(0)}36%{opacity:1;transform:scale(1.2)}44%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-site-page", "vls-site-star"],
  [[".vls-site-page,.vls-site-star", "transform:none;opacity:1"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <BrowserWindow x={24} y={18} w={120} h={64} />
    <Pawn x={44} yb={75} s={8} eyes />
    <ServerBox x={74} y={42} w={36} h={24} />
    <BrowserWindow x={184} y={18} w={120} h={64} />
    <g className="vls-site-page">
      <Pawn x={205} yb={75} s={8} eyes />
      <MiniTv x={232} y={40} w={54} h={30} />
    </g>
    <Star x={290} y={37} r={5} className="vls-site-star" baseOpacity={0} />
  </>
);

/* hint-nat-prediction: [one direct path] -> [a small bounded fan of
   alternate direct paths]. The scene describes extra direct chances without
   suggesting a media relay. When unavailable, cross only the extra paths;
   the ordinary path stays neutral rather than promising a connection. */
const HintNatPrediction = ({ theme, available = true }: { theme: ComicTheme; available?: boolean }) => (
  <>
    <style>{`
.vls-nat-path{stroke-dasharray:1;animation:vlsNatPath var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-nat-dots{animation:vlsNatDots var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsNatPath{0%,8%{stroke-dashoffset:1}30%,100%{stroke-dashoffset:0}}
@keyframes vlsNatDots{0%,32%,100%{opacity:.35}44%{opacity:1}}
${rmBlock(
  ["vls-nat-path", "vls-nat-dots"],
  [[".vls-nat-path", "stroke-dashoffset:0"], [".vls-nat-dots", "opacity:1"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <Pawn x={42} yb={76} s={9} />
    <Pawn x={118} yb={76} s={9} color={SKY} />
    <path
      d="M51 60 Q80 42 109 60"
      stroke={FAINT}
      strokeWidth={2.5}
      strokeLinecap="round"
      fill="none"
    />
    <g className="vls-nat-dots" fill={FAINT}>
      <circle cx={71} cy={52} r={2} />
      <circle cx={82} cy={48} r={2} />
      <circle cx={93} cy={52} r={2} />
    </g>
    <Pawn x={202} yb={76} s={9} eyes />
    <Pawn x={278} yb={76} s={9} color={SKY} eyes />
    <path d="M211 68 Q240 56 269 68" fill="none" stroke={FAINT} strokeWidth={2.5} strokeLinecap="round" />
    <g className={available ? "vls-nat-path" : undefined} fill="none"
      stroke={available ? LIVE : FAINT} strokeWidth={2.5} strokeLinecap="round"
      strokeDasharray={available ? undefined : "4 4"}>
      <path d="M211 58 Q240 10 269 58" pathLength={available ? 1 : undefined} />
      <path d="M211 58 Q240 30 269 58" pathLength={available ? 1 : undefined} />
    </g>
    {available ? <Spark x={240} y={24} /> : <>
      <circle cx={240} cy={39} r={11} fill={theme === "paper" ? "var(--paper)" : "#0d1526"} />
      <RedX cx={240} cy={39} arm={7} />
    </>}
  </>
);

export const SET4_SCENES: Record<Set4Kind, HintScene> = {
  "hint-topology": HintTopology,
  "hint-close": HintClose,
  "hint-rename": HintRename,
  "hint-theme-light": (props) => <ThemeHint {...props} light />,
  "hint-theme-dark": (props) => <ThemeHint {...props} light={false} />,
  "hint-join-go": HintJoinGo,
  "hint-theater": HintTheater,
  "hint-theater-exit": HintTheaterExit,
  "hint-route-p2p": HintRouteP2p,
  "hint-route-p2p-required": HintRouteP2pRequired,
  "hint-route-sfu": HintRouteSfu,
  "hint-nat-prediction": (props) => <HintNatPrediction {...props} />,
  "hint-nat-unavailable": (props) => <HintNatPrediction {...props} available={false} />,
  "hint-client-local": HintClientLocal,
  "hint-client-site": HintClientSite,
};
