import { PawnSvg, type PawnState } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Chip, SwitchItem } from "../components/living/primitives";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import "./pawn-appearance-studies.css";

export type PawnStudy = "wearable" | "mute-mark" | "lapel" | "mouth-mark";
const STUDIES = [
  { id: "mute-mark", label: ["D1：静音胸标", "D1: mute symbol"], detail: ["闭麦时才出现划线麦克风，开麦时保持干净。", "A crossed microphone appears only when muted."] },
  { id: "lapel", label: ["D2：领夹麦", "D2: lapel mic"], detail: ["麦克风一直可见，闭麦时加斜线，位置不变。", "Keep the microphone visible; add a slash when muted."] },
  { id: "mouth-mark", label: ["D3：嘴边记号", "D3: quiet face"], detail: ["闭麦时嘴边出现小叉，保持身体轮廓简洁。", "A small cross at the mouth when muted, leaving the body clear."] },
  { id: "wearable", label: ["D：原方案对照", "D: previous design"], detail: ["此前的细麦杆方案，保留作对照。", "The previous small boom microphone, for comparison."] },
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

// These alternatives stay in the development catalogue. The production pawn,
// identity, state and motion are reused; no appearance preference is persisted.
export function pawnStudyAdornment(study: PawnStudy, state: PawnState) {
  return <g className="lr-person-status cp-pawn-adornment" color="var(--person-ink)" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <Wearable {...state} study={study} />
  </g>;
}

function Wearable({ voice, collaboration, host, study }: PawnState & { study: PawnStudy }) {
  const original = study === "wearable";
  return <>
    {voice ? <>
      {voice.deafened ? <g transform={original ? undefined : "translate(0 -5)"}>
        <path d="M15 26q0 7 9 7t9-7" strokeWidth="1.6" />
        <path d="M15 24v5m18-5v5" strokeWidth="3.4" />
      </g> : <g>
        <path d={host ? "M14.8 15v-2a9.2 9.2 0 0 1 3.5-7.2m11.4 0a9.2 9.2 0 0 1 3.5 7.2v2"
          : "M14.8 15v-2a9.2 9.2 0 0 1 18.4 0v2"} strokeWidth="1.6" />
        <path d="M14.8 13v5m18.4-5v5" strokeWidth="3.4" />
      </g>}
      {original ? <g transform={`translate(0 ${voice.deafened ? 9 : 0})`}>
        <path d="M33.2 18v1.2q0 3.5-5.2 3.5h-2.8" strokeWidth="1.2" />
        <path d="M23 22.7h2.7" strokeWidth="2.6" />
        {!voice.microphone ? <path d="M21.5 19.5l6 6" strokeWidth="1.6" /> : null}
      </g> : null}
      {study === "lapel" || (study === "mute-mark" && !voice.microphone) ?
        <g transform="translate(17.5 27.5)"><Glyph name={voice.microphone ? "microphone" : "microphoneOff"} size={13} /></g> : null}
      {study === "mouth-mark" && !voice.microphone ? <path d="M21.5 17.5l5 3m0-3l-5 3" strokeWidth="1.4" /> : null}
    </> : null}
    {collaboration ? <g transform={original ? undefined : "translate(0 4)"}>
      <path d="M15.5 38q1.5 4.5 5 4.5m7 0q3.5 0 5-4.5" strokeOpacity=".55" />
      <rect x="20" y="36" width="8" height={original ? 12 : 11} rx="4" fill="var(--couch)" strokeWidth="1.4" />
      <path d="M24 36.5v4" strokeWidth="1.2" />
    </g> : null}
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
      <h3>{en ? "A clearer microphone state" : "开麦与闭麦，怎么表达"}</h3>
      <SwitchItem checked={guides} onChange={onGuides} label={en ? "Centre guides" : "中心线对照"} />
    </div>
    <p>{en ? "Keep the light headphones. Compare three microphone cues at actual size, then choose one to see it on the couch."
      : "保留轻装耳机，单独比较麦克风的表达。点选一版，下方沙发会同步展示。"}</p>
    <div className="cp-pawn-study-grid">
      {STUDIES.map(study => <section key={study.id} className="cp-pawn-study" data-study={study.id} data-selected={selected === study.id || undefined}>
        <header><Chip title={study.label[language]} selected={selected === study.id} onClick={() => onSelect(study.id)}>{study.label[language]}</Chip></header>
        <p>{study.detail[language]}</p>
        {study.id !== "wearable" ? <div className="cp-pawn-study-detail" aria-label={en ? "Enlarged detail" : "放大细节"}>
          {[true, false].map(microphone => {
            const state: PawnState = { voice: { microphone } };
            return <figure key={String(microphone)}><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID}
              {...state} adornment={pawnStudyAdornment(study.id, state)} />
              <figcaption>{en ? microphone ? "Mic on" : "Mic off" : microphone ? "开麦" : "闭麦"}</figcaption>
            </figure>;
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
