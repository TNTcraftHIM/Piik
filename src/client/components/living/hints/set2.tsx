// Hint set 2 — room & invite: code copy/shuffle, invite copy/rotate/revoke, policy open/private, password.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
// Paper idioms: var(--ink)/var(--wall-2)/var(--paper) carry the drawing;
// room codes are always 4 abstract digit slots, never real digits.
import {
  BrowserWindow,
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
import type { HintScene, Set2Kind } from "../../../ui/visual-kinds";

// A settled card or held link rests in place; it does not repeat its operation.
function RoomResultMotion() {
  return <style>{`
:where(svg[data-comic-motion="still"]) .vls-room-result{transform-box:fill-box;transform-origin:center;animation:vlsRoomResult var(--comic-duration,3.2s) ease-out 1 both}
@keyframes vlsRoomResult{0%,8%{transform:translateY(-4px) rotate(-4deg)}30%,100%{transform:none}}
${rmBlock(["vls-room-result"], [[".vls-room-result", "transform:none"]], false)}
`}</style>;
}

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
    <RoomResultMotion />
    <style>{`
.vls-copy-pawn{transform-box:fill-box;transform-origin:50% 100%;animation:vlsCopyLean var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-copy-ring{transform-box:fill-box;transform-origin:center;animation:vlsCopyRing var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-copy-front{transform-box:fill-box;transform-origin:50% 100%;animation:vlsCopyHop var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-copy-star{transform-box:fill-box;transform-origin:center;animation:vlsCopyStar var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
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
    <Frame x={164} w={152} theme={theme} result />
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
    <g className="vls-room-result"><g className="vls-copy-front">
      <LcdBase x={190} y={32} />
      <LcdSlots x={190} y={32} />
    </g></g>
    <Star x={292} y={22} r={7} className="vls-copy-star" baseOpacity={0} />
  </>
);

/* ------------------------------------------------------------------ */
/* hint-shuffle-code: slots at rest → slots mid-roll + spark.          */
/* ------------------------------------------------------------------ */
const SceneShuffleCode: HintScene = ({ theme }) => (
  <>
    <RoomResultMotion />
    <style>{`
.vls-shuf-slots{opacity:.45}
.vls-shuf-roll{animation:vlsShufRoll var(--comic-duration,3.2s) linear var(--comic-repeat,1) both}
.vls-shuf-spark{transform-box:fill-box;transform-origin:center;animation:vlsShufSpark var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
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
    <Frame x={164} w={152} theme={theme} result />
    <LcdBase x={41} y={25} />
    <LcdSlots x={41} y={25} />
    <g className="vls-room-result">
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
    </g>
    <Spark x={288} y={30} className="vls-shuf-spark" />
  </>
);

/* ------------------------------------------------------------------ */
/* Copy writes a link to this device's clipboard; it sends no invitation. */
/* ------------------------------------------------------------------ */
const SceneCopyInvite: HintScene = ({ theme }) => (
  <>
    <RoomResultMotion />
    <style>{`
.vls-cinv-copy{animation:vlsCinvCopy var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsCinvCopy{0%,8%{transform:translate(-12px,-13px);opacity:.25}36%,100%{transform:none;opacity:1}}
${rmBlock(["vls-cinv-copy"], [[".vls-cinv-copy", "transform:none;opacity:1"]])}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <BrowserWindow x={24} y={21} w={104} h={54}>
      <rect x={34} y={39} width={84} height={24} rx={4} fill="var(--wall-2)" stroke={FAINT} strokeWidth={1.5} />
      <LinkRing x={44} y={42} w={24} h={11} tilt={-25} />
      <LinkRing x={58} y={50} w={24} h={11} tilt={-25} />
      <path d="M93 51h15" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
    </BrowserWindow>
    <rect x={205} y={21} width={76} height={60} rx={7} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <rect x={227} y={15} width={32} height={12} rx={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} />
    <g className="vls-room-result"><g className="vls-cinv-copy">
      <LinkRing x={219} y={43} w={24} h={11} tilt={-25} />
      <LinkRing x={233} y={51} w={24} h={11} tilt={-25} />
    </g></g>
  </>
);

// A link identifies its room; the App mode also exposes a public web entry.
// Neither diagram claims clipboard access, delivery to a friend or media relay.
function InviteLinkHint({ theme, publicEntry = false }: Parameters<HintScene>[0] & { publicEntry?: boolean }) {
  return <>
    <style>{`
.vls-link-address{animation:vlsLinkAddress var(--comic-duration,3.2s) ease-out 1 both}
@keyframes vlsLinkAddress{0%,8%{transform:translateY(-7px)}34%,100%{transform:none}}
${rmBlock(["vls-link-address"], [[".vls-link-address", "transform:none"]], false)}
`}</style>
    <Frame x={4} w={312} theme={theme} result />
    <BrowserWindow x={24} y={22} w={123} h={53}>
      <g className="vls-link-address">
        <LinkRing x={39} y={43} w={24} h={11} tilt={-25} />
        <LinkRing x={53} y={51} w={24} h={11} tilt={-25} />
        <path d="M89 50h44m-44 10h32" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
      </g>
    </BrowserWindow>
    <path d="M157 49h39" stroke={FAINT} strokeWidth={2} strokeDasharray="3 4" />
    {publicEntry ? <g stroke="var(--ink)" strokeWidth={2.5} fill="none">
      <circle cx={252} cy={49} r={27} />
      <ellipse cx={252} cy={49} rx={12} ry={27} />
      <path d="M225 49h54m-49-14h44m-44 28h44" />
    </g> : <><LcdBase x={210} y={26} /><LcdSlots x={210} y={26} /></>}
  </>;
}
const HintClientLink: HintScene = (props) => <InviteLinkHint {...props} publicEntry />;

/* ------------------------------------------------------------------ */
/* hint-rotate-invite: a link → the link spun fresh + spark.           */
/* ------------------------------------------------------------------ */
const SceneRotateInvite: HintScene = ({ theme }) => (
  <>
    <RoomResultMotion />
    <style>{`
.vls-rinv-ring{transform-box:view-box;transform-origin:240px 48px;animation:vlsRinvSpin var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rinv-spark{transform-box:fill-box;transform-origin:center;animation:vlsRinvSpark var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsRinvSpin{0%,10%{transform:rotate(0)}50%,100%{transform:rotate(360deg)}}
@keyframes vlsRinvSpark{0%,44%{opacity:0;transform:scale(.5)}54%{opacity:1;transform:scale(1.1)}62%,82%{opacity:1;transform:scale(1)}92%,100%{opacity:0}}
${rmBlock(
  ["vls-rinv-ring", "vls-rinv-spark"],
  [[".vls-rinv-spark", "opacity:1;transform:none"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <LinkRing x={65} y={40} w={30} h={16} tilt={-15} />
    <g className="vls-room-result"><LinkRing x={225} y={40} w={30} h={16} tilt={-15} /></g>
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
    <RoomResultMotion />
    <style>{`
.vls-rev-l{transform-box:view-box;transform-origin:223px 52.5px;animation:vlsRevL var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rev-r{transform-box:view-box;transform-origin:257px 52.5px;animation:vlsRevR var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-rev-x{transform-box:fill-box;transform-origin:center;animation:vlsRevX var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsRevL{0%,10%{transform:translate(9px,-4.5px) rotate(-18deg)}20%{transform:translate(-2px,1px) rotate(5deg)}30%,100%{transform:translate(0,0) rotate(0)}}
@keyframes vlsRevR{0%,10%{transform:translate(-9px,-4.5px) rotate(18deg)}20%{transform:translate(2px,1px) rotate(-5deg)}30%,100%{transform:translate(0,0) rotate(0)}}
@keyframes vlsRevX{0%,30%{opacity:0;transform:scale(1.6) rotate(8deg)}38%,100%{opacity:1;transform:scale(1) rotate(8deg)}}
${rmBlock(
  ["vls-rev-l", "vls-rev-r", "vls-rev-x"],
  [[".vls-rev-x", "opacity:1;transform:scale(1) rotate(8deg)"]],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <LinkRing x={56} y={41} w={28} h={14} />
    <LinkRing x={76} y={41} w={28} h={14} />
    <g className="vls-room-result"><g className="vls-rev-l">
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
.vls-open-p1{transform-box:fill-box;transform-origin:50% 100%;animation:vlsOpenHop var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-open-p2{transform-box:fill-box;transform-origin:50% 100%;animation:vlsOpenHop var(--comic-duration,3.2s) ease-in-out .2s var(--comic-repeat,1) both}
:where(svg[data-comic-motion="still"]) .vls-open-p1{animation-name:vlsOpenWelcome}
@keyframes vlsOpenHop{0%,6%{transform:translateY(0)}14%{transform:translateY(-5px)}22%{transform:translateY(0)}28%{transform:translateY(-3px)}34%,100%{transform:translateY(0)}}
@keyframes vlsOpenWelcome{0%,8%,38%,100%{transform:none}22%{transform:rotate(-7deg)}}
${rmBlock(["vls-open-p2"], [])}
${rmBlock(["vls-open-p1"], [[".vls-open-p1", "transform:none"]], false)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
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
.vls-priv-eyes{transform-box:fill-box;transform-origin:center;animation:vlsPrivBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-priv-card{transform-box:fill-box;transform-origin:center;animation:vlsPrivCard var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-priv-door{transform-box:fill-box;transform-origin:0% 50%;animation:vlsPrivDoor var(--comic-duration,3.2s) cubic-bezier(.3,.8,.35,1) var(--comic-repeat,1) both}
.vls-priv-lock{transform-box:fill-box;transform-origin:center;animation:vlsPrivLock var(--comic-duration,3.2s) cubic-bezier(.3,1.4,.45,1) var(--comic-repeat,1) both}
.vls-priv-click{transform-box:fill-box;transform-origin:center;animation:vlsPrivClick var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsPrivBlink{0%,52%,60%,100%{transform:scaleY(1)}56%{transform:scaleY(.12)}}
@keyframes vlsPrivCard{0%,8%{transform:translateY(2px) rotate(-3deg)}18%{transform:translateY(-3px) rotate(4deg)}28%,100%{transform:none}}
@keyframes vlsPrivDoor{0%,10%{transform:scaleX(.18);opacity:.45}28%,100%{transform:scaleX(1);opacity:1}}
@keyframes vlsPrivLock{0%,24%{transform:translateY(-6px);opacity:0}34%{transform:translateY(1px);opacity:1}40%,100%{transform:none;opacity:1}}
@keyframes vlsPrivClick{0%,32%{opacity:0;transform:scale(.45)}38%{opacity:1;transform:scale(1.12)}48%,100%{opacity:0;transform:scale(1)}}
${rmBlock(
  ["vls-priv-eyes", "vls-priv-door", "vls-priv-lock", "vls-priv-click"],
  [
    [".vls-priv-door,.vls-priv-lock", "transform:none;opacity:1"],
    [".vls-priv-click", "opacity:.65;transform:none"],
  ],
)}
${rmBlock(["vls-priv-card"], [[".vls-priv-card", "transform:none;opacity:1"]], false)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <OpenDoorway x={64} y={18} />
    <Pawn x={204} yb={76} s={8} eyes eyeClassName="vls-priv-eyes" />
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
/* Password entry/configuration uses the same field; no door opens until
   the separate admission owner has accepted a credential. */
const ScenePassword: HintScene = ({ theme }) => (
  <>
    <RoomResultMotion />
    <style>{`
.vls-pass-input{animation:vlsPassInput var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsPassInput{0%,8%{transform:translateX(-12px);opacity:.2}34%,100%{transform:none;opacity:1}}
${rmBlock(["vls-pass-input"], [[".vls-pass-input", "transform:none;opacity:1"]])}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    {[24, 184].map((x, index) => <BrowserWindow key={x} x={x} y={19} w={112} h={61}>
      <circle cx={x + 18} cy={38} r={4} fill="none" stroke="var(--ink)" strokeWidth={2} />
      <path d={`M${x + 22} 38h14m-4 0v4`} stroke="var(--ink)" strokeWidth={2} fill="none" />
      <rect x={x + 12} y={49} width={88} height={22} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
      {index ? <g className="vls-room-result"><g className="vls-pass-input" fill="var(--ink)">
        {[23, 36, 49, 62, 75, 88].map(offset => <circle key={offset} cx={x + offset} cy={60} r={2.5} />)}
      </g></g> : <path d={`M${x + 23} 55v10`} stroke="var(--ink)" strokeWidth={2} />}
    </BrowserWindow>)}
  </>
);

export const SET2_SCENES: Record<Set2Kind, HintScene> = {
  "hint-copy-code": SceneCopyCode,
  "hint-shuffle-code": SceneShuffleCode,
  "hint-copy-invite": SceneCopyInvite,
  "hint-invite-link": (props) => <InviteLinkHint {...props} />,
  "hint-client-link": HintClientLink,
  "hint-rotate-invite": SceneRotateInvite,
  "hint-revoke-invite": SceneRevokeInvite,
  "hint-policy-open": ScenePolicyOpen,
  "hint-policy-private": ScenePolicyPrivate,
  "hint-password": ScenePassword,
};
