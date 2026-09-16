import { BrowserWindow, FAINT, Frame, LIVE, MiniTv, Pawn, SKY, STAR_GOLD, rmBlock } from "../Comic";
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

function PasswordHint({ theme, action }: { theme: ComicTheme; action: "show" | "hide" | "clear" }) {
  const clear = action === "clear";
  return <>
    <style>{`
.vls-password-new,.vls-password-clear{animation:vlsPasswordNew var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-password-clear{animation-name:vlsPasswordClear}
@keyframes vlsPasswordNew{0%,14%{opacity:0}35%,100%{opacity:1}}
@keyframes vlsPasswordClear{0%,14%{opacity:1}35%,100%{opacity:0}}
${rmBlock(["vls-password-new", "vls-password-clear"], [[".vls-password-new", "opacity:1"], [".vls-password-clear", "opacity:0"]])}
`}</style>
    {[4, 164].map((x, index) => {
      const visible = !clear && (index ? action === "show" : action === "hide");
      return <g key={x}>
        <Frame x={x} w={152} theme={theme} result={index === 1} />
        <rect x={x + 22} y={35} width={108} height={31} rx={7} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
        <g className={index ? clear ? "vls-password-clear" : "vls-password-new" : undefined}
          opacity={clear && index ? 0 : undefined} fill="var(--ink)">
          {visible ? <text x={x + 76} y={57} textAnchor="middle" fontSize={21} fontFamily="var(--mono)" fontWeight={700}>1234</text>
            : [49, 67, 85, 103].map((cx) => <circle key={cx} cx={x + cx} cy={51} r={3.5} />)}
        </g>
        {clear ? <path d={`M${x + 66} 24 l12 -12 10 10 -8 8 h-8 Z m7 -2 9 8 m-10 0 h18`}
          fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /> : <>
          <path d={`M${x + 63} 23 q13 -14 26 0 q-13 14 -26 0`} fill="none" stroke="var(--ink)" strokeWidth={2} />
          {visible ? <circle cx={x + 76} cy={23} r={3} fill={LIVE} />
            : <path d={`M${x + 66} 14 l20 18`} stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />}
        </>}
      </g>;
    })}
  </>;
}

// A captured audio track is a source fact, not a locked setting or delivery proof.
const SourceAudioHint: HintScene = ({ theme }) => <>
  <style>{`
.vls-source-audio-note{animation:vlsSourceAudioNote var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsSourceAudioNote{0%,8%{transform:translateY(5px)}32%,100%{transform:none}}
${rmBlock(["vls-source-audio-note"], [[".vls-source-audio-note", "transform:none"]], false)}
`}</style>
  <Frame x={4} w={312} theme={theme} result />
  <Pawn x={66} yb={81} s={13} eyes host gaze={2} />
  <MiniTv x={112} y={24} w={98} h={55} />
  <path d="M125 61l18-19 15 11 18-17 18 20" fill="none" stroke={SKY} strokeWidth={3} />
  <g className="vls-source-audio-note">
    <path d="M238 57V30l23-5v26M238 35l23-5" fill="none" stroke="var(--ink)" strokeWidth={3} strokeLinecap="round" />
    <ellipse cx={233} cy={58} rx={6} ry={4} fill="var(--ink)" />
    <ellipse cx={256} cy={52} rx={6} ry={4} fill="var(--ink)" />
  </g>
</>;

