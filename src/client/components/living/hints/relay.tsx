import { FAINT, Frame, MiniTv, Pawn, SKY, YOU, rmBlock } from "../Comic";
import type { HintScene, RelayHintKind } from "../../../ui/visual-kinds";

// The same ordinary Viewer watches and passes the picture on in both panels.
// A voluntary switch adds outgoing branches, without another participant role.
const HintRelayVolunteer: HintScene = ({ theme }) => <>
  <style>{`
.vls-relay-more-a{animation:vlsRelayMoreA var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-relay-more-b{animation:vlsRelayMoreB var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsRelayMoreA{0%,10%,100%{opacity:0}24%,99.9%{opacity:1}}
@keyframes vlsRelayMoreB{0%,24%,100%{opacity:0}38%,99.9%{opacity:1}}
${rmBlock(["vls-relay-more-a", "vls-relay-more-b"], [[".vls-relay-more-a,.vls-relay-more-b", "opacity:1"]])}
  `}</style>
  {[0, 160].map((offset, index) => <g key={offset}>
    <Frame x={offset + 4} w={152} theme={theme} result={Boolean(index)} />
    <MiniTv x={offset + 18} y={22} w={34} h={23} />
    <Pawn x={offset + 49} yb={82} s={14} eyes gaze={-2} />
    <rect x={offset + 62} y={12} width={22} height={11} rx={5.5}
      fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={1.5} />
    <circle cx={offset + (index ? 78 : 68)} cy={17.5} r={3.5} fill={index ? YOU : FAINT} />
    {(index ? [20, 40, 60, 80] : [32, 72]).map((y, child) => {
      const extra = index && (child === 1 || child === 2);
      return <g key={y} className={extra ? child === 1 ? "vls-relay-more-a" : "vls-relay-more-b" : undefined}>
        <path d={`M${offset + 64} 53 C${offset + 81} 53 ${offset + 86} ${y} ${offset + 106} ${y}`}
          fill="none" stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
        <path d={`m${offset + 101} ${y - 3} 5 3-5 3`} fill="none" stroke={FAINT} strokeWidth={1.5} strokeLinejoin="round" />
        <MiniTv x={offset + 109} y={y - 6} w={15} h={11} />
        <Pawn x={offset + 139} yb={y + (index ? 9 : 10)} s={index ? 6 : 7} color={SKY} eyes gaze={-1} />
      </g>;
    })}
  </g>)}
</>;

export const RELAY_SCENES: Record<RelayHintKind, HintScene> = {
  "hint-relay-volunteer": HintRelayVolunteer,
};
