import { PawnSvg, type PawnState } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Chip, SwitchItem } from "../components/living/primitives";
import { Glyph, type GlyphName } from "../ui/icons";
import { useCopy } from "../ui/copy";
import "./pawn-appearance-studies.css";

export type PawnStudy = "current" | "print" | "headset" | "pocket";
const STUDIES = [
  { id: "current", zh: "当前：侧边标记", en: "Current: side markers", detail: ["现有样式，作为对照。", "The existing design for comparison."] },
  { id: "print", zh: "A：胸前印花", en: "A: shirt print", detail: ["状态像衣服上的图案，集中在身体内。", "Status symbols printed inside the silhouette."] },
  { id: "headset", zh: "B：贴身耳机", en: "B: fitted headset", detail: ["闭耳机时挂到脖子上，控制标记留在胸前。", "Headphones rest around the neck when deafened."] },
  { id: "pocket", zh: "C：耳塞与口袋", en: "C: earbuds and pocket", detail: ["细耳塞搭配小口袋，把状态融入服饰。", "Fine earbuds and a small pocket carry the cues."] },
] as const;
const SAMPLES: { label: [string, string]; state: PawnState }[] = [
  { label: ["未加入语音", "Not in voice"], state: {} },
  { label: ["开麦", "Mic on"], state: { voice: { microphone: true } } },
  { label: ["闭麦", "Mic off"], state: { voice: { microphone: false } } },
  { label: ["闭耳机，开麦", "Deafened, mic on"], state: { voice: { microphone: true, deafened: true } } },
  { label: ["闭耳机，闭麦", "Deafened, mic off"], state: { voice: { microphone: false, deafened: true } } },
  { label: ["控制中", "Controlling"], state: { collaboration: true } },
  { label: ["语音与控制", "Voice and control"], state: { voice: { microphone: true }, collaboration: true } },
  { label: ["闭麦闭耳机，控制中", "Muted, deafened, controlling"], state: { voice: { microphone: false, deafened: true }, collaboration: true } },
];
const SAMPLE_ID = "779594c8-a92c-48d9-918f-a7d0befa46d1";

// Study art stays in the development catalogue. The figure, colour, state and
// motion still come from the normal pawn; there is no product appearance setting.
export function pawnStudyAdornment(study: PawnStudy, state: PawnState) {
  if (study === "current") return undefined;
  return <g className="lr-person-status cp-pawn-adornment" color="var(--person-ink)" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {study === "print" ? <ShirtPrint {...state} />
      : study === "headset" ? <FittedHeadset {...state} /> : <PocketEarbuds {...state} />}
  </g>;
}

function Symbols({ names, y, size = 12 }: { names: GlyphName[]; y: number; size?: number }) {
  const width = names.length * size;
  return <>{names.map((name, index) => <g key={name} transform={`translate(${24 - width / 2 + index * size} ${y})`}>
    <Glyph name={name} size={size} />
  </g>)}</>;
}

function inputSymbols({ voice, collaboration }: PawnState): GlyphName[] {
  return [...(voice && !voice.microphone ? ["microphoneOff" as const] : []), ...(collaboration ? ["mouse" as const] : [])];
}

function ShirtPrint(state: PawnState) {
  const { voice, collaboration } = state;
  if (!voice && !collaboration) return null;
  const inputs = inputSymbols(state);
  return <>
    <path d="M19 28.3q5 4.8 10 0" opacity=".45" />
    {voice ? <Symbols names={[voice.deafened ? "headphonesOff" : "headphones"]} y={inputs.length ? 31 : 33} size={12} /> : null}
    <Symbols names={inputs} y={voice ? 41 : 34} size={voice ? 9 : 13} />
  </>;
}

function FittedHeadset(state: PawnState) {
  const { voice, host } = state;
  const inputs = inputSymbols(state);
  return <>
    {voice ? voice.deafened ? <>
      <path d="M15 25q0 8 9 8t9-8" strokeWidth="1.8" />
      <rect x="13.5" y="23" width="4" height="7" rx="1.8" fill="currentColor" stroke="none" />
      <rect x="30.5" y="23" width="4" height="7" rx="1.8" fill="currentColor" stroke="none" />
    </> : <>
      <path d={host ? "M14 14v-1q0-6 4-8m12 0q4 2 4 8v1" : "M14 14v-1a10 10 0 0 1 20 0v1"} strokeWidth="1.8" />
      <rect x="12.5" y="12" width="4" height="8" rx="1.8" fill="currentColor" stroke="none" />
      <rect x="31.5" y="12" width="4" height="8" rx="1.8" fill="currentColor" stroke="none" />
    </> : null}
    <Symbols names={inputs} y={35} size={inputs.length > 1 ? 13 : 14} />
  </>;
}

function PocketEarbuds(state: PawnState) {
  const { voice, collaboration } = state;
  if (!voice && !collaboration) return null;
  return <>
    {voice ? <>
      <path d={voice.deafened ? "M18 27v3q0 3 6 3t6-3v-3" : "M16 17v6q0 9 8 9t8-9v-6"} opacity=".65" strokeWidth="1.2" />
      <g transform={voice.deafened ? "translate(2 10)" : undefined}>
        <path d="M15 13v6" strokeWidth="3" />
      </g>
      <g transform={voice.deafened ? "translate(-2 10)" : undefined}>
        <path d="M33 13v6" strokeWidth="3" />
      </g>
    </> : null}
    {(voice && !voice.microphone) || collaboration ? <>
      <path d="M13 36h22v8q-11 9-22 0Z" fill="currentColor" fillOpacity=".1" strokeOpacity=".4" strokeWidth="1" />
      <Symbols names={inputSymbols(state)} y={36.5} size={11} />
    </> : null}
  </>;
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
      <h3>{en ? "Wear the state" : "把状态穿在身上"}</h3>
      <SwitchItem checked={guides} onChange={onGuides} label={en ? "Centre guides" : "中心线对照"} />
    </div>
    <p>{en ? "Compare at actual size. Choose a design to see it on the couch below; the same people and gestures are preserved."
      : "按实际大小对照。选一版，下面的沙发也会同步换装；人物、颜色和小动作保持一致。"}</p>
    <div className="cp-pawn-study-grid">
      {STUDIES.map(study => <section key={study.id} className="cp-pawn-study" data-selected={selected === study.id || undefined}>
        <header><Chip title={en ? study.en : study.zh} selected={selected === study.id} onClick={() => onSelect(study.id)}>{en ? study.en : study.zh}</Chip></header>
        <p>{study.detail[language]}</p>
        <div className="cp-pawn-study-samples">
          {SAMPLES.map(({ label, state }, index) => <figure key={index}>
            <span className="cp-pawn-study-figure"><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID}
              {...state} adornment={pawnStudyAdornment(study.id, state)} /></span>
            <figcaption>{label[language]}</figcaption>
          </figure>)}
        </div>
      </section>)}
    </div>
    <a className="cp-pawn-couch-link" href="#pawn-study-couch">{en ? "See the selected design on the couch" : "查看下方沙发中的效果"}</a>
  </div>;
}
