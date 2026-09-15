import { Door, Frame, INK_STAGE, InviteLink, MiniTv, Pawn, SKY, TV_SCREEN, YOU, rmBlock } from "../Comic";
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
    <rect x={x} y={18} width={44} height={64} rx={5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <path d={`M${x} 18l-14 7v64l14-7Z`} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} strokeLinejoin="round" />
    <circle cx={x - 10} cy={55} r={1.8} fill="var(--ink)" />
  </>;
}

// An open doorway: one friend outside, another inside, answering each other's hop.
const OpenAdmission: HintScene = ({ theme }) => <>
  <style>{`
.vls-ad-open-guest,.vls-ad-open-friend{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmissionHop var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ad-open-friend{animation-delay:.38s}
@keyframes vlsAdmissionHop{0%,6%,42%,100%{transform:none}12%{transform:scale(1.06,.92)}22%{transform:translateY(-9px) rotate(-5deg)}30%{transform:scale(1.03,.96)}36%{transform:translateY(-3px) rotate(2deg)}}
${rmBlock(["vls-ad-open-guest", "vls-ad-open-friend"], [[".vls-ad-open-guest,.vls-ad-open-friend", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={312} theme={theme} result />
  <CodePlate x={26} y={28} />
  <path d="M40 62h40m-5-4 5 4-5 4" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  <OpenDoorway x={188} />
  <MiniTv x={264} y={42} w={29} h={23} />
  <path d="m269 57 6-6 5 3 7-7" fill="none" stroke={SKY} strokeWidth={1.8} strokeLinecap="round" />
  <g className="vls-ad-open-guest">
    <Pawn x={141} yb={82} s={16} eyes gaze={2} />
    <circle cx={160} cy={58} r={3.4} fill={YOU} />
  </g>
  <g className="vls-ad-open-friend">
    <Pawn x={210} yb={80} s={13} eyes gaze={-2} color={SKY} />
    <circle cx={195} cy={49} r={3} fill={SKY} />
  </g>
</>;

// The room number and password go together; the second panel shows the way in.
const PasswordAdmission: HintScene = ({ theme }) => <>
  <style>{`
.vls-ad-pass-present{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmissionPresent var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ad-pass-enter{animation:vlsAdmissionEnter var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsAdmissionPresent{0%,8%,44%,100%{transform:none}20%{transform:rotate(7deg)}30%{transform:rotate(-3deg)}}
@keyframes vlsAdmissionEnter{0%,8%,90%,100%{transform:translate(-39px,0)}20%{transform:translate(-21px,-11px)}32%,60%{transform:none}74%{transform:translate(-20px,-8px)}}
${rmBlock(["vls-ad-pass-present", "vls-ad-pass-enter"], [[".vls-ad-pass-present,.vls-ad-pass-enter", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={152} theme={theme} />
  <Frame x={164} w={152} theme={theme} result />
  <CodePlate x={18} y={13} />
  <Door x={109} y={25} />
  <g className="vls-ad-pass-present">
    <Pawn x={43} yb={83} s={13} eyes gaze={2} />
    <circle cx={62} cy={64} r={3.2} fill={YOU} />
    <g className="vls-admission-password">
      <rect x={69} y={48} width={31} height={24} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
      {[76, 82, 88, 94].map(cx => <circle key={cx} cx={cx} cy={60} r={1.7} fill="var(--ink)" />)}
    </g>
  </g>
  <OpenDoorway x={249} />
  <g className="vls-ad-pass-enter">
    <Pawn x={271} yb={81} s={13} eyes gaze={1} />
  </g>
</>;

// A friend peeks around the private door as the visitor shows their invitation.
const InviteAdmission: HintScene = ({ theme }) => <>
  <style>{`
.vls-ad-invite-guest{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdmissionInvite var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-ad-invite-friend{animation:vlsAdmissionPeek var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsAdmissionInvite{0%,8%,46%,100%{transform:none}18%{transform:translateY(-5px) rotate(5deg)}28%{transform:rotate(-3deg)}36%{transform:translateY(-2px)}}
@keyframes vlsAdmissionPeek{0%,12%,72%,100%{transform:none}28%,56%{transform:translate(7px,-3px)}}
${rmBlock(["vls-ad-invite-guest", "vls-ad-invite-friend"], [[".vls-ad-invite-guest,.vls-ad-invite-friend", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={312} theme={theme} result />
  <path d="M30 81h262" stroke="var(--wall-2)" strokeWidth={2} strokeLinecap="round" />
  <g className="vls-ad-invite-guest">
    <Pawn x={135} yb={82} s={17} eyes gaze={2} />
    <circle cx={156} cy={59} r={3.5} fill={YOU} />
    <g className="vls-admission-invite" transform="rotate(-9 180 50)">
      <rect x={163} y={36} width={34} height={27} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
      <InviteLink x={169} y={39} size={22} />
    </g>
  </g>
  <rect x={225} y={18} width={51} height={64} rx={5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
  <g className="vls-ad-invite-friend">
    <Pawn x={256} yb={80} s={13} eyes gaze={-2} color={SKY} />
    <circle cx={253} cy={47} r={3} fill={SKY} />
  </g>
  <path d="M225 18l21 7v53l-21 4Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} strokeLinejoin="round" />
  <circle cx={239} cy={56} r={2} fill="var(--ink)" />
  <path d="M233 41v-4a3 3 0 0 1 6 0v4m-7 0h8v7h-8Z" fill="none" stroke="var(--ink)" strokeWidth={1.6} strokeLinejoin="round" />
</>;

export const ADMISSION_SCENES: Record<AdmissionHintKind, HintScene> = {
  "hint-admission-code": OpenAdmission,
  "hint-admission-password": PasswordAdmission,
  "hint-admission-invite": InviteAdmission,
};
