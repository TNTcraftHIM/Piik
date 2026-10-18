import { FAINT, Frame, MiniTv, Pawn, SKY, rmBlock } from "../Comic";
import { Glyph } from "../../../ui/icons";
import type { ComicTheme, HintScene, RemoteHintKind } from "../../../ui/visual-kinds";

function RemoteMotion() {
  return <style>{`
.vls-remote-cursor{animation:vlsRemoteCursor var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-remote-stop{animation:vlsRemoteStop var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-remote-pan{animation:vlsRemotePan var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-combination-modifier{animation:vlsCombinationModifier var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-combination-key{animation:vlsCombinationKey var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsRemoteCursor{0%,10%{transform:translate(-10px,8px);opacity:0}24%{opacity:1}42%,100%{transform:none;opacity:1}}
@keyframes vlsRemoteStop{0%,12%{opacity:1}36%,100%{opacity:0}}
@keyframes vlsRemotePan{0%,12%,72%,100%{transform:none}40%{transform:translateX(-9px)}}
@keyframes vlsCombinationModifier{0%,10%,82%,100%{opacity:0}22%,68%{opacity:1}}
@keyframes vlsCombinationKey{0%,40%,82%,100%{opacity:0}50%,68%{opacity:1}}
${rmBlock(["vls-remote-cursor", "vls-remote-stop", "vls-remote-pan", "vls-combination-modifier", "vls-combination-key"], [
  [".vls-remote-cursor", "transform:none;opacity:1"],
  [".vls-remote-stop", "opacity:0"], [".vls-remote-pan", "transform:none"],
  [".vls-combination-modifier,.vls-combination-key", "opacity:1"],
])}
`}</style>;
}

function Cursor({ x, y }: { x: number; y: number }) {
  return <path d={`M${x} ${y}v16l4-4 4 7 3-2-4-7 7-1Z`} fill="#dfe8f2" stroke={SKY} strokeWidth={1.5} strokeLinejoin="round" />;
}

function ControlHint({ theme, stop = false }: { theme: ComicTheme; stop?: boolean }) {
  return <><RemoteMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <MiniTv x={x + 49} y={22} w={70} h={42} />
    <Pawn x={x + 27} yb={83} s={11} color={SKY} eyes gaze={2} />
    <Pawn x={x + 133} yb={83} s={11} host eyes gaze={-2} />
    <g transform={`translate(${x + 51} 70)`}><Glyph name="mouse" size={17} /></g>
    <path d={`M${x + 72} 72h35v11h-35Z m5 5h25`} fill="none" stroke={FAINT} strokeWidth={2} strokeLinejoin="round" />
    {stop || index ? <g className={index ? stop ? "vls-remote-stop" : "vls-remote-cursor" : undefined}>
      <Cursor x={x + 82} y={35} />
    </g> : <g transform={`translate(${x + 124} 20)`}><Glyph name="clock" size={17} /></g>}
    {Boolean(index) && <g transform={`translate(${x + 124} 20)`}><Glyph name={stop ? "x" : "check"} size={17} /></g>}
  </g>)}</>;
}

function MouseLockHint({ theme, lock }: { theme: ComicTheme; lock: boolean }) {
  return <><RemoteMotion />{[0, 160].map((x, index) => {
    const captured = index ? lock : !lock;
    return <g key={x}>
      <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
      <MiniTv x={x + 25} y={15} w={110} h={58} />
      <g className={captured ? "vls-remote-pan" : undefined}>
        <path d={`M${x + 45} 56l12-18 13 12 15-20 27 26Z`} fill={SKY} opacity={.6} />
      </g>
      {captured ? <path d={`M${x + 80} 33v7m0 8v7m-11-11h7m8 0h7`} stroke="#dfe8f2" strokeWidth={2} strokeLinecap="round" />
        : <g className={index ? "vls-remote-cursor" : undefined}><Cursor x={x + 82} y={37} /></g>}
      <g transform={`translate(${x + 72} 73)`}><Glyph name="mouse" size={16} /></g>
      {captured && <path d={`M${x + 62} 80h-9l4-4m-4 4 4 4m41-4h9l-4-4m4 4-4 4`}
        fill="none" stroke={FAINT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
    </g>;
  })}</>;
}

export const REMOTE_SCENES: Record<RemoteHintKind, HintScene> = {
  "hint-key-combination": ({ theme }) => <><RemoteMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <g transform={`translate(${x + 30} 26)`}>
      <rect width={40} height={40} rx={8} fill="none" stroke={FAINT} strokeWidth={2} />
      <rect className="vls-combination-modifier" width={40} height={40} rx={8} fill={SKY} fillOpacity={.25} stroke={SKY} strokeWidth={2} />
      <path d="m20 10-10 11h6v9h8v-9h6Z" fill="none" stroke={FAINT} strokeWidth={2} strokeLinejoin="round" />
    </g>
    <path d={`M${x + 76} 46h8m-4-4v8`} stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
    <g transform={`translate(${x + 90} 26)`}>
      <rect width={40} height={40} rx={8} fill="none" stroke={FAINT} strokeWidth={2} />
      {Boolean(index) && <rect className="vls-combination-key" width={40} height={40} rx={8} fill={SKY} fillOpacity={.25} stroke={SKY} strokeWidth={2} />}
      <path d="m11 29 9-18 9 18m-14-6h10" fill="none" stroke={FAINT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  </g>)}</>,
  "hint-remote-keyboard": ({ theme }) => <><RemoteMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <MiniTv x={x + 40} y={13} w={80} h={45} />
    <g transform={`translate(${x + 64} 60)`}><Glyph name="keyboard" size={32} /></g>
    {Boolean(index) && <g className="vls-remote-cursor"><path d={`M${x + 57} 35h16m5 0h12m-33 7h25`} fill="none" stroke={SKY} strokeWidth={3} strokeLinecap="round" /></g>}
  </g>)}</>,
  "hint-remote-control": props => <ControlHint {...props} />,
  "hint-remote-stop": props => <ControlHint {...props} stop />,
  "hint-remote-mouse-lock": props => <MouseLockHint {...props} lock />,
  "hint-remote-mouse-release": props => <MouseLockHint {...props} lock={false} />,
};
