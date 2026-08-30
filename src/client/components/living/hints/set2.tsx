// Hint set 2 — room & invite: code copy/shuffle, invite copy/rotate/revoke, policy open/private, password.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
// Paper idioms: var(--ink)/var(--wall-2)/var(--paper) carry the drawing;
// room codes are always 4 abstract digit slots, never real digits.
import {
  Door,
  FAINT,
  Frame,
  INK_STAGE,
  Pawn,
  RedX,
  SKY,
  Spark,
  Star,
  STAR_GOLD,
  TV_SCREEN,
  rmBlock,
} from "../Comic";
import type { HintScene, Set2Kind } from "./index";

/* LCD code card: pale body, dark screen, 4 abstract digit slots at +12/+27/
   +42/+57 inside the 78x46 body. */
const SLOT_DX = [12, 27, 42, 57] as const;

function LcdBase({ x, y }: { x: number; y: number }) {
  return (
    <>
      <rect
        x={x}
        y={y}
        width={78}
        height={46}
        rx={9}
        fill="var(--wall-2)"
        stroke="var(--ink)"
        strokeWidth={2.5}
      />
      <rect x={x + 6} y={y + 6} width={66} height={34} rx={5} fill={TV_SCREEN} />
    </>
  );
}

function LcdSlots({
  x,
  y,
  className,
}: {
  x: number;
  y: number;
  className?: string;
}) {
  const slots = (
    <>
      {SLOT_DX.map((dx) => (
        <rect
          key={dx}
          x={x + dx}
          y={y + 17}
          width={9}
          height={10}
          rx={2}
          fill="none"
          stroke={INK_STAGE}
          strokeWidth={2}
        />
      ))}
    </>
  );
  return className ? <g className={className}>{slots}</g> : slots;
}

/** One chain link: a stadium ring, optionally tilted (static transform). */
function LinkRing({
  x,
  y,
  w,
  h,
  tilt = 0,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  tilt?: number;
}) {
  const ring = (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={h / 2}
      fill="var(--paper)"
      stroke="var(--ink)"
      strokeWidth={2.5}
    />
  );
  return tilt ? <g transform={`rotate(${tilt} ${x + w / 2} ${y + h / 2})`}>{ring}</g> : ring;
}

