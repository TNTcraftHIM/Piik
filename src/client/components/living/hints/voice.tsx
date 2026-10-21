import { FAINT, Frame, Pawn, SKY, rmBlock } from "../Comic";
import { Glyph } from "../../../ui/icons";
import type { ComicTheme, HintScene, VoiceHintKind } from "../../../ui/visual-kinds";
import { MicrophoneHint } from "./set1";

function VoiceMotion() {
  return <style>{`
.vls-voice-step{animation:vlsVoiceStep var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-voice-exit{animation-name:vlsVoiceExit}
.vls-voice-blocked{animation:vlsVoiceBlocked var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-voice-listen{animation:vlsVoiceListen var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsVoiceStep{0%,10%{transform:translateX(-16px)}32%{transform:translate(2px,-3px)}44%,100%{transform:none}}
@keyframes vlsVoiceExit{0%,10%{transform:translateX(16px)}32%{transform:translate(-2px,-3px)}44%,100%{transform:none}}
@keyframes vlsVoiceBlocked{0%,10%{transform:translateX(-6px)}28%{transform:translateX(3px)}42%,100%{transform:none}}
@keyframes vlsVoiceListen{0%,12%,72%,100%{opacity:0}26%,56%{opacity:1}}
${rmBlock(["vls-voice-step", "vls-voice-exit", "vls-voice-listen"], [
  [".vls-voice-step,.vls-voice-exit", "transform:none"],
  [".vls-voice-listen", "opacity:1"],
])}
${rmBlock(["vls-voice-blocked"], [[".vls-voice-blocked", "transform:none"]], false)}
  `}</style>;
}

function MembershipHint({ theme, leave = false, host = false, closed = false }: { theme: ComicTheme; leave?: boolean; host?: boolean; closed?: boolean }) {
  return <><VoiceMotion />{[0, 160].map((x, index) => {
    const joined = !closed && Boolean(index) !== leave;
    return <g key={x}>
      <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
      <path d={`M${x + 65} 78h73V28H65`} fill="none" stroke={FAINT} strokeWidth={2} strokeDasharray="3 5" />
      <Pawn x={x + 117} yb={78} s={11} color={SKY} eyes host={closed} gaze={-1} />
      {closed && <g color={index ? "var(--comic-tone)" : "var(--ink)"}>
        <path d={`M${x + 65} 28v50`} fill="none" stroke="currentColor" strokeWidth={2.5} />
        <rect x={x + 53} y={42} width={24} height={27} rx={4} fill="var(--paper)" />
        <g transform={`translate(${x + 54} 43)`}><Glyph name="lock" size={22} /></g>
      </g>}
      <g className={index ? closed ? "vls-voice-blocked" : leave ? "vls-voice-step vls-voice-exit" : "vls-voice-step" : undefined}>
        <Pawn x={x + (joined ? 82 : 36)} yb={78} s={13} host={host} eyes gaze={joined ? 1 : -1} />
        <g transform={`translate(${x + (joined ? 73 : 27)} 17)`}><Glyph name="headphones" size={18} /></g>
      </g>
    </g>;
  })}</>;
}

function ListeningHint({ theme, deafen }: { theme: ComicTheme; deafen: boolean }) {
  return <><VoiceMotion />{[0, 160].map((x, index) => {
    const listening = Boolean(index) === !deafen;
    return <g key={x}>
      <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
      <Pawn x={x + 67} yb={79} s={14} eyes />
      <g transform={`translate(${x + 54} 17)`}><Glyph name={listening ? "headphones" : "headphonesOff"} size={26} /></g>
      {listening && <path className="vls-voice-listen" d={`M${x + 31} 26q-6 6 0 12m-6-16q-10 10 0 20`}
        fill="none" stroke={SKY} strokeWidth={2} strokeLinecap="round" />}
    </g>;
  })}</>;
}

export const VOICE_SCENES: Record<VoiceHintKind, HintScene> = {
  "hint-voice-open": props => <MembershipHint {...props} host />,
  "hint-voice-close": props => <MembershipHint {...props} host leave />,
  "hint-voice-closed": props => <MembershipHint {...props} closed />,
  "hint-voice-join": props => <MembershipHint {...props} />,
  "hint-voice-leave": props => <MembershipHint {...props} leave />,
  "hint-voice-microphone-on": props => <MicrophoneHint {...props} mode="on" host={false} />,
  "hint-voice-microphone-off": props => <MicrophoneHint {...props} mode="off" host={false} />,
  "hint-voice-host-microphone-unavailable": props => <MicrophoneHint {...props} mode="unavailable" />,
  "hint-voice-microphone-unavailable": props => <MicrophoneHint {...props} mode="unavailable" host={false} />,
  "hint-voice-microphone-volume": props => <MicrophoneHint {...props} mode="volume" host={false} />,
  "hint-voice-microphone-processing": props => <MicrophoneHint {...props} mode="processing" host={false} />,
  "hint-voice-deafen": props => <ListeningHint {...props} deafen />,
  "hint-voice-undeafen": props => <ListeningHint {...props} deafen={false} />,
};
