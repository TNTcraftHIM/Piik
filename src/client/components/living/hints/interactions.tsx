import { FAINT, Frame, MiniTv, Pawn, SKY, YOU, rmBlock } from "../Comic";
import { Glyph } from "../../../ui/icons";
import type { ComicTheme, HintScene, InteractionHintKind } from "../../../ui/visual-kinds";

function InteractionMotion() {
  return <style>{`
.vls-talk-bubble{animation:vlsTalkBubble var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-talk-off{animation:vlsTalkOff var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-talk-nod{transform-box:fill-box;transform-origin:50% 100%;animation:vlsTalkNod var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsTalkBubble{0%,12%{transform:translateY(3px);opacity:0}32%,100%{transform:none;opacity:1}}
@keyframes vlsTalkOff{0%,12%{opacity:1}32%,100%{opacity:0}}
@keyframes vlsTalkNod{0%,30%,55%,100%{transform:none}42%{transform:rotate(-5deg)}}
${rmBlock(["vls-talk-bubble", "vls-talk-off", "vls-talk-nod"], [
  [".vls-talk-bubble", "transform:none;opacity:1"],
  [".vls-talk-off", "opacity:0"], [".vls-talk-nod", "transform:none"],
])}
`}</style>;
}

function Bubble({ x, y, color = YOU }: { x: number; y: number; color?: string }) {
  return <g transform={`translate(${x} ${y})`}>
    <path d="M4 0h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H12l-7 6v-6H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z"
      fill="var(--paper)" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    <path d="M8 7h20M8 13h13" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </g>;
}

function ChatHint({ theme, send = false }: { theme: ComicTheme; send?: boolean }) {
  return <><InteractionMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <Pawn x={x + 38} yb={81} s={12} eyes />
    <Pawn x={x + 120} yb={81} s={12} color={SKY} eyes className={index ? "vls-talk-nod" : undefined} />
    {send || index ? <Bubble x={x + 22} y={15} /> : <g transform={`translate(${x + 64} 24)`}><Glyph name="chat" size={26} /></g>}
    {Boolean(index) && <g className="vls-talk-bubble"><Bubble x={x + 101} y={send ? 15 : 23} color={send ? YOU : SKY} /></g>}
  </g>)}</>;
}

// The picture and chat stay present in both panels; only on-picture text changes.
function OverlayHint({ theme, show }: { theme: ComicTheme; show: boolean }) {
  return <><InteractionMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <MiniTv x={x + 26} y={16} w={113} h={58} />
    <path d={`M${x + 36} 61l22-22 18 14 16-18 37 26Z`} fill={SKY} opacity={.65} />
    <g opacity={(index ? show : !show) ? 1 : 0} className={index ? show ? "vls-talk-bubble" : "vls-talk-off" : undefined}
      stroke="#dfe8f2" strokeWidth={3} strokeLinecap="round">
      <path d={`M${x + 64} 29h28m7 0h16M${x + 43} 39h30m8 0h9`} />
    </g>
    <Pawn x={x + 26} yb={85} s={9} eyes />
    <g transform={`translate(${x + 60} 75)`}><Glyph name="chat" size={16} /></g>
    <path d={`M${x + 82} 82h24`} stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
  </g>)}</>;
}

function ChatSettingsHint({ theme }: { theme: ComicTheme }) {
  return <><InteractionMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <MiniTv x={x + 25} y={14} w={110} h={59} />
    <path d={`M${x + 36} 62l24-25 19 17 17-12 29 20Z`} fill={SKY} opacity={.5} />
    <g className={index ? "vls-talk-bubble" : undefined}>
      <path d={`M${x + 45} 31h${index ? 38 : 25}m7 0h${index ? 20 : 12}`}
        stroke="#dfe8f2" strokeWidth={index ? 5 : 3} opacity={index ? .65 : 1} strokeLinecap="round" />
    </g>
    <Pawn x={x + 25} yb={87} s={9} eyes className={index ? "vls-talk-nod" : undefined} />
    <g transform={`translate(${x + 75} 74)`}><Glyph name="sliders" size={17} /></g>
  </g>)}</>;
}

function PanelWindowHint({ theme }: { theme: ComicTheme }) {
  return <><InteractionMotion />{[0, 160].map((x, index) => {
    const floating = Boolean(index);
    return <g key={x}>
      <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
      <MiniTv x={x + 20} y={19} w={100} h={56} />
      <path d={`M${x + 29} 62l20-20 17 14 18-21 26 27Z`} fill={SKY} opacity={.5} />
      <g className={index ? "vls-talk-bubble" : undefined}>
        <rect x={x + (floating ? 88 : 76)} y={floating ? 9 : 28} width={floating ? 48 : 34} height={floating ? 58 : 38}
          rx={5} fill="var(--paper)" stroke={YOU} strokeWidth={2} />
        <path d={`M${x + (floating ? 96 : 82)} ${floating ? 19 : 36}h${floating ? 22 : 18}`} stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
        <g transform={`translate(${x + (floating ? 98 : 83)} ${floating ? 30 : 43})`}><Glyph name="sliders" size={floating ? 27 : 20} /></g>
      </g>
    </g>;
  })}</>;
}

