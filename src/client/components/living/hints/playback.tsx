import {
  BrowserWindow, FAINT, Frame, INK_STAGE, LIVE, MiniTv, Pawn, SKY, TV_BODY, TV_EDGE, YOU, rmBlock,
} from "../Comic";
import type { HintScene, PlaybackHintKind } from "../../../ui/visual-kinds";

// One action, a small response, then rest. Reduced motion keeps the result.
function PlaybackMotion() {
  return <style>{`
.vls-pb-cue{transform-box:fill-box;transform-origin:center;animation:vlsPbCue var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-pb-play{animation:vlsPbPlay var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-freeze{animation:vlsPbFreeze var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-waves .vls-pb-wave{stroke-dasharray:1;animation:vlsPbWave var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-waves .vls-pb-wave:nth-child(2){animation-delay:.08s}
.vls-pb-waves .vls-pb-wave:nth-child(3){animation-delay:.16s}
.vls-pb-waves.is-muting .vls-pb-wave{animation-name:vlsPbSilence}
.vls-pb-cross{transform-box:fill-box;transform-origin:center;animation:vlsPbCross var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-listen{transform-box:fill-box;transform-origin:50% 100%;animation:vlsPbListen var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-pb-flat{stroke-dasharray:1;animation:vlsPbWave var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-windowed,.vls-pb-expand,.vls-pb-contract{transform-box:fill-box;transform-origin:center}
.vls-pb-windowed,.vls-pb-contract{transform:translate(12px,9px) scale(.62)}
.vls-pb-expand{animation:vlsPbExpand var(--comic-duration,3.2s) cubic-bezier(.3,1.2,.5,1) var(--comic-repeat,1) both}
.vls-pb-contract{animation:vlsPbContract var(--comic-duration,3.2s) cubic-bezier(.3,1.2,.5,1) var(--comic-repeat,1) both}
.vls-pb-chrome-out{opacity:0;animation:vlsPbChromeOut var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-chrome-in{animation:vlsPbChromeIn var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-popout,.vls-pb-popin{transform-box:fill-box;transform-origin:center}
.vls-pb-popout{animation:vlsPbPopout var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-popin{animation:vlsPbPopin var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-pb-unavailable{animation:vlsPbUnavailable var(--comic-duration,3.2s) ease-in-out 1 both}
@keyframes vlsPbCue{0%,8%,34%,100%{transform:scale(1)}16%{transform:scale(.86)}25%{transform:scale(1.08)}}
@keyframes vlsPbPlay{0%,18%{transform:translateX(-12px)}40%,100%{transform:none}}
@keyframes vlsPbFreeze{0%{transform:translateX(-12px)}18%,100%{transform:none}}
@keyframes vlsPbWave{0%,12%{stroke-dashoffset:1;opacity:.2}30%,100%{stroke-dashoffset:0;opacity:1}}
@keyframes vlsPbSilence{0%,8%{stroke-dashoffset:0;opacity:1}26%,100%{stroke-dashoffset:1;opacity:0}}
@keyframes vlsPbCross{0%,14%{opacity:0;transform:scale(.7)}30%,100%{opacity:1;transform:none}}
@keyframes vlsPbListen{0%,26%,44%,100%{transform:rotate(0)}35%{transform:rotate(-5deg)}}
@keyframes vlsPbExpand{0%,8%{transform:translate(12px,9px) scale(.62)}34%,100%{transform:none}}
@keyframes vlsPbContract{0%,8%{transform:none}34%,100%{transform:translate(12px,9px) scale(.62)}}
@keyframes vlsPbChromeOut{0%,8%{opacity:1}27%,100%{opacity:0}}
@keyframes vlsPbChromeIn{0%,8%{opacity:0}30%,100%{opacity:1}}
@keyframes vlsPbPopout{0%,8%{transform:translate(-28px,-14px) scale(1.4)}34%,100%{transform:none}}
@keyframes vlsPbPopin{0%,8%{transform:translate(32px,16px) scale(.65)}34%,100%{transform:none}}
@keyframes vlsPbUnavailable{0%,8%,36%,100%{transform:none}16%{transform:translateX(-4px)}26%{transform:translateX(3px)}}
${rmBlock(
  ["vls-pb-cue", "vls-pb-play", "vls-pb-freeze", "vls-pb-waves .vls-pb-wave",
    "vls-pb-waves.is-muting .vls-pb-wave", "vls-pb-cross",
    "vls-pb-expand", "vls-pb-contract", "vls-pb-chrome-out", "vls-pb-chrome-in", "vls-pb-popout", "vls-pb-popin"],
  [[".vls-pb-wave", "stroke-dashoffset:0;opacity:1"],
    [".vls-pb-waves.is-muting .vls-pb-wave,.vls-pb-chrome-out", "opacity:0"],
    [".vls-pb-cross,.vls-pb-chrome-in", "opacity:1"]],
)}
${rmBlock(["vls-pb-listen", "vls-pb-flat", "vls-pb-unavailable"], [
  [".vls-pb-listen,.vls-pb-unavailable", "transform:none"],
  [".vls-pb-flat", "stroke-dashoffset:0;opacity:1"],
], false)}
`}</style>;
}

