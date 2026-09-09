// Hint set 3 — settings: video/audio quality, degradation preference, codec, advanced door, details, more-metrics.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
import {
  FAINT,
  Frame,
  LINE,
  LIVE,
  MINT,
  MiniTv,
  Pawn,
  SKY,
  STAR_GOLD,
  Star,
  TV_BODY,
  TV_EDGE,
  rmBlock,
} from "../Comic";
import type { HintScene, Set3Kind } from "./index";

/** hint-quality: soft TV (few fat scanlines, squinting pawn) → sharp TV (many
 * thin crisp lines, one light sweep, star pop). Loop 3s. */
const hintQuality: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-vq-soft{animation:vlsVqSoft 3s ease-in-out infinite}
.vls-vq-sweep{animation:vlsVqSweep 3s ease-in-out infinite}
.vls-vq-star{transform-box:fill-box;transform-origin:center;animation:vlsVqStar 3s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsVqSoft{0%,48%,100%{opacity:.4}12%{opacity:.58}24%{opacity:.34}36%{opacity:.52}}
@keyframes vlsVqSweep{0%,22%{transform:translateX(0);opacity:0}30%{opacity:.3}48%,100%{transform:translateX(49px);opacity:0}}
@keyframes vlsVqStar{0%,55%{opacity:0;transform:scale(0)}66%{opacity:1;transform:scale(1.25)}74%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-vq-soft", "vls-vq-sweep", "vls-vq-star"],
  [
    [".vls-vq-soft", "opacity:.4"],
    [".vls-vq-sweep", "opacity:0"],
    [".vls-vq-star", "opacity:1;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    {/* BEFORE: pawn squints at a soft picture (3 fat faint scanlines) */}
    <Pawn x={26} yb={80} s={8} />
    <path d="M24 64h2.8 M27.6 64h2.8" stroke="#101a2c" strokeWidth={2} strokeLinecap="round" fill="none" />
    <MiniTv x={52} y={22} w={76} h={46} />
    <g className="vls-vq-soft" fill={LINE} opacity={0.4}>
      <rect x={63} y={33} width={52} height={6} rx={3} />
      <rect x={63} y={42} width={52} height={6} rx={3} />
      <rect x={63} y={51} width={52} height={6} rx={3} />
    </g>
    {/* AFTER: crisp thin scanlines + sweep + star; pawn brightens up */}
    <Pawn x={186} yb={80} s={8} />
    <circle cx={187} cy={62.8} r={1.2} fill="#101a2c" />
    <circle cx={190} cy={62.8} r={1.2} fill="#101a2c" />
    <MiniTv x={212} y={22} w={76} h={46} />
    <g fill={MINT} opacity={0.95}>
      <rect x={221} y={30} width={58} height={2.5} rx={1.25} />
      <rect x={221} y={35} width={58} height={2.5} rx={1.25} />
      <rect x={221} y={40} width={58} height={2.5} rx={1.25} />
      <rect x={221} y={45} width={58} height={2.5} rx={1.25} />
      <rect x={221} y={50} width={58} height={2.5} rx={1.25} />
      <rect x={221} y={55} width={58} height={2.5} rx={1.25} />
    </g>
    <rect className="vls-vq-sweep" x={218} y={28} width={9} height={30} fill="#ffffff" opacity={0} />
    <Star x={294} y={17} r={7} className="vls-vq-star" baseOpacity={0} />
  </>
);

/** hint-audio-quality: speaker with one thin faint arc (pawn leans in to
 * hear) → three bold rich arcs (happy-eye pawn static, star). Loop 3s. */
const hintAudioQuality: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-aq-weak{animation:vlsAqWeak 3s ease-in-out infinite}
.vls-aq-listen{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAqListen 3s ease-in-out infinite}
.vls-aq-a1{animation:vlsAqPing 3s ease-out infinite}
.vls-aq-a2{animation:vlsAqPing 3s ease-out .08s infinite}
.vls-aq-a3{animation:vlsAqPing 3s ease-out .16s infinite}
.vls-aq-star{transform-box:fill-box;transform-origin:center;animation:vlsAqStar 3s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsAqWeak{0%,30%,100%{opacity:.4}12%{opacity:.6}22%{opacity:.32}}
@keyframes vlsAqListen{0%,30%,58%,100%{transform:rotate(0)}40%,50%{transform:rotate(-8deg)}}
@keyframes vlsAqPing{0%,5%{opacity:.25}12%,100%{opacity:1}}
@keyframes vlsAqStar{0%,46%{opacity:0;transform:scale(0)}54%{opacity:1;transform:scale(1.25)}60%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-aq-weak", "vls-aq-listen", "vls-aq-a1", "vls-aq-a2", "vls-aq-a3", "vls-aq-star"],
  [
    [".vls-aq-weak", "opacity:.4"],
    [".vls-aq-listen,.vls-aq-star", "transform:none"],
    [".vls-aq-a1,.vls-aq-a2,.vls-aq-a3,.vls-aq-star", "opacity:1"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    {/* BEFORE: thin faint arc, pawn cups its ear and leans in */}
    <rect x={40} y={42} width={13} height={18} rx={3} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
    <path d="M53 47 L67 38 V64 L53 55 Z" fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} strokeLinejoin="round" />
    <path className="vls-aq-weak" d="M73 45 a9 9 0 0 1 0 12" stroke={LINE} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0.4} />
    <g className="vls-aq-listen">
      <Pawn x={122} yb={80} s={9} />
      <circle cx={118.5} cy={61.3} r={1.3} fill="#101a2c" />
      <circle cx={122} cy={61.3} r={1.3} fill="#101a2c" />
      <path d="M116 55 a7 7 0 0 0 0 12" stroke="#23804f" strokeWidth={2.5} strokeLinecap="round" fill="none" />
    </g>
    {/* AFTER: three bold arcs, happy-eye pawn static, star */}
    <rect x={200} y={42} width={13} height={18} rx={3} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
    <path d="M213 47 L227 38 V64 L213 55 Z" fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} strokeLinejoin="round" />
    <g stroke={LIVE} strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path className="vls-aq-a1" d="M232 46 a8 8 0 0 1 0 10" />
      <path className="vls-aq-a2" d="M237 41 a13 13 0 0 1 0 20" />
      <path className="vls-aq-a3" d="M242 36 a18 18 0 0 1 0 30" />
    </g>
    <Pawn x={282} yb={80} s={9} />
    <path d="M277.5 62 q1.7 -2.3 3.4 0 M282.5 62 q1.7 -2.3 3.4 0" stroke="#101a2c" strokeWidth={1.8} strokeLinecap="round" fill="none" />
    <Star x={257} y={21} r={6.5} className="vls-aq-star" baseOpacity={0} />
  </>
);

/** hint-degrade-pref: balance scale weighing a crisp frame against a
 * motion-blur frame (beam wobbles) → scale settles level, star. Loop 3.2s. */
const hintDegradePref: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-dp-beam{transform-box:fill-box;transform-origin:50% 0%;animation:vlsDpBeam 3.2s ease-in-out infinite}
.vls-dp-settle{transform-box:fill-box;transform-origin:50% 0%;animation:vlsDpSettle 3.2s ease-in-out infinite}
.vls-dp-star{transform-box:fill-box;transform-origin:center;animation:vlsDpStar 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsDpBeam{0%,40%,100%{transform:rotate(0)}12%{transform:rotate(5deg)}26%{transform:rotate(-4deg)}}
@keyframes vlsDpSettle{0%,16%,100%{transform:rotate(0)}4%{transform:rotate(3deg)}10%{transform:rotate(-2deg)}}
@keyframes vlsDpStar{0%,30%{opacity:0;transform:scale(0)}40%{opacity:1;transform:scale(1.25)}48%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-dp-beam", "vls-dp-settle", "vls-dp-star"],
  [
    [".vls-dp-beam,.vls-dp-settle,.vls-dp-star", "transform:none"],
    [".vls-dp-star", "opacity:1"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    {/* BEFORE: pawn watches the scale wobble — crisp frame vs blur frame */}
    <Pawn x={26} yb={80} s={7.5} />
    <circle cx={27.3} cy={64} r={1.1} fill="#101a2c" />
    <circle cx={29.7} cy={64} r={1.1} fill="#101a2c" />
    <path d="M84 78 V34 M70 78 H98" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none" />
    <g className="vls-dp-beam" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M52 34 H116" />
      <path d="M52 34 V44 M116 34 V44" strokeWidth={2} />
      <path d="M44 44 Q52 51 60 44 M44 44 H60" strokeWidth={2} />
      <path d="M108 44 Q116 51 124 44 M108 44 H124" strokeWidth={2} />
      <rect x={46.5} y={35} width={11} height={9} rx={1.5} fill="var(--paper)" strokeWidth={2} />
      <rect x={50.2} y={38} width={3.6} height={3.6} rx={0.8} fill="var(--ink)" stroke="none" />
      <rect x={104.5} y={35} width={11} height={9} rx={1.5} stroke={FAINT} strokeWidth={2} opacity={0.25} />
      <rect x={107} y={35} width={11} height={9} rx={1.5} stroke={FAINT} strokeWidth={2} opacity={0.5} />
      <rect x={109.5} y={35} width={11} height={9} rx={1.5} fill="var(--paper)" strokeWidth={2} />
    </g>
    <circle cx={84} cy={34} r={2.5} fill="var(--ink)" />
    {/* AFTER: settle once, level, star; pawn pleased */}
    <Pawn x={298} yb={80} s={7.5} />
    <path d="M294 65 q1.6 -2.2 3.2 0 M299 65 q1.6 -2.2 3.2 0" stroke="#101a2c" strokeWidth={1.8} strokeLinecap="round" fill="none" />
    <path d="M244 78 V34 M230 78 H258" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none" />
    <g className="vls-dp-settle" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M212 34 H276" />
      <path d="M212 34 V44 M276 34 V44" strokeWidth={2} />
      <path d="M204 44 Q212 51 220 44 M204 44 H220" strokeWidth={2} />
      <path d="M268 44 Q276 51 284 44 M268 44 H284" strokeWidth={2} />
      <rect x={206.5} y={35} width={11} height={9} rx={1.5} fill="var(--paper)" strokeWidth={2} />
      <rect x={210.2} y={38} width={3.6} height={3.6} rx={0.8} fill="var(--ink)" stroke="none" />
      <rect x={264.5} y={35} width={11} height={9} rx={1.5} stroke={FAINT} strokeWidth={2} opacity={0.25} />
      <rect x={267} y={35} width={11} height={9} rx={1.5} stroke={FAINT} strokeWidth={2} opacity={0.5} />
      <rect x={269.5} y={35} width={11} height={9} rx={1.5} fill="var(--paper)" strokeWidth={2} />
    </g>
    <circle cx={244} cy={34} r={2.5} fill="var(--ink)" />
    <Star x={244} y={16} r={7} className="vls-dp-star" baseOpacity={0} />
  </>
);

/** hint-codec: puzzle piece with eyes floats beside a TV with a dashed
 * socket → piece slots in, LED goes live, star. Loop 3s. */
const hintCodec: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-cd-bob{animation:vlsCdBob 3s ease-in-out infinite}
.vls-cd-dock{animation:vlsCdDock 3s cubic-bezier(.3,1.5,.5,1) infinite}
.vls-cd-star{transform-box:fill-box;transform-origin:center;animation:vlsCdStar 3s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsCdBob{0%,40%,100%{transform:translateY(0)}20%{transform:translateY(-2.5px)}}
@keyframes vlsCdDock{0%,6%{transform:translateX(-8px)}20%{transform:translateX(1px)}26%,100%{transform:translateX(0)}}
@keyframes vlsCdStar{0%,32%{opacity:0;transform:scale(0)}42%{opacity:1;transform:scale(1.25)}50%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-cd-bob", "vls-cd-dock", "vls-cd-star"],
  [
    [".vls-cd-bob,.vls-cd-dock,.vls-cd-star", "transform:none"],
    [".vls-cd-star", "opacity:1"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    {/* BEFORE: piece bobs beside the TV, dashed socket waits on the edge */}
    <g className="vls-cd-bob">
      <path
        d="M40 34 a4 4 0 0 1 4-4 h16 a4 4 0 0 1 4 4 v5 a3.5 3.5 0 0 1 0 7 v4 a4 4 0 0 1-4 4 h-16 a4 4 0 0 1-4-4 Z"
        fill={STAR_GOLD}
        stroke="var(--ink)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <circle cx={48.5} cy={39} r={1.5} fill="#101a2c" />
      <circle cx={55.5} cy={39} r={1.5} fill="#101a2c" />
    </g>
    <MiniTv x={92} y={22} w={52} h={40} />
    <path d="M92 37 a5 5 0 0 1 0 10" stroke={FAINT} strokeWidth={2} strokeLinecap="round" strokeDasharray="3 3" fill="none" />
    <circle cx={118} cy={68} r={2.5} fill={TV_EDGE} />
    {/* AFTER: piece docked flush, happy eyes, LED live, star */}
    <MiniTv x={252} y={22} w={52} h={40} />
    <circle cx={278} cy={68} r={2.5} fill={LIVE} />
    <g className="vls-cd-dock">
      <path
        d="M224 34 a4 4 0 0 1 4-4 h16 a4 4 0 0 1 4 4 v5 a3.5 3.5 0 0 1 0 7 v4 a4 4 0 0 1-4 4 h-16 a4 4 0 0 1-4-4 Z"
        fill={STAR_GOLD}
        stroke="var(--ink)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path d="M234 40 q1.8 -2.4 3.6 0 M241 40 q1.8 -2.4 3.6 0" stroke="#101a2c" strokeWidth={1.8} strokeLinecap="round" fill="none" />
    </g>
    <Star x={284} y={16} r={7} className="vls-cd-star" baseOpacity={0} />
  </>
);

/** hint-advanced: closed cabinet door with a sliders glyph → door swings
 * open revealing 3 slider tracks with set knobs; pawn hops. Loop 3.2s. */
const hintAdvanced: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-adv-blink{transform-box:fill-box;transform-origin:center;animation:vlsAdvBlink 3.2s ease-in-out infinite}
.vls-adv-door{transform-box:fill-box;transform-origin:left center;animation:vlsAdvDoor 3.2s ease-in-out infinite}
.vls-adv-hop{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdvHop 3.2s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsAdvBlink{0%,52%,60%,100%{transform:scaleY(1)}56%{transform:scaleY(.12)}}
@keyframes vlsAdvDoor{0%,8%{transform:scaleX(1)}26%{transform:scaleX(.09)}33%,100%{transform:scaleX(.14)}}
@keyframes vlsAdvHop{0%,40%,62%,100%{transform:translateY(0)}46%{transform:translateY(-4.5px)}52%{transform:translateY(0)}57%{transform:translateY(-2px)}}
${rmBlock(
  ["vls-adv-blink", "vls-adv-door", "vls-adv-hop"],
  [
    [".vls-adv-blink,.vls-adv-hop", "transform:none"],
    [".vls-adv-door", "transform:scaleX(.14)"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    {/* BEFORE: closed door, sliders glyph embossed, pawn glances over */}
    <rect x={44} y={18} width={56} height={60} rx={8} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <rect x={49} y={23} width={44} height={50} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    <path d="M56 36 H74 M56 46 H74" stroke={FAINT} strokeWidth={2} strokeLinecap="round" fill="none" />
    <circle cx={64} cy={36} r={2.5} fill="var(--ink)" />
    <circle cx={70} cy={46} r={2.5} fill="var(--ink)" />
    <circle cx={87} cy={48} r={2.5} fill="var(--ink)" />
    <Pawn x={122} yb={80} s={7.5} />
    <g className="vls-adv-blink">
      <circle cx={118.6} cy={64.2} r={1.2} fill="#101a2c" />
      <circle cx={122} cy={64.2} r={1.2} fill="#101a2c" />
    </g>
    {/* AFTER: tracks + set knobs revealed as the door swings open */}
    <rect x={204} y={18} width={56} height={60} rx={8} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <g stroke={FAINT} strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M215 34 H251" />
      <path d="M215 48 H251" />
      <path d="M215 62 H251" />
    </g>
    <circle cx={222} cy={34} r={4} fill={LIVE} stroke="var(--ink)" strokeWidth={1.5} />
    <circle cx={242} cy={48} r={4} fill={STAR_GOLD} stroke="var(--ink)" strokeWidth={1.5} />
    <circle cx={230} cy={62} r={4} fill={SKY} stroke="var(--ink)" strokeWidth={1.5} />
    <g className="vls-adv-door">
      <rect x={209} y={23} width={44} height={50} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    </g>
    <g className="vls-adv-hop">
      <Pawn x={284} yb={80} s={7.5} />
      <circle cx={281} cy={64.2} r={1.2} fill="#101a2c" />
      <circle cx={284.4} cy={64.2} r={1.2} fill="#101a2c" />
    </g>
  </>
);

/** hint-details: a plain row of meter bars → magnifier pops over the bars,
 * enlarged inside the lens; pawn peeks. Loop 3s. */
const hintDetails: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-dt-lens{transform-box:fill-box;transform-origin:center;animation:vlsDtLens 3s cubic-bezier(.3,1.5,.5,1) infinite}
.vls-dt-blink{transform-box:fill-box;transform-origin:center;animation:vlsDtBlink 3s ease-in-out infinite}
@keyframes vlsDtLens{0%,6%{transform:scale(0);opacity:0}14%{transform:scale(1.12);opacity:1}20%,100%{transform:scale(1);opacity:1}}
@keyframes vlsDtBlink{0%,56%,64%,100%{transform:scaleY(1)}60%{transform:scaleY(.12)}}
${rmBlock(
  ["vls-dt-lens", "vls-dt-blink"],
  [
    [".vls-dt-lens", "transform:none;opacity:1"],
    [".vls-dt-blink", "transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    {/* BEFORE: plain bar row, pawn looks on */}
    <path d="M28 74 H116" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none" />
    <g fill="var(--ink)">
      <rect x={34} y={60} width={8} height={14} rx={2.5} />
      <rect x={50} y={50} width={8} height={24} rx={2.5} />
      <rect x={66} y={56} width={8} height={18} rx={2.5} />
      <rect x={82} y={44} width={8} height={30} rx={2.5} />
      <rect x={98} y={52} width={8} height={22} rx={2.5} />
    </g>
    <Pawn x={132} yb={80} s={7} />
    <circle cx={129.8} cy={65.2} r={1.2} fill="#101a2c" />
    <circle cx={132.6} cy={65.2} r={1.2} fill="#101a2c" />
    {/* AFTER: magnifier over the same bars, enlarged inside the lens */}
    <path d="M188 74 H276" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none" />
    <g fill="var(--ink)">
      <rect x={194} y={60} width={8} height={14} rx={2.5} />
      <rect x={210} y={50} width={8} height={24} rx={2.5} />
      <rect x={226} y={56} width={8} height={18} rx={2.5} />
      <rect x={242} y={44} width={8} height={30} rx={2.5} />
      <rect x={258} y={52} width={8} height={22} rx={2.5} />
    </g>
    <g className="vls-dt-lens">
      <circle cx={232} cy={52} r={21} fill="var(--paper)" stroke="var(--ink)" strokeWidth={3} />
      <path d="M247 67 L258 78" stroke="var(--ink)" strokeWidth={4} strokeLinecap="round" fill="none" />
      <g fill="var(--ink)">
        <rect x={214} y={42} width={10} height={30} rx={3} />
        <rect x={227} y={50} width={10} height={22} rx={3} />
        <rect x={240} y={40} width={10} height={32} rx={3} />
      </g>
    </g>
    <Pawn x={296} yb={80} s={7} />
    <g className="vls-dt-blink">
      <circle cx={293.4} cy={65.6} r={1.2} fill="#101a2c" />
      <circle cx={296.2} cy={65.6} r={1.2} fill="#101a2c" />
    </g>
  </>
);

/** hint-more-metrics: one meter row + chevron-down (beckons) → three rows
 * unfold with overshoot + chevron-up. Loop 3s. */
const hintMoreMetrics: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-mm-chev{animation:vlsMmChev 3s ease-in-out infinite}
.vls-mm-r2{animation:vlsMmIn 3s cubic-bezier(.3,1.5,.5,1) infinite}
.vls-mm-r3{animation:vlsMmIn 3s cubic-bezier(.3,1.5,.5,1) .12s infinite}
@keyframes vlsMmChev{0%,30%,100%{transform:translateY(0)}15%{transform:translateY(2.5px)}}
@keyframes vlsMmIn{0%{opacity:0;transform:translateY(-7px)}8%{opacity:1;transform:translateY(1px)}14%,100%{opacity:1;transform:translateY(0)}}
${rmBlock(
  ["vls-mm-chev", "vls-mm-r2", "vls-mm-r3"],
  [
    [".vls-mm-chev", "transform:none"],
    [".vls-mm-r2,.vls-mm-r3", "opacity:1;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    {/* BEFORE: one folded row, chevron-down bobs, pawn watches */}
    <rect x={34} y={32} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
    <g fill="var(--ink)">
      <rect x={46} y={38} width={5} height={5} rx={1.5} />
      <rect x={56} y={35} width={5} height={8} rx={1.5} />
      <rect x={66} y={37} width={5} height={6} rx={1.5} />
      <circle cx={80} cy={39.5} r={2} />
    </g>
    <path className="vls-mm-chev" d="M70 62 l10 8 l10 -8" stroke="var(--ink)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <Pawn x={140} yb={80} s={6} />
    <circle cx={138.2} cy={67.4} r={1} fill="#101a2c" />
    <circle cx={140.6} cy={67.4} r={1} fill="#101a2c" />
    {/* AFTER: three rows unfolded, chevron-up on top */}
    <path d="M230 22 l10 -7 l10 7" stroke="var(--ink)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <rect x={194} y={28} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
    <g fill="var(--ink)">
      <rect x={206} y={34} width={5} height={5} rx={1.5} />
      <rect x={216} y={31} width={5} height={8} rx={1.5} />
      <rect x={226} y={33} width={5} height={6} rx={1.5} />
      <circle cx={240} cy={35.5} r={2} />
    </g>
    <g className="vls-mm-r2">
      <rect x={194} y={46} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
      <rect x={206} y={52} width={5} height={5} rx={1.5} fill={LIVE} />
      <rect x={216} y={49} width={5} height={8} rx={1.5} fill={LIVE} />
      <rect x={226} y={51} width={5} height={6} rx={1.5} fill={LIVE} />
      <circle cx={240} cy={53.5} r={2} fill={LIVE} />
    </g>
    <g className="vls-mm-r3">
      <rect x={194} y={64} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
      <rect x={206} y={70} width={5} height={5} rx={1.5} fill={STAR_GOLD} />
      <rect x={216} y={67} width={5} height={8} rx={1.5} fill={STAR_GOLD} />
      <rect x={226} y={69} width={5} height={6} rx={1.5} fill={STAR_GOLD} />
      <circle cx={240} cy={71.5} r={2} fill={STAR_GOLD} />
    </g>
    <Pawn x={300} yb={80} s={6} />
    <circle cx={298.2} cy={67.4} r={1} fill="#101a2c" />
    <circle cx={300.6} cy={67.4} r={1} fill="#101a2c" />
  </>
);

const hintDebugExport: HintScene = ({ theme }) => (
  <>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <path d="M32 72H128" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />
    <g fill="var(--ink)">
      <rect x={40} y={54} width={12} height={18} rx={2.5} />
      <rect x={62} y={36} width={12} height={36} rx={2.5} />
      <rect x={84} y={46} width={12} height={26} rx={2.5} />
      <rect x={106} y={26} width={12} height={46} rx={2.5} />
    </g>
    <rect x={218} y={14} width={44} height={42} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} />
    <path d="M228 45V35M240 45V25M252 45V31" stroke={LIVE} strokeWidth={5} strokeLinecap="round" />
    <path d="M240 61V73M234 68L240 74L246 68M215 74V84H265V74" fill="none"
      stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </>
);

export const SET3_SCENES: Record<Set3Kind, HintScene> = {
  "hint-quality": hintQuality,
  "hint-audio-quality": hintAudioQuality,
  "hint-degrade-pref": hintDegradePref,
  "hint-codec": hintCodec,
  "hint-advanced": hintAdvanced,
  "hint-details": hintDetails,
  "hint-debug-export": hintDebugExport,
  "hint-more-metrics": hintMoreMetrics,
};
