import { PawnSvg, type PawnState } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Chip, SwitchItem } from "../components/living/primitives";
import { Glyph, type GlyphName } from "../ui/icons";
import { useCopy } from "../ui/copy";
import "./pawn-appearance-studies.css";

export type PawnStudy = "current" | "wearable" | "earpiece" | "centred";
const STUDIES = [
  { id: "wearable", label: ["D：轻装耳麦", "D: light headset"], detail: ["耳麦随人物摆动。闭耳机时放到颈边，协作时手握鼠标。", "Wear the headset; rest it at the neck when deafened. Hold a mouse when collaborating."] },
  { id: "earpiece", label: ["E：小巧听筒", "E: small earpieces"], detail: ["省去头带，让听筒和麦杆成为人物的小配件。", "Small earpieces and a microphone, without a headband."] },
  { id: "centred", label: ["F：居中标记", "F: centred symbols"], detail: ["保留熟悉的符号，在身体下半部对称排开，不加底座。", "Keep familiar symbols centred across the lower body, without a badge."] },
  { id: "current", label: ["当前样式", "Current design"], detail: ["侧边图标，保留作对照。", "Side markers, kept for comparison."] },
] as const;
const SAMPLES: { label: [string, string]; state: PawnState }[] = [
  { label: ["未加入语音", "Not in voice"], state: {} },
  { label: ["开麦", "Mic on"], state: { voice: { microphone: true } } },
  { label: ["闭麦", "Mic off"], state: { voice: { microphone: false } } },
  { label: ["闭耳机，开麦", "Deafened, mic on"], state: { voice: { microphone: true, deafened: true } } },
  { label: ["闭耳机，闭麦", "Deafened, mic off"], state: { voice: { microphone: false, deafened: true } } },
  { label: ["协作中", "Collaborating"], state: { collaboration: true } },
  { label: ["语音与协作", "Voice and control"], state: { voice: { microphone: true }, collaboration: true } },
  { label: ["闭麦闭耳机，协作中", "Muted, deafened, collaborating"], state: { voice: { microphone: false, deafened: true }, collaboration: true } },
];
const SAMPLE_ID = "779594c8-a92c-48d9-918f-a7d0befa46d1";
const HOST_ID = "d27a938b-61f5-4ab2-b8e4-3fc090c3ae18";

// These alternatives stay in the development catalogue. The production pawn,
// identity, state and motion are reused; no appearance preference is persisted.
export function pawnStudyAdornment(study: PawnStudy, state: PawnState) {
  if (study === "current") return undefined;
  return <g className="lr-person-status cp-pawn-adornment" color="var(--person-ink)" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {study === "centred" ? <CentredSymbols {...state} /> : <Wearable {...state} compact={study === "earpiece"} />}
  </g>;
}

function Symbols({ names, y, size = 12, gap = 1 }: { names: GlyphName[]; y: number; size?: number; gap?: number }) {
  const width = names.length * size + Math.max(0, names.length - 1) * gap;
  return <>{names.map((name, index) => <g key={name} transform={`translate(${24 - width / 2 + index * (size + gap)} ${y})`}>
    <Glyph name={name} size={size} />
  </g>)}</>;
}

function voiceSymbols({ voice }: PawnState): GlyphName[] {
  return voice ? [voice.deafened ? "headphonesOff" : "headphones",
    ...(!voice.microphone ? ["microphoneOff" as const] : [])] : [];
}

