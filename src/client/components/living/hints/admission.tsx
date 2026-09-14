import { BrowserWindow, Frame, INK_STAGE, InviteLink, MiniTv, Pawn, SKY, TV_SCREEN, YOU, rmBlock } from "../Comic";
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
    <Pawn x={132} yb={82} s={16} eyes gaze={-2} />
    <circle cx={113} cy={65} r={3.5} fill={YOU} />
    <BrowserWindow x={20} y={18} w={87} h={62}>
      {credential === "invite" ? <g className="vls-admission-invite">
        <rect x={28} y={38} width={71} height={27} rx={5} fill="var(--wall-2)" />
        <InviteLink x={31} y={39} size={25} />
        <path d="M62 51h28" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
      </g> : <>
        <g className="vls-admission-code">
          <rect x={28} y={password ? 32 : 38} width={71} height={password ? 21 : 28} rx={5} fill={TV_SCREEN} />
          {[36, 51, 66, 81].map(x => <rect key={x} x={x} y={password ? 37 : 46} width={9} height={10} rx={2}
            fill="none" stroke={INK_STAGE} strokeWidth={2} />)}
        </g>
        {password ? <g className="vls-admission-password">
          <rect x={28} y={58} width={71} height={15} rx={4} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={1.5} />
          {[41, 56, 71, 86].map(cx => <circle key={cx} cx={cx} cy={65.5} r={2.5} fill="var(--ink)" />)}
        </g> : null}
      </>}
    </BrowserWindow>
  </>;
}

export const ADMISSION_SCENES: Record<AdmissionHintKind, HintScene> = {
  "hint-admission-code": ({ theme }) => <AdmissionHint theme={theme} credential="code" />,
  "hint-admission-password": ({ theme }) => <AdmissionHint theme={theme} credential="password" />,
  "hint-admission-invite": ({ theme }) => <AdmissionHint theme={theme} credential="invite" />,
};
