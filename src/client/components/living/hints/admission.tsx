import { Frame, INK_STAGE, MiniTv, Pawn, SKY, TV_SCREEN, YOU, rmBlock } from "../Comic";
import type { AdmissionHintKind, ComicTheme, HintScene } from "../../../ui/visual-kinds";

// The credential admits this person; the room stays open throughout.
// At the final pose the same person has reached the room's open doorway.
function AdmissionHint({ theme, credential }: { theme: ComicTheme; credential: "code" | "password" | "invite" }) {
  const password = credential === "password";
  return <>
    <style>{`
.vls-admission-person{animation:vlsAdmissionApproach var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsAdmissionApproach{0%,8%{transform:translateX(-32px)}36%,100%{transform:none}}
${rmBlock(["vls-admission-person"], [[".vls-admission-person", "transform:none"]], false)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <rect x={228} y={16} width={72} height={65} rx={6} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <path d="M228 16l-12 7v65l12-7Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} strokeLinejoin="round" />
    <MiniTv x={266} y={41} w={25} h={20} />
    <path d="m270 55 6-6 5 4 6-7" fill="none" stroke={SKY} strokeWidth={1.5} />
    <g className="vls-admission-person">
      <Pawn x={245} yb={82} s={16} eyes gaze={2} />
    </g>
    <Pawn x={125} yb={82} s={16} eyes gaze={2} />
    <circle cx={105} cy={62} r={4} fill={YOU} />
    <g transform="translate(22 0)">
      <rect y={password ? 19 : 26} width={78} height={password ? 60 : 46} rx={8}
        fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} />
      {credential === "invite" ? <g className="vls-admission-invite" fill="none" stroke="var(--ink)" strokeWidth={3}>
        <rect x={15} y={42} width={28} height={14} rx={7} transform="rotate(-25 29 49)" />
        <rect x={35} y={42} width={28} height={14} rx={7} transform="rotate(-25 49 49)" />
        <path d="m32 52 14-6" strokeLinecap="round" />
      </g> : <>
        <g className="vls-admission-code">
          <rect x={6} y={password ? 25 : 32} width={66} height={password ? 24 : 34} rx={5} fill={TV_SCREEN} />
          {[12, 27, 42, 57].map(x => <rect key={x} x={x} y={password ? 32 : 43} width={9} height={10} rx={2}
            fill="none" stroke={INK_STAGE} strokeWidth={2} />)}
        </g>
        {password ? <g className="vls-admission-password" fill="var(--ink)">
          {[17, 32, 47, 62].map(cx => <circle key={cx} cx={cx} cy={64} r={3} />)}
        </g> : null}
      </>}
    </g>
  </>;
}

export const ADMISSION_SCENES: Record<AdmissionHintKind, HintScene> = {
  "hint-admission-code": ({ theme }) => <AdmissionHint theme={theme} credential="code" />,
  "hint-admission-password": ({ theme }) => <AdmissionHint theme={theme} credential="password" />,
  "hint-admission-invite": ({ theme }) => <AdmissionHint theme={theme} credential="invite" />,
};
