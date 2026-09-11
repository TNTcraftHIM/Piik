import { FAINT, Frame, LIVE, MiniTv, Pawn, SKY, STAR_GOLD, rmBlock } from "../Comic";
import type { ComicTheme } from "../Comic";
import type { ControlHintKind, HintScene } from "../../../ui/visual-kinds";

// One folding idiom for every disclosure: keep the header, put its contents away.
const CollapseHint: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-fold-body{transform-box:fill-box;transform-origin:50% 0%;animation:vlsFoldBody var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsFoldBody{0%,12%{transform:scaleY(1);opacity:1}40%,100%{transform:scaleY(0);opacity:0}}
${rmBlock(["vls-fold-body"], [[".vls-fold-body", "transform:scaleY(0);opacity:0"]])}
`}</style>
    {[4, 164].map((x, index) => (
      <g key={x}>
        <Frame x={x} w={152} theme={theme} result={index === 1} />
        <g className={index ? "vls-fold-body" : undefined}>
          <rect x={x + 31} y={32} width={90} height={43} rx={5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
          <path d={`M${x + 43} 49 h66 M${x + 43} 61 h49`} stroke={FAINT} strokeWidth={3} strokeLinecap="round" />
        </g>
        <rect x={x + 31} y={19} width={90} height={17} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
        <path d={index ? `M${x + 68} 30 l8 -6 8 6` : `M${x + 68} 25 l8 6 8 -6`} fill="none" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    ))}
  </>
);

function PasswordHint({ theme, reveal }: { theme: ComicTheme; reveal: boolean }) {
  return <>
    <style>{`
.vls-password-new{animation:vlsPasswordNew var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsPasswordNew{0%,14%{opacity:0}35%,100%{opacity:1}}
${rmBlock(["vls-password-new"], [[".vls-password-new", "opacity:1"]])}
`}</style>
    {[4, 164].map((x, index) => {
      const visible = index ? reveal : !reveal;
      return <g key={x}>
        <Frame x={x} w={152} theme={theme} result={index === 1} />
        <rect x={x + 22} y={35} width={108} height={31} rx={7} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
        <g className={index ? "vls-password-new" : undefined} fill="var(--ink)">
          {visible ? <text x={x + 76} y={57} textAnchor="middle" fontSize={21} fontFamily="monospace">1234</text>
            : [49, 67, 85, 103].map((cx) => <circle key={cx} cx={x + cx} cy={51} r={3.5} />)}
        </g>
        <path d={`M${x + 63} 23 q13 -14 26 0 q-13 14 -26 0`} fill="none" stroke="var(--ink)" strokeWidth={2} />
        {visible ? <circle cx={x + 76} cy={23} r={3} fill={LIVE} />
          : <path d={`M${x + 66} 14 l20 18`} stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />}
      </g>;
    })}
  </>;
}

// Source audio goes to the other viewer. This is deliberately not local mute.
function ShareAudioHint({ theme, enabled, locked = false }: { theme: ComicTheme; enabled: boolean; locked?: boolean }) {
  return <>
    <style>{`
.vls-share-audio-change{animation:vlsShareAudioChange var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-share-audio-off{animation-name:vlsShareAudioOff}
@keyframes vlsShareAudioChange{0%,12%{opacity:0}36%,100%{opacity:1}}
@keyframes vlsShareAudioOff{0%,12%{opacity:1}36%,100%{opacity:0}}
${rmBlock(["vls-share-audio-change"], [[".vls-share-audio-change", "opacity:1"], [".vls-share-audio-off", "opacity:0"]])}
`}</style>
    {[4, 164].map((x, index) => {
      const audible = locked || index ? enabled : !enabled;
      return <g key={x}>
        <Frame x={x} w={152} theme={theme} result={index === 1} />
        <MiniTv x={x + 20} y={28} w={65} h={42} />
        <path d={`M${x + 37} 56 l12 -11 10 6 10 -8`} fill="none" stroke={SKY} strokeWidth={2.5} />
        <Pawn x={x + 29} yb={85} s={6} eyes host />
        <Pawn x={x + 121} yb={75} s={9} color={SKY} eyes />
        <path d={`M${x + 85} 62 h15`} fill="none" stroke={FAINT} strokeWidth={2} strokeDasharray="3 3" />
        <g opacity={audible ? 1 : 0} className={index && !locked ? `vls-share-audio-change${enabled ? "" : " vls-share-audio-off"}` : undefined}>
          <path d={`M${x + 97} 38 v-14 l13 -3 v14 M${x + 97} 27 l13 -3`} fill="none" stroke={STAR_GOLD} strokeWidth={3} strokeLinecap="round" />
          <ellipse cx={x + 94} cy={38} rx={4} ry={3} fill={STAR_GOLD} />
          <ellipse cx={x + 107} cy={35} rx={4} ry={3} fill={STAR_GOLD} />
        </g>
        {locked && index ? <g stroke="var(--ink)" strokeWidth={1.5}>
          <path d={`M${x + 87} 77 v-3 a3 3 0 0 1 6 0 v3`} fill="none" />
          <rect x={x + 85} y={77} width={10} height={8} rx={2} fill={STAR_GOLD} />
        </g> : null}
      </g>;
    })}
  </>;
}

export const CONTROL_SCENES: Record<ControlHintKind, HintScene> = {
  "hint-collapse": CollapseHint,
  "hint-password-show": (props) => <PasswordHint {...props} reveal />,
  "hint-password-hide": (props) => <PasswordHint {...props} reveal={false} />,
  "hint-share-audio": (props) => <ShareAudioHint {...props} enabled />,
  "hint-stop-audio": (props) => <ShareAudioHint {...props} enabled={false} />,
  "hint-share-audio-fixed": (props) => <ShareAudioHint {...props} enabled locked />,
  "hint-silent-share-fixed": (props) => <ShareAudioHint {...props} enabled={false} locked />,
};
