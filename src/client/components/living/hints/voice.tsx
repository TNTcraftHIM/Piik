import { FAINT, Frame, Pawn, SKY, WARN, rmBlock } from "../Comic";
import { Glyph } from "../../../ui/icons";
import type { ComicTheme, HintScene, VoiceHintKind } from "../../../ui/visual-kinds";
import { MicrophoneHint } from "./set1";

function VoiceMotion() {
  return <style>{`
.vls-voice-step{animation:vlsVoiceStep var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-voice-exit{animation-name:vlsVoiceExit}
.vls-voice-permission{animation:vlsVoicePermission var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-voice-listen{animation:vlsVoiceListen var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsVoiceStep{0%,10%{transform:translateX(-16px)}32%{transform:translate(2px,-3px)}44%,100%{transform:none}}
@keyframes vlsVoiceExit{0%,10%{transform:translateX(16px)}32%{transform:translate(-2px,-3px)}44%,100%{transform:none}}
@keyframes vlsVoicePermission{0%,12%{opacity:0;transform:translateX(-8px)}34%,100%{opacity:1;transform:none}}
@keyframes vlsVoiceListen{0%,12%,72%,100%{opacity:0}26%,56%{opacity:1}}
${rmBlock(["vls-voice-step", "vls-voice-exit", "vls-voice-permission", "vls-voice-listen"], [
  [".vls-voice-step,.vls-voice-exit,.vls-voice-permission", "transform:none"],
  [".vls-voice-permission,.vls-voice-listen", "opacity:1"],
])}
  `}</style>;
}

function MembershipHint({ theme, leave = false }: { theme: ComicTheme; leave?: boolean }) {
  return <><VoiceMotion />{[0, 160].map((x, index) => {
    const joined = Boolean(index) !== leave;
    return <g key={x}>
      <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
      <path d={`M${x + 65} 78h73V28H65`} fill="none" stroke={FAINT} strokeWidth={2} strokeDasharray="3 5" />
      <Pawn x={x + 117} yb={78} s={11} color={SKY} eyes gaze={-1} />
      <g className={index ? leave ? "vls-voice-step vls-voice-exit" : "vls-voice-step" : undefined}>
        <Pawn x={x + (joined ? 82 : 36)} yb={78} s={13} eyes gaze={joined ? 1 : -1} />
        <g transform={`translate(${x + (joined ? 73 : 27)} 17)`}><Glyph name="headphones" size={18} /></g>
      </g>
    </g>;
  })}</>;
}

function PermissionHint({ theme, action }: { theme: ComicTheme; action: "listen" | "speak" | "silence" | "remove" }) {
  const grant = action === "listen" || action === "speak";
  return <><VoiceMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <Pawn x={x + 32} yb={78} s={12} host eyes gaze={2} />
    <Pawn x={x + 119} yb={78} s={12} color={SKY} eyes gaze={-2} />
    <g transform={`translate(${x + 109} 16)`}>
      <Glyph name={action === "listen" ? "headphones" : action === "remove" ? "headphonesOff" : "microphoneOff"} size={20} />
    </g>
    <g className={index ? "vls-voice-permission" : undefined}>
      <path d={`M${x + 53} 57h38m-6-5 6 5-6 5`} fill="none" stroke={FAINT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <g transform={`translate(${x + 66} 30)`} style={{ color: grant ? SKY : WARN }}>
        <Glyph name={grant ? "key" : "x"} size={18} />
      </g>
      {Boolean(index) && <g transform={`translate(${x + 132} 41)`} style={{ color: grant ? SKY : WARN }}>
        <Glyph name={grant ? "check" : "x"} size={12} />
      </g>}
    </g>
  </g>)}</>;
}

function ListeningHint({ theme, deafen }: { theme: ComicTheme; deafen: boolean }) {
  return <><VoiceMotion />{[0, 160].map((x, index) => {
    const listening = Boolean(index) === !deafen;
    return <g key={x}>
      <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
      <Pawn x={x + 67} yb={79} s={14} eyes />
      <g transform={`translate(${x + 54} 17)`}><Glyph name={listening ? "headphones" : "headphonesOff"} size={26} /></g>
      <g transform={`translate(${x + 106} 54)`}><Glyph name="microphoneOff" size={20} /></g>
      {listening && <path className="vls-voice-listen" d={`M${x + 31} 26q-6 6 0 12m-6-16q-10 10 0 20`}
        fill="none" stroke={SKY} strokeWidth={2} strokeLinecap="round" />}
    </g>;
  })}</>;
}

export const VOICE_SCENES: Record<VoiceHintKind, HintScene> = {
  "hint-voice-join": props => <MembershipHint {...props} />,
  "hint-voice-leave": props => <MembershipHint {...props} leave />,
  "hint-voice-allow-listen": props => <PermissionHint {...props} action="listen" />,
  "hint-voice-allow-speak": props => <PermissionHint {...props} action="speak" />,
  "hint-voice-revoke-speak": props => <PermissionHint {...props} action="silence" />,
  "hint-voice-remove": props => <PermissionHint {...props} action="remove" />,
  "hint-voice-microphone-on": props => <MicrophoneHint {...props} mode="on" host={false} />,
  "hint-voice-microphone-off": props => <MicrophoneHint {...props} mode="off" host={false} />,
  "hint-voice-deafen": props => <ListeningHint {...props} deafen />,
  "hint-voice-undeafen": props => <ListeningHint {...props} deafen={false} />,
};
