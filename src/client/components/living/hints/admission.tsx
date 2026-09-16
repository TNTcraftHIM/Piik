import { Door, Frame, INK_STAGE, InviteLink, Pawn, SKY, TV_SCREEN, rmBlock } from "../Comic";
import type { AdmissionHintKind, HintScene } from "../../../ui/visual-kinds";

function CodePlate({ x, y }: { x: number; y: number }) {
  return <g className="vls-admission-code">
    <rect x={x} y={y} width={70} height={24} rx={6} fill={TV_SCREEN} />
    {[10, 25, 40, 55].map(dx => <rect key={dx} x={x + dx} y={y + 6} width={7} height={12} rx={2}
      fill="none" stroke={INK_STAGE} strokeWidth={2} />)}
  </g>;
}

function OpenDoorway({ x }: { x: number }) {
  return <>
    <rect x={x} y={18} width={32} height={56} rx={5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <path d={`M${x} 18l-12 6v56l12-6Z`} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} strokeLinejoin="round" />
    <circle cx={x - 8} cy={50} r={1.8} fill="var(--ink)" />
  </>;
}

// Private restricts code-only entry, regardless of which credentials are enabled.
const PrivatePolicy: HintScene = ({ theme }) => <>
  <style>{`
.vls-policy-private-guest{transform-box:fill-box;transform-origin:50% 100%;animation:vlsPrivateDoor var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsPrivateDoor{0%,8%,48%,100%{transform:none}18%{transform:translate(3px,-3px)}28%{transform:translateX(3px)}38%{transform:rotate(-5deg)}}
${rmBlock(["vls-policy-private-guest"], [[".vls-policy-private-guest", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={152} theme={theme} />
  <Frame x={164} w={152} theme={theme} result />
  <CodePlate x={20} y={29} />
  <path d="M54 64h30m-4-4 4 4-4 4" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  <Door x={104} y={20} />
  <Door x={224} y={20} />
  <g className="vls-policy-private-lock" fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round">
    <path d="M235 46v-5a5 5 0 0 1 10 0v5" fill="none" />
    <rect x={231} y={46} width={18} height={14} rx={3} />
  </g>
  <Pawn x={201} yb={78} s={6.5} eyes gaze={1} className="vls-policy-private-guest" />
</>;

// Credential hints explain a way into the room; policy controls explain limits.
const OpenAdmission: HintScene = ({ theme }) => <>
  <style>{`
.vls-ad-open-guest,.vls-ad-open-friend{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmissionHop var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ad-open-friend{animation-delay:.2s}
@keyframes vlsAdmissionHop{0%,6%{transform:none}14%{transform:translateY(-5px)}22%{transform:none}28%{transform:translateY(-3px)}34%,100%{transform:none}}
${rmBlock(["vls-ad-open-guest", "vls-ad-open-friend"], [[".vls-ad-open-guest,.vls-ad-open-friend", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={152} theme={theme} />
  <Frame x={164} w={152} theme={theme} result />
  <CodePlate x={20} y={29} />
  <path d="M54 64h30m-4-4 4 4-4 4" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  <Door x={104} y={20} />
  <OpenDoorway x={224} />
  <Pawn x={204} yb={78} s={6.5} eyes gaze={1} className="vls-ad-open-guest" />
  <Pawn x={238} yb={74} s={6.5} eyes gaze={-1} color={SKY} className="vls-ad-open-friend" />
</>;

// The room number and password go together; the second panel shows the way in.
const PasswordAdmission: HintScene = ({ theme }) => <>
  <style>{`
.vls-ad-pass-friend{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmissionLean var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ad-pass-enter{animation:vlsAdmissionEnter var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsAdmissionLean{0%,30%,56%,100%{transform:none}40%{transform:rotate(-7deg)}48%{transform:rotate(3deg)}}
@keyframes vlsAdmissionEnter{0%,8%{transform:translate(-34px,4px)}20%{transform:translate(-17px,-5px)}32%,100%{transform:none}}
${rmBlock(["vls-ad-pass-friend", "vls-ad-pass-enter"], [[".vls-ad-pass-friend,.vls-ad-pass-enter", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={152} theme={theme} />
  <Frame x={164} w={152} theme={theme} result />
  <CodePlate x={20} y={21} />
  <Door x={104} y={20} />
  <g className="vls-admission-password">
    <rect x={20} y={53} width={70} height={20} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    {[32, 47, 62, 77].map(cx => <circle key={cx} cx={cx} cy={63} r={2} fill="var(--ink)" />)}
  </g>
  <OpenDoorway x={224} />
  <Pawn x={238} yb={74} s={6.5} eyes gaze={1} className="vls-ad-pass-enter" />
  <Pawn x={281} yb={78} s={6.5} eyes gaze={-1} color={SKY} className="vls-ad-pass-friend" />
</>;

// The invitation remains a link; a private room still welcomes invited friends.
const InviteAdmission: HintScene = ({ theme }) => <>
  <style>{`
.vls-ad-invite-guest{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmissionInvite var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ad-invite-friend{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmissionPeek var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsAdmissionInvite{0%,8%,46%,100%{transform:none}18%{transform:translateY(-5px) rotate(5deg)}28%{transform:rotate(-3deg)}36%{transform:translateY(-2px)}}
@keyframes vlsAdmissionPeek{0%,12%,54%,100%{transform:none}28%{transform:translate(-3px,-2px) rotate(-8deg)}}
${rmBlock(["vls-ad-invite-guest", "vls-ad-invite-friend"], [[".vls-ad-invite-guest,.vls-ad-invite-friend", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={152} theme={theme} />
  <Frame x={164} w={152} theme={theme} result />
  <g className="vls-admission-invite">
    <rect x={20} y={29} width={70} height={36} rx={6} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    <InviteLink x={27} y={33} size={28} />
    <path d="M62 43h18m-18 8h12" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
  </g>
  <Door x={104} y={20} />
  <OpenDoorway x={224} />
  <g className="vls-ad-invite-guest">
    <Pawn x={200} yb={78} s={6.5} eyes gaze={1} />
    <InviteLink x={192} y={36} size={16} />
  </g>
  <Pawn x={238} yb={74} s={6.5} eyes gaze={-1} color={SKY} className="vls-ad-invite-friend" />
</>;

export const ADMISSION_SCENES: Record<AdmissionHintKind, HintScene> = {
  "hint-policy-private": PrivatePolicy,
  "hint-admission-code": OpenAdmission,
  "hint-admission-password": PasswordAdmission,
  "hint-admission-invite": InviteAdmission,
};
