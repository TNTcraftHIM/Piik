import { FAINT, Frame, MiniTv, Pawn, SKY, rmBlock } from "../Comic";
import type { HintScene, RelayHintKind } from "../../../ui/visual-kinds";

// An adjustable limit belongs to the sender; branches describe its scope,
// without promising an increase or showing an actual session's value.
const HintRelayVolunteer: HintScene = ({ theme }) => <>
  <style>{`
.vls-relay-limit{animation:vlsRelayLimit var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsRelayLimit{0%,12%,100%{transform:translateX(0)}28%,42%{transform:translateX(-20px)}58%,72%{transform:translateX(20px)}88%{transform:translateX(0)}}
${rmBlock(["vls-relay-limit"], [[".vls-relay-limit", "transform:translateX(0)"]])}
  `}</style>
  <Frame x={4} w={312} theme={theme} />
  <MiniTv x={35} y={23} w={42} h={28} />
  <Pawn x={61} yb={86} s={17} eyes gaze={2} />
  <rect x={103} y={11} width={99} height={20} rx={8} fill="var(--wall-2)" stroke={FAINT} strokeWidth={1.5} />
  <path d="M115 21h75" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
  <circle className="vls-relay-limit" cx={152} cy={21} r={5} fill="var(--ink)" />
  {[38, 59, 80].map(y => <g key={y}>
    <path d={`M88 62 C135 62 166 ${y} 230 ${y}`} fill="none" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
    <path d={`m225 ${y - 3} 5 3-5 3`} fill="none" stroke={FAINT} strokeWidth={1.5} strokeLinejoin="round" />
    <MiniTv x={239} y={y - 9} w={25} h={17} />
    <Pawn x={282} yb={y + 6} s={8} color={SKY} eyes gaze={-1} />
  </g>)}
</>;

export const RELAY_SCENES: Record<RelayHintKind, HintScene> = {
  "hint-relay-volunteer": HintRelayVolunteer,
};