function ChatExportHint({ theme }: { theme: ComicTheme }) {
  return <><InteractionMotion />{[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <Pawn x={x + 35} yb={83} s={12} eyes className={index ? "vls-talk-nod" : undefined} />
    <Bubble x={x + 19} y={15} />
    {index ? <g className="vls-talk-bubble">
      <rect x={x + 93} y={21} width={39} height={50} rx={4} fill="var(--paper)" stroke={FAINT} strokeWidth={2} />
      <path d={`M${x + 101} 33h23m-23 9h16m-16 9h23`} stroke={YOU} strokeWidth={2} strokeLinecap="round" />
      <g transform={`translate(${x + 102} 60)`}><Glyph name="save" size={19} /></g>
    </g> : <Bubble x={x + 95} y={42} color={SKY} />}
  </g>)}</>;
}

function FileHint({ theme, download = false }: { theme: ComicTheme; download?: boolean }) {
  return <><InteractionMotion />{[0, 160].map((x, index) => {
    const draft = download ? !index : Boolean(index);
    return <g key={x}>
      <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
      <Pawn x={x + 30} yb={83} s={11} eyes className={index ? "vls-talk-nod" : undefined} />
      {draft ? <>
        <rect x={x + 56} y={14} width={82} height={66} rx={7} fill="var(--paper)" stroke={FAINT} strokeWidth={2} />
        <g transform={`translate(${x + 62} 19)`}><Glyph name="chat" size={14} /></g>
        <path d={`M${x + 64} 69h47`} stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
        {!download && <g transform={`translate(${x + 119} 63)`}><Glyph name="send" size={12} /></g>}
      </> : <>
        <path d={`M${x + 56} 32v-9a4 4 0 0 1 4-4h23l7 9h44a4 4 0 0 1 4 4v43a4 4 0 0 1-4 4H${x + 60}a4 4 0 0 1-4-4V32Z`}
          fill="var(--wall-2)" stroke={FAINT} strokeWidth={2} strokeLinejoin="round" />
        {download && Boolean(index) && <g transform={`translate(${x + 117} 60)`}><Glyph name="save" size={15} /></g>}
      </>}
      <g className={index ? "vls-talk-bubble" : undefined}>
        <path d={`M${x + 82} 30h18l9 9v22H${x + 82}Z`} fill="var(--paper)" stroke={YOU} strokeWidth={2} strokeLinejoin="round" />
        <path d={`M${x + 100} 30v9h9m-21 8h14m-14 7h10`} fill="none" stroke={YOU} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {!index && <g transform={`translate(${x + 119} 43)`}><Glyph name={download ? "arrowDown" : "plus"} size={15} /></g>}
    </g>;
  })}</>;
}

const ReactionPickerHint: HintScene = ({ theme }) => <>
  <InteractionMotion />
  {[0, 160].map((x, index) => <g key={x}>
    <Frame x={x + 4} w={152} theme={theme} result={Boolean(index)} />
    <rect x={x + 24} y={66} width={112} height={20} rx={7} fill="var(--wall-2)" stroke={FAINT} strokeWidth={2} />
    <g transform={`translate(${x + 31} 68)`}><Glyph name="smile" size={16} /></g>
    {index ? <g className="vls-talk-bubble">
      <rect x={x + 24} y={12} width={112} height={49} rx={7} fill="var(--paper)" stroke={YOU} strokeWidth={2} />
      <Pawn x={x + 57} yb={34} s={6} eyes /><Pawn x={x + 100} yb={34} s={6} color={SKY} eyes />
      {(["smile", "heart", "star"] as const).map((name, i) => <g key={name} transform={`translate(${x + 43 + i * 27} 39)`}>
        <Glyph name={name} size={15} />
      </g>)}
    </g> : <>
      <Pawn x={x + 57} yb={54} s={10} eyes /><Pawn x={x + 104} yb={54} s={10} color={SKY} eyes />
    </>}
  </g>)}
</>;

export const INTERACTION_SCENES: Record<InteractionHintKind, HintScene> = {
  "hint-reaction-picker": ReactionPickerHint,
  "hint-chat-open": props => <ChatHint {...props} />,
  "hint-chat-send": props => <ChatHint {...props} send />,
  "hint-chat-settings": props => <ChatSettingsHint {...props} />,
  "hint-chat-export": props => <ChatExportHint {...props} />,
  "hint-file-add": props => <FileHint {...props} />,
  "hint-file-download": props => <FileHint {...props} download />,
  "hint-window-detach": props => <PanelWindowHint {...props} />,
  "hint-chat-overlay-show": props => <OverlayHint {...props} show />,
  "hint-chat-overlay-hide": props => <OverlayHint {...props} show={false} />,
};