/** Open doorway: warm lit frame + leaf swung open on the left hinge. */
function OpenDoorway({ x, y }: { x: number; y: number }) {
  return (
    <>
      <rect
        x={x}
        y={y}
        width={32}
        height={56}
        rx={5}
        fill={STAR_GOLD}
        opacity={0.3}
        stroke="var(--ink)"
        strokeWidth={2.5}
      />
      <path
        d={`M${x} ${y} L${x - 12} ${y + 6} L${x - 12} ${y + 62} L${x} ${y + 56} Z`}
        fill="var(--wall-2)"
        stroke="var(--ink)"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <circle cx={x - 8} cy={y + 32} r={1.8} fill="var(--ink)" />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* hint-copy-code: tap the code card → a second copy + star.           */
/* ------------------------------------------------------------------ */
const SceneCopyCode: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-copy-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsCopyLean 2.6s ease-in-out infinite}
.vls-copy-ring{transform-box:fill-box;transform-origin:center;animation:vlsCopyRing 2.6s ease-out infinite}
.vls-copy-front{transform-box:fill-box;transform-origin:50% 100%;animation:vlsCopyHop 2.6s ease-in-out infinite}
.vls-copy-star{transform-box:fill-box;transform-origin:center;animation:vlsCopyStar 2.6s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsCopyLean{0%,8%{transform:rotate(0)}18%,30%{transform:rotate(7deg)}42%,100%{transform:rotate(0)}}
@keyframes vlsCopyRing{0%,14%{transform:scale(.6);opacity:0}20%{opacity:.8}38%,100%{transform:scale(1.7);opacity:0}}
@keyframes vlsCopyHop{0%,12%{transform:translateY(0)}20%{transform:translateY(-2.5px)}30%,100%{transform:translateY(0)}}
@keyframes vlsCopyStar{0%,14%{opacity:0;transform:scale(0)}24%{opacity:1;transform:scale(1.25)}32%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-copy-pawn", "vls-copy-ring", "vls-copy-front", "vls-copy-star"],
  [
    [".vls-copy-ring", "opacity:0"],
    [".vls-copy-star", "opacity:1;transform:scale(1)"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <LcdBase x={58} y={22} />
    <LcdSlots x={58} y={22} />
    <circle
      className="vls-copy-ring"
      cx={57}
      cy={45}
      r={6}
      fill="none"
      stroke={SKY}
      strokeWidth={2.5}
      opacity={0}
    />
    <Pawn x={38} yb={76} s={9} eyes className="vls-copy-pawn" />
    <LcdBase x={210} y={18} />
    <g className="vls-copy-front">
      <LcdBase x={190} y={32} />
      <LcdSlots x={190} y={32} />
    </g>
    <Star x={292} y={22} r={7} className="vls-copy-star" baseOpacity={0} />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-shuffle-code: slots at rest → slots mid-roll + spark.          */
/* ------------------------------------------------------------------ */
const SceneShuffleCode: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-shuf-slots{opacity:.45}
.vls-shuf-roll{animation:vlsShufRoll 2.4s linear infinite}
.vls-shuf-spark{transform-box:fill-box;transform-origin:center;animation:vlsShufSpark 2.4s ease-out infinite}
@keyframes vlsShufRoll{0%{transform:translateY(-2px)}8%{transform:translateY(2px)}16%{transform:translateY(-2px)}24%{transform:translateY(2px)}32%{transform:translateY(-1px)}40%,100%{transform:translateY(0)}}
@keyframes vlsShufSpark{0%,8%{opacity:0;transform:scale(.5)}16%{opacity:1;transform:scale(1.1)}22%,70%{opacity:1;transform:scale(1)}82%,100%{opacity:0}}
${rmBlock(
  ["vls-shuf-roll", "vls-shuf-spark"],
  [
    [".vls-shuf-roll", "transform:none"],
    [".vls-shuf-spark", "opacity:1;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <LcdBase x={41} y={25} />
    <LcdSlots x={41} y={25} />
    <LcdBase x={201} y={25} />
    <LcdSlots x={201} y={25} className="vls-shuf-slots" />
    <g className="vls-shuf-roll" fill={INK_STAGE} opacity={0.9}>
      {SLOT_DX.map((dx) => (
        <g key={dx}>
          <rect x={202 + dx} y={43.5} width={7} height={1.8} rx={0.9} />
          <rect x={202 + dx} y={47} width={7} height={1.8} rx={0.9} />
          <rect x={202 + dx} y={50.5} width={7} height={1.8} rx={0.9} />
        </g>
      ))}
    </g>
    <Spark x={288} y={30} className="vls-shuf-spark" />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-copy-invite: pawn balancing a link → link arcs to a friend.    */
/* ------------------------------------------------------------------ */
const SceneCopyInvite: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-cinv-eyes{transform-box:fill-box;transform-origin:center;animation:vlsCinvBlink 2.8s ease-in-out infinite}
.vls-cinv-fly{animation:vlsCinvFly 2.8s ease-in-out infinite}
.vls-cinv-arc{animation:vlsCinvArc 2.8s ease-in-out infinite}
.vls-cinv-star{transform-box:fill-box;transform-origin:center;animation:vlsCinvStar 2.8s cubic-bezier(.3,1.5,.5,1) infinite}
@keyframes vlsCinvBlink{0%,60%,68%,100%{transform:scaleY(1)}64%{transform:scaleY(.12)}}
@keyframes vlsCinvFly{0%,6%{transform:translate(-92px,0);opacity:0}10%{opacity:1}32%{transform:translate(-46px,-20px)}50%{transform:translate(0,0)}56%{transform:translate(0,-3px)}62%,100%{transform:translate(0,0)}}
@keyframes vlsCinvArc{0%,10%{opacity:0}20%{opacity:.7}55%{opacity:.7}72%,100%{opacity:0}}
@keyframes vlsCinvStar{0%,50%{opacity:0;transform:scale(0)}58%{opacity:1;transform:scale(1.25)}66%,100%{opacity:1;transform:scale(1)}}
${rmBlock(
  ["vls-cinv-eyes", "vls-cinv-fly", "vls-cinv-arc", "vls-cinv-star"],
  [
    [".vls-cinv-fly", "transform:none;opacity:1"],
    [".vls-cinv-arc", "opacity:.35"],
    [".vls-cinv-star", "opacity:1"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <Pawn x={62} yb={76} s={10} />
    <g className="vls-cinv-eyes" fill="#101a2c">
      <circle cx={59.8} cy={56} r={1.1} />
      <circle cx={64.2} cy={56} r={1.1} />
    </g>
    <LinkRing x={50} y={27.5} w={24} h={13} tilt={-12} />
    <path
      className="vls-cinv-arc"
      d="M196 50 Q242 14 288 50"
      stroke={FAINT}
      strokeWidth={2}
      strokeDasharray="4 4"
      fill="none"
      opacity={0}
    />
    <Pawn x={196} yb={76} s={8.5} eyes />
    <Pawn x={288} yb={76} s={8.5} eyes color={SKY} />
    <g className="vls-cinv-fly" opacity={0}>
      <LinkRing x={278} y={31.5} w={20} h={11} tilt={-12} />
    </g>
    <Star x={288} y={16} r={6} className="vls-cinv-star" baseOpacity={0} />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-rotate-invite: a link → the link spun fresh + spark.           */
/* ------------------------------------------------------------------ */
const SceneRotateInvite: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-rinv-ring{transform-box:view-box;transform-origin:240px 48px;animation:vlsRinvSpin 2.6s ease-in-out infinite}
.vls-rinv-spark{transform-box:fill-box;transform-origin:center;animation:vlsRinvSpark 2.6s ease-out infinite}
@keyframes vlsRinvSpin{0%,10%{transform:rotate(0)}50%,100%{transform:rotate(360deg)}}
@keyframes vlsRinvSpark{0%,44%{opacity:0;transform:scale(.5)}54%{opacity:1;transform:scale(1.1)}62%,82%{opacity:1;transform:scale(1)}92%,100%{opacity:0}}
${rmBlock(
  ["vls-rinv-ring", "vls-rinv-spark"],
  [[".vls-rinv-spark", "opacity:1;transform:none"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <LinkRing x={65} y={40} w={30} h={16} tilt={-15} />
    <LinkRing x={225} y={40} w={30} h={16} tilt={-15} />
    <g
      className="vls-rinv-ring"
      stroke={SKY}
      strokeWidth={2.5}
      strokeLinecap="round"
      fill="none"
    >
      <path d="M240 28 A20 20 0 1 1 220 48" />
      <path d="M227 46 L220 48 L222 55" />
    </g>
    <Spark x={272} y={24} className="vls-rinv-spark" />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-revoke-invite: intact chain → snapped, ends droop, red-X.      */
/* ------------------------------------------------------------------ */
const SceneRevokeInvite: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-rev-l{transform-box:view-box;transform-origin:223px 52.5px;animation:vlsRevL 2.8s ease-in-out infinite}
.vls-rev-r{transform-box:view-box;transform-origin:257px 52.5px;animation:vlsRevR 2.8s ease-in-out infinite}
.vls-rev-x{transform-box:fill-box;transform-origin:center;animation:vlsRevX 2.8s ease-out infinite}
@keyframes vlsRevL{0%,10%{transform:translate(9px,-4.5px) rotate(-18deg)}20%{transform:translate(-2px,1px) rotate(5deg)}30%,100%{transform:translate(0,0) rotate(0)}}
@keyframes vlsRevR{0%,10%{transform:translate(-9px,-4.5px) rotate(18deg)}20%{transform:translate(2px,1px) rotate(-5deg)}30%,100%{transform:translate(0,0) rotate(0)}}
@keyframes vlsRevX{0%,30%{opacity:0;transform:scale(1.6) rotate(8deg)}38%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
${rmBlock(
  ["vls-rev-l", "vls-rev-r", "vls-rev-x"],
  [[".vls-rev-x", "opacity:1;transform:scale(1) rotate(8deg)"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <LinkRing x={56} y={41} w={28} h={14} />
    <LinkRing x={76} y={41} w={28} h={14} />
    <g className="vls-rev-l">
      <g transform="rotate(18 223 52.5)">
        <rect
          x={210}
          y={46}
          width={26}
          height={13}
          rx={6.5}
          fill="var(--paper)"
          stroke="var(--ink)"
          strokeWidth={2.5}
        />
      </g>
    </g>
    <g className="vls-rev-r">
      <g transform="rotate(-18 257 52.5)">
        <rect
          x={244}
          y={46}
          width={26}
          height={13}
          rx={6.5}
          fill="var(--paper)"
          stroke="var(--ink)"
          strokeWidth={2.5}
        />
      </g>
    </g>
    <RedX cx={240} cy={38} arm={5} className="vls-rev-x" />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-policy-open: shut door → door wide open, two pawns hop in.     */
/* ------------------------------------------------------------------ */
const ScenePolicyOpen: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-open-p1{transform-box:fill-box;transform-origin:50% 100%;animation:vlsOpenHop 2.8s ease-in-out infinite}
.vls-open-p2{transform-box:fill-box;transform-origin:50% 100%;animation:vlsOpenHop 2.8s ease-in-out .2s infinite}
@keyframes vlsOpenHop{0%,6%{transform:translateY(0)}14%{transform:translateY(-5px)}22%{transform:translateY(0)}28%{transform:translateY(-3px)}34%,100%{transform:translateY(0)}}
${rmBlock(["vls-open-p1", "vls-open-p2"], [])}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <Door x={64} y={20} />
    <OpenDoorway x={224} y={18} />
    <Pawn x={238} yb={74} s={6.5} eyes className="vls-open-p1" />
    <Pawn x={206} yb={78} s={5.5} eyes color={SKY} className="vls-open-p2" />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-policy-private: open door → shut + locked, one pawn waits with */
/* its little invite card.                                             */
/* ------------------------------------------------------------------ */
const ScenePolicyPrivate: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-priv-eyes{transform-box:fill-box;transform-origin:center;animation:vlsPrivBlink 3s ease-in-out infinite}
.vls-priv-card{transform-box:fill-box;transform-origin:center;animation:vlsPrivCard 3s ease-in-out infinite}
.vls-priv-door{transform-box:fill-box;transform-origin:0% 50%;animation:vlsPrivDoor 3s cubic-bezier(.3,.8,.35,1) infinite}
.vls-priv-lock{transform-box:fill-box;transform-origin:center;animation:vlsPrivLock 3s cubic-bezier(.3,1.4,.45,1) infinite}
.vls-priv-click{transform-box:fill-box;transform-origin:center;animation:vlsPrivClick 3s ease-out infinite}
@keyframes vlsPrivBlink{0%,52%,60%,100%{transform:scaleY(1)}56%{transform:scaleY(.12)}}
@keyframes vlsPrivCard{0%,8%{transform:translateY(2px) rotate(-3deg)}18%{transform:translateY(-3px) rotate(4deg)}28%,100%{transform:none}}
@keyframes vlsPrivDoor{0%,10%{transform:scaleX(.18);opacity:.45}28%,100%{transform:scaleX(1);opacity:1}}
@keyframes vlsPrivLock{0%,24%{transform:translateY(-6px);opacity:0}34%{transform:translateY(1px);opacity:1}40%,100%{transform:none;opacity:1}}
@keyframes vlsPrivClick{0%,32%{opacity:0;transform:scale(.45)}38%{opacity:1;transform:scale(1.12)}48%,100%{opacity:0;transform:scale(1)}}
${rmBlock(
  ["vls-priv-eyes", "vls-priv-card", "vls-priv-door", "vls-priv-lock", "vls-priv-click"],
  [
    [".vls-priv-card,.vls-priv-door,.vls-priv-lock", "transform:none;opacity:1"],
    [".vls-priv-click", "opacity:.65;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <OpenDoorway x={64} y={18} />
    <Pawn x={204} yb={76} s={8} />
    <g className="vls-priv-eyes" fill="#101a2c">
      <circle cx={201.8} cy={60} r={0.9} />
      <circle cx={206.2} cy={60} r={0.9} />
    </g>
    <g className="vls-priv-card">
      <g transform="rotate(-10 202 44)">
        <rect
          x={195}
          y={39}
          width={14}
          height={10}
          rx={2}
          fill="var(--paper)"
          stroke="var(--ink)"
          strokeWidth={1.5}
        />
        <path
          d="M197.5 42.5 h4 M197.5 45.5 h6"
          stroke="var(--ink)"
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      </g>
    </g>
    <Door x={224} y={18} className="vls-priv-door" />
    <g className="vls-priv-lock">
      <path
        d="M235 38 v-5 a5.5 5.5 0 0 1 11 0 v5"
        stroke="var(--ink)"
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
      />
      <rect
        x={232}
        y={38}
        width={16}
        height={13}
        rx={3}
        fill={STAR_GOLD}
        stroke="var(--ink)"
        strokeWidth={2}
      />
      <circle cx={240} cy={44} r={1.8} fill="var(--ink)" />
    </g>
    <Spark x={253} y={35} className="vls-priv-click" />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-password: key approaches the lock → shackle up, door ajar.     */
/* ------------------------------------------------------------------ */
const ScenePassword: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-pass-key{animation:vlsPassKey 2.8s ease-in-out infinite}
.vls-pass-lines{animation:vlsPassLines 2.8s ease-in-out infinite}
.vls-pass-shackle{transform-box:view-box;transform-origin:190px 44px;animation:vlsPassShackle 2.8s ease-in-out infinite}
.vls-pass-glow{animation:vlsPassGlow 2.8s ease-in-out infinite}
@keyframes vlsPassKey{0%{transform:translateX(0);opacity:0}6%{opacity:1}30%{transform:translateX(26px)}68%{transform:translateX(26px);opacity:1}80%{transform:translateX(26px);opacity:0}82%,100%{transform:translateX(0);opacity:0}}
@keyframes vlsPassLines{0%,4%{opacity:0}10%{opacity:.9}24%{opacity:.9}32%,100%{opacity:0}}
@keyframes vlsPassShackle{0%,8%{transform:rotate(34deg)}20%{transform:rotate(-6deg)}28%,100%{transform:rotate(0)}}
@keyframes vlsPassGlow{0%,30%{opacity:.3}42%{opacity:.65}55%,100%{opacity:.3}}
${rmBlock(
  ["vls-pass-key", "vls-pass-lines", "vls-pass-shackle", "vls-pass-glow"],
  [
    [".vls-pass-key", "transform:translateX(26px);opacity:1"],
    [".vls-pass-lines", "opacity:0"],
    [".vls-pass-glow", "opacity:.45"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} />
    <g className="vls-pass-lines" opacity={0}>
      <path d="M42 42 l-7 -2 M42 52 l-7 2" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
    </g>
    <g className="vls-pass-key" opacity={0}>
      <circle cx={52} cy={47} r={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} />
      <path d="M57 47 h14 M66 47 v4 M70 47 v4" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />
    </g>
    <path
      d="M92 40 v-5 a6 6 0 0 1 12 0 v5"
      stroke="var(--ink)"
      strokeWidth={2.5}
      fill="none"
      strokeLinecap="round"
    />
    <rect
      x={88}
      y={40}
      width={18}
      height={14}
      rx={3}
      fill={STAR_GOLD}
      stroke="var(--ink)"
      strokeWidth={2}
    />
    <circle cx={97} cy={47} r={1.8} fill="var(--ink)" />
    <rect
      className="vls-pass-glow"
      x={230}
      y={16}
      width={36}
      height={58}
      rx={5}
      fill={SKY}
      opacity={0.3}
    />
    <rect
      x={230}
      y={16}
      width={36}
      height={58}
      rx={5}
      fill="none"
      stroke="var(--ink)"
      strokeWidth={2.5}
    />
    <path
      d="M230 16 L260 20 L260 70 L230 74 Z"
      fill="var(--wall-2)"
      stroke="var(--ink)"
      strokeWidth={2.5}
      strokeLinejoin="round"
    />
    <circle cx={254} cy={46} r={1.8} fill="var(--ink)" />
    <rect
      x={186}
      y={44}
      width={18}
      height={14}
      rx={3}
      fill={STAR_GOLD}
      stroke="var(--ink)"
      strokeWidth={2}
    />
    <circle cx={195} cy={51} r={1.8} fill="var(--ink)" />
    <path
      className="vls-pass-shackle"
      d="M190 44 v-5 a6 6 0 0 1 11.8 -2.2"
      stroke="var(--ink)"
      strokeWidth={2.5}
      fill="none"
      strokeLinecap="round"
    />
  </>
);

export const SET2_SCENES: Record<Set2Kind, HintScene> = {
  "hint-copy-code": SceneCopyCode,
  "hint-shuffle-code": SceneShuffleCode,
  "hint-copy-invite": SceneCopyInvite,
  "hint-rotate-invite": SceneRotateInvite,
  "hint-revoke-invite": SceneRevokeInvite,
  "hint-policy-open": ScenePolicyOpen,
  "hint-policy-private": ScenePolicyPrivate,
  "hint-password": ScenePassword,
};