// A green viewer, their local control, and the same picture before and after.
function PlaybackHint({ theme, paused }: Parameters<HintScene>[0] & { paused: boolean }) {
  return <>
    <PlaybackMotion />
    {[!paused, paused].map((isPaused, index) => {
      const x = index * 160;
      return <g key={index}>
        <Frame x={x + 4} w={152} theme={theme} result={index === 1} />
        <MiniTv x={x + 52} y={21} w={88} h={55} />
        <path d={`M${x + 60} 61l15-20 13 15 12-11 29 16Z`} fill={SKY} opacity={.65} />
        <g className={index ? (paused ? "vls-pb-freeze" : "vls-pb-play") : undefined}>
          <circle cx={x + 115} cy={36} r={5} fill={INK_STAGE} />
          {!isPaused ? <path d={`M${x + 100} 36h5m-8 5h5`} stroke={INK_STAGE} strokeWidth={1.5} strokeLinecap="round" /> : null}
        </g>
        <Pawn x={x + 28} yb={81} s={11} color={YOU} eyes />
        <g className={index ? "vls-pb-cue" : undefined}>
          <rect x={x + 15} y={21} width={27} height={25} rx={7}
            fill="var(--paper)" stroke={YOU} strokeWidth={2} />
          <path d={`M${x + 27} 46v5`} stroke={YOU} strokeWidth={2} strokeLinecap="round" />
          {isPaused ? <path d={`M${x + 24} 28v11m8-11v11`} stroke={YOU} strokeWidth={3.5} strokeLinecap="round" />
            : <path d={`M${x + 24} 27l12 7-12 7Z`} fill={YOU} />}
        </g>
      </g>;
    })}
  </>;
}

function LocalSpeaker({ x, silent, waves = 1, animate = false }: {
  x: number; silent?: "muted" | "absent"; waves?: 1 | 3; animate?: boolean;
}) {
  return <>
    <rect x={x + 26} y={44} width={14} height={22} rx={4} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} />
    <path d={`M${x + 40} 48l20-14v42l-20-14Z`} fill={TV_BODY} stroke={TV_EDGE} strokeWidth={2} strokeLinejoin="round" />
    {silent !== "absent" ? <g className={animate ? `vls-pb-waves${silent ? " is-muting" : ""}` : undefined}
      stroke={LIVE} strokeWidth={2.5} strokeLinecap="round" fill="none" opacity={silent && !animate ? 0 : 1}>
      <path className="vls-pb-wave" pathLength={1} d={`M${x + 67} 49q6 6 0 12`} />
      {waves === 3 ? <>
        <path className="vls-pb-wave" pathLength={1} d={`M${x + 74} 43q12 12 0 24`} />
        <path className="vls-pb-wave" pathLength={1} d={`M${x + 81} 37q18 18 0 36`} />
      </> : null}
    </g> : null}
    {silent === "muted" ? <path className={animate ? "vls-pb-cross" : undefined}
      d={`M${x + 75} 48l13 14m0-14-13 14`} stroke={FAINT} strokeWidth={3} strokeLinecap="round" /> : null}
  </>;
}

function AudioHint({ theme, action, maxPercent = 200 }: Parameters<HintScene>[0] & {
  action: "volume" | "mute" | "unmute"; maxPercent?: 100 | 200;
}) {
  const volume = action === "volume";
  return <>
    <PlaybackMotion />
    {[0, 1].map((index) => {
      const x = index * 160;
      const silent = !volume && (action === "mute" ? index === 1 : index === 0);
      return <g key={index}>
        <Frame x={x + 4} w={152} theme={theme} result={index === 1} />
        <LocalSpeaker x={x} waves={index || !volume ? 3 : 1} silent={silent ? "muted" : undefined} animate={index === 1} />
        <Pawn x={x + 123} yb={79} s={11} color={YOU} eyes className={index && !silent ? "vls-pb-listen" : undefined} />
        {volume ? <text x={x + 60} y={86} textAnchor="middle" fill="var(--ink)"
          fontFamily="inherit" fontSize={13} fontWeight={700}>{index ? maxPercent : maxPercent / 2}%</text> : null}
      </g>;
    })}
  </>;
}