function Wearable({ voice, collaboration, host, compact }: PawnState & { compact: boolean }) {
  return <>
    {voice ? <>
      {voice.deafened ? <g>
        <path d="M15 26q0 7 9 7t9-7" strokeWidth={compact ? 1.1 : 1.6} />
        <path d="M15 24v5m18-5v5" strokeWidth={compact ? 2.2 : 3.4} />
      </g> : <g>
        {!compact ? <path d={host ? "M14.8 15v-2a9.2 9.2 0 0 1 3.5-7.2m11.4 0a9.2 9.2 0 0 1 3.5 7.2v2"
          : "M14.8 15v-2a9.2 9.2 0 0 1 18.4 0v2"} strokeWidth="1.6" /> : null}
        <path d="M14.8 13v5m18.4-5v5" strokeWidth={compact ? 2.2 : 3.4} />
      </g>}
      <g transform={`translate(0 ${voice.deafened ? 9 : 0})`}>
        <path d="M33.2 18v1.2q0 3.5-5.2 3.5h-2.8" strokeWidth="1.2" />
        <path d="M23 22.7h2.7" strokeWidth="2.6" />
        {!voice.microphone ? <path d="M21.5 19.5l6 6" strokeWidth="1.6" /> : null}
      </g>
    </> : null}
    {collaboration ? <>
      <path d="M15.5 38q1.5 4.5 5 4.5m7 0q3.5 0 5-4.5" strokeOpacity=".55" />
      <rect x="20" y="36" width="8" height="12" rx="4" fill="var(--couch)" strokeWidth="1.4" />
      <path d="M24 36.5v4" strokeWidth="1.2" />
    </> : null}
  </>;
}

function CentredSymbols(state: PawnState) {
  const names: GlyphName[] = [...voiceSymbols(state), ...(state.collaboration ? ["mouse" as const] : [])];
  if (!names.length) return null;
  return <Symbols names={names} y={36} size={13} />;
}

export function PawnAppearanceStudies({ selected, onSelect, guides, onGuides }: {
  selected: PawnStudy; onSelect: (value: PawnStudy) => void;
  guides: boolean; onGuides: (value: boolean) => void;
}) {
  const { lang } = useCopy();
  const en = lang === "en";
  const language = en ? 1 : 0;
  return <div id="pawn-appearance-preview" className="cp-pawn-studies" data-guides={guides || undefined}>
    <div className="cp-tools">
      <h3>{en ? "Participant appearance" : "人物状态外观"}</h3>
      <SwitchItem checked={guides} onChange={onGuides} label={en ? "Centre guides" : "中心线对照"} />
    </div>
    <p>{en ? "Three new directions, with the same people and states. Choose one to preview it on the couch below."
      : "三种新方向，用同一组人物和状态对照。选择一版，下方沙发会同步展示。"}</p>
    <div className="cp-pawn-study-grid">
      {STUDIES.map(study => <section key={study.id} className="cp-pawn-study" data-study={study.id} data-selected={selected === study.id || undefined}>
        <header><Chip title={study.label[language]} selected={selected === study.id} onClick={() => onSelect(study.id)}>{study.label[language]}</Chip></header>
        <p>{study.detail[language]}</p>
        {study.id !== "current" ? <div className="cp-pawn-study-detail" aria-label={en ? "Enlarged detail" : "放大细节"}>
          {[false, true].map(host => {
            const state: PawnState = { host, voice: { microphone: true }, collaboration: !host };
            const identity = host ? HOST_ID : SAMPLE_ID;
            return <PawnSvg key={String(host)} color={participantColor(identity)} identity={identity}
              {...state} adornment={pawnStudyAdornment(study.id, state)} />;
          })}
          <span>{en ? "Detail ×2" : "细节 ×2"}</span>
        </div> : null}
        <div className="cp-pawn-study-samples">
          {SAMPLES.map(({ label, state }, index) => <figure key={index}>
            <span className="cp-pawn-study-figure"><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID}
              {...state} adornment={pawnStudyAdornment(study.id, state)} /></span>
            <figcaption>{label[language].split(en ? ", " : "，").map(part => <span key={part}>{part}</span>)}</figcaption>
          </figure>)}
        </div>
      </section>)}
    </div>
    <a className="cp-pawn-couch-link" href="#pawn-study-couch">{en ? "See the selected design on the couch" : "查看下方沙发中的效果"}</a>
  </div>;
}