// Source audio goes to the other viewer. This is deliberately not local mute.
function ShareAudioHint({ theme, enabled, locked = false }: { theme: ComicTheme; enabled: boolean; locked?: boolean }) {
  return <>
    <style>{`
.vls-share-audio-change{animation:vlsShareAudioChange var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-share-audio-off{animation-name:vlsShareAudioOff}
.vls-share-audio-lock{transform-box:fill-box;transform-origin:center;animation:vlsShareAudioLock var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsShareAudioChange{0%,12%{opacity:0}36%,100%{opacity:1}}
@keyframes vlsShareAudioOff{0%,12%{opacity:1}36%,100%{opacity:0}}
@keyframes vlsShareAudioLock{0%,8%,34%,100%{transform:none}16%{transform:translateX(-3px) rotate(-12deg)}25%{transform:translateX(2px) rotate(8deg)}}
${rmBlock(["vls-share-audio-change"], [[".vls-share-audio-change", "opacity:1"], [".vls-share-audio-off", "opacity:0"]])}
${rmBlock(["vls-share-audio-lock"], [[".vls-share-audio-lock", "transform:none"]], false)}
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
        {locked && index ? <g className="vls-share-audio-lock" stroke="var(--ink)" strokeWidth={1.5}>
          <path d={`M${x + 87} 77 v-3 a3 3 0 0 1 6 0 v3`} fill="none" />
          <rect x={x + 85} y={77} width={10} height={8} rx={2} fill={STAR_GOLD} />
        </g> : null}
      </g>;
    })}
  </>;
}

// This shows the requested border change, not proof of Windows permission.
function CaptureBorderHint({ theme, show }: { theme: ComicTheme; show: boolean }) {
  return <>
  <style>{`
.vls-capture-border-show,.vls-capture-border-hide{animation:vlsCaptureBorderShow var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-capture-border-hide{animation-name:vlsCaptureBorderHide}
@keyframes vlsCaptureBorderShow{0%,10%{opacity:0}36%,100%{opacity:1}}
@keyframes vlsCaptureBorderHide{0%,10%{opacity:1}36%,100%{opacity:0}}
${rmBlock(["vls-capture-border-show", "vls-capture-border-hide"], [[".vls-capture-border-show", "opacity:1"], [".vls-capture-border-hide", "opacity:0"]])}
`}</style>
  {[4, 164].map((x, index) => <g key={x}>
    <Frame x={x} w={152} theme={theme} result={index === 1} />
    <rect x={x + 30} y={25} width={92} height={56} rx={7} fill="none" stroke={STAR_GOLD} strokeWidth={3}
      opacity={index ? (show ? 1 : 0) : (show ? 0 : 1)}
      className={index ? (show ? "vls-capture-border-show" : "vls-capture-border-hide") : undefined} />
    <rect x={x + 35} y={30} width={82} height={46} rx={3} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    <path d={`M${x + 35} 40h82 m-9 -7 4 4 m0-4-4 4`} fill="none" stroke="var(--ink)" strokeWidth={1.5} />
    <path d={`M${x + 47} 67l17-19 15 12 11-9 14 16`} fill="none" stroke={SKY} strokeWidth={2.5} />
  </g>)}
  </>;
}

const RefreshSourcesHint: HintScene = ({ theme }) => <>
  <style>{`
.vls-refresh-path{stroke-dasharray:1;animation:vlsRefreshPath var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-refresh-source{animation:vlsRefreshSource var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsRefreshPath{0%,8%{stroke-dashoffset:1}24%,100%{stroke-dashoffset:0}}
@keyframes vlsRefreshSource{0%,24%{opacity:0;transform:translateY(5px)}42%,100%{opacity:1;transform:none}}
${rmBlock(["vls-refresh-path", "vls-refresh-source"], [[".vls-refresh-path", "stroke-dashoffset:0"], [".vls-refresh-source", "opacity:1;transform:none"]])}
`}</style>
  {[4, 164].map((x, index) => <g key={x}>
    <Frame x={x} w={152} theme={theme} result={index === 1} />
    <path d={`M${x + 123} 26 a8 8 0 1 1 9 -10 l-5 1 m5 -1 v-5`} pathLength={1}
      className={index ? "vls-refresh-path" : undefined}
      fill="none" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    {[22, 82].map((offset, tile) => <g key={offset} className={index && tile ? "vls-refresh-source" : undefined}>
      <rect x={x + offset} y={37} width={48} height={35} rx={5}
        fill="var(--paper)" stroke={index || !tile ? "var(--ink)" : FAINT} strokeWidth={2}
        strokeDasharray={!index && tile ? "3 3" : undefined} />
      {index || !tile ? <>
        <path d={`M${x + offset} 47 h48`} stroke="var(--ink)" strokeWidth={2} />
        <path d={`M${x + offset + 9} 63 l10 -9 9 6 10 -6`} fill="none" stroke={tile ? SKY : LIVE} strokeWidth={2.5} />
      </> : null}
    </g>)}
  </g>)}
</>;

function SourceListHint({ theme, empty = false }: { theme: ComicTheme; empty?: boolean }) {
  return <>
    <style>{`
.vls-source-cursor{animation:vlsSourceCursor var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-source-look{transform-box:fill-box;transform-origin:50% 100%;animation:vlsSourceLook var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsSourceCursor{0%,8%{transform:translate(35px,9px)}30%,100%{transform:none}}
@keyframes vlsSourceLook{0%,8%,42%,100%{transform:none}22%{transform:rotate(7deg)}}
${rmBlock(["vls-source-cursor", "vls-source-look"], [[".vls-source-cursor,.vls-source-look", "transform:none"]], false)}
`}</style>
    <Frame x={4} w={312} theme={theme} result />
    <Pawn x={53} yb={79} s={15} eyes gaze={2} className={empty ? "vls-source-look" : undefined} />
    <BrowserWindow x={94} y={14} w={172} h={67}>
      {empty ? <>
        <rect x={124} y={36} width={112} height={30} rx={4} fill="none" stroke={FAINT} strokeWidth={2} strokeDasharray="4 4" />
        <path d="M172 51h16" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />
      </> : <>
        {[111, 158, 205].map((x) => <g key={x}>
          <rect x={x} y={35} width={37} height={29} rx={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
          <path d={`M${x + 6} 56l7-9 7 6 9-11`} fill="none" stroke={SKY} strokeWidth={2} />
        </g>)}
        <path className="vls-source-cursor" d="M179 52v18l5-5 5 8 4-2-5-8 8-1Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.8} />
      </>}
    </BrowserWindow>
  </>;
}

export const CONTROL_SCENES: Record<ControlHintKind, HintScene> = {
  "hint-collapse": CollapseHint,
  "hint-refresh-sources": RefreshSourcesHint,
  "hint-source-picker": (props) => <SourceListHint {...props} />,
  "hint-no-sources": (props) => <SourceListHint {...props} empty />,
  "hint-show-capture-border": (props) => <CaptureBorderHint {...props} show />,
  "hint-hide-capture-border": (props) => <CaptureBorderHint {...props} show={false} />,
  "hint-password-show": (props) => <PasswordHint {...props} action="show" />,
  "hint-password-hide": (props) => <PasswordHint {...props} action="hide" />,
  "hint-password-remove": (props) => <PasswordHint {...props} action="clear" />,
  "hint-source-audio": SourceAudioHint,
  "hint-share-audio": (props) => <ShareAudioHint {...props} enabled />,
  "hint-stop-audio": (props) => <ShareAudioHint {...props} enabled={false} />,
  "hint-share-audio-fixed": (props) => <ShareAudioHint {...props} enabled locked />,
  "hint-silent-share-fixed": (props) => <ShareAudioHint {...props} enabled={false} locked />,
};