const NoAudioHint: HintScene = ({ theme }) => <>
  <PlaybackMotion />
  <Frame x={4} w={152} theme={theme} />
  <Frame x={164} w={152} theme={theme} result />
  <MiniTv x={35} y={15} w={90} h={55} />
  <path d="M73 29l19 10-19 10Z" fill={SKY} />
  <path d="M23 83v-10h7v4" stroke={FAINT} strokeWidth={1.5} fill="none" />
  <ellipse cx={20} cy={83} rx={3} ry={2} fill={FAINT} />
  <rect x={35} y={79} width={90} height={7} rx={3.5} fill="none" stroke={FAINT} strokeWidth={1.5} strokeDasharray="3 3" />
  <path className="vls-pb-flat" pathLength={1} d="M45 82.5h70" stroke={FAINT} strokeWidth={1.5} strokeLinecap="round" />
  <LocalSpeaker x={160} silent="absent" />
  <Pawn x={283} yb={79} s={11} color={YOU} eyes className="vls-pb-listen" />
</>;

function PlaybackViewport({ x, fullscreen, animate = false }: { x: number; fullscreen: boolean; animate?: boolean }) {
  return <>
    {!fullscreen || animate ? <g className={animate ? (fullscreen ? "vls-pb-chrome-out" : "vls-pb-chrome-in") : undefined}>
      <BrowserWindow x={x + 16} y={13} w={128} h={69} />
    </g> : null}
    <g className={animate ? (fullscreen ? "vls-pb-expand" : "vls-pb-contract") : fullscreen ? undefined : "vls-pb-windowed"}>
      <MiniTv x={x + 24} y={21} w={112} h={55} />
      <path d={`M${x + 73} 37l19 10-19 10Z`} fill={SKY} />
    </g>
    <Pawn x={x + 20} yb={83} s={9} color={YOU} eyes />
  </>;
}

function FullscreenHint({ theme, exit = false, unavailable = false }: Parameters<HintScene>[0] & {
  exit?: boolean; unavailable?: boolean;
}) {
  return <>
    <PlaybackMotion />
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <PlaybackViewport x={0} fullscreen={exit} />
    <PlaybackViewport x={160} fullscreen={!unavailable && !exit} animate={!unavailable} />
    {unavailable ? <path className="vls-pb-unavailable" d="M276 28h14v14m0-14-18 18m-2-16 18 18"
      fill="none" stroke="var(--comic-tone)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /> : null}
  </>;
}

function PictureHint({ theme, exit = false, unavailable = false }: Parameters<HintScene>[0] & {
  exit?: boolean; unavailable?: boolean;
}) {
  return <>
    <PlaybackMotion />
    {[0, 1].map((index) => {
      const x = index * 160;
      const floating = index === (exit ? 0 : 1);
      return <g key={index}>
        <Frame x={x + 4} w={152} theme={theme} result={index === 1} />
        <BrowserWindow x={x + 14} y={14} w={112} h={65} />
        <path d={`M${x + 28} 37h65m-65 9h45m-45 9h31`} stroke={FAINT} strokeWidth={2} opacity={.35} />
        <g className={index ? unavailable ? "vls-pb-unavailable" : floating ? "vls-pb-popout" : "vls-pb-popin" : undefined}>
          <MiniTv x={x + (floating ? 92 : 38)} y={floating ? 51 : 31}
            w={floating ? 54 : 70} h={floating ? 31 : 41} />
          <path d={floating ? `M${x + 113} 58l10 6-10 6Z` : `M${x + 65} 42l14 8-14 8Z`} fill={SKY} />
          {unavailable && index ? <path d={`M${x + 97} 51l42 31`} stroke={FAINT} strokeWidth={3} strokeLinecap="round" /> : null}
        </g>
        <Pawn x={x + 24} yb={85} s={9} color={YOU} eyes />
      </g>;
    })}
  </>;
}

export const PLAYBACK_SCENES: Record<PlaybackHintKind, HintScene> = {
  "hint-local-play": (props) => <PlaybackHint {...props} paused={false} />,
  "hint-local-pause": (props) => <PlaybackHint {...props} paused />,
  "hint-volume": (props) => <AudioHint {...props} action="volume" />,
  "hint-volume-basic": (props) => <AudioHint {...props} action="volume" maxPercent={100} />,
  "hint-mute": (props) => <AudioHint {...props} action="mute" />,
  "hint-unmute": (props) => <AudioHint {...props} action="unmute" />,
  "hint-no-audio": NoAudioHint,
  "hint-fullscreen": (props) => <FullscreenHint {...props} exit={false} />,
  "hint-fullscreen-exit": (props) => <FullscreenHint {...props} exit />,
  "hint-fullscreen-unavailable": (props) => <FullscreenHint {...props} unavailable />,
  "hint-pip": (props) => <PictureHint {...props} />,
  "hint-pip-exit": (props) => <PictureHint {...props} exit />,
  "hint-pip-unavailable": (props) => <PictureHint {...props} unavailable />,
};
