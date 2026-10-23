import { PawnSvg, type PawnState } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Chip, SwitchItem } from "../components/living/primitives";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import "./pawn-appearance-studies.css";

export type PawnStudy = "mouse-pin" | "cursor-pin" | "desk" | "held-mouse";
const STUDIES = [
  { id: "mouse-pin", label: ["R1：鼠标胸针", "R1: mouse pin"], detail: ["沿用熟悉的鼠标符号，简化成衣服上的小图案。", "The familiar mouse symbol, worn as a small shirt pin."] },
  { id: "cursor-pin", label: ["R2：光标图案", "R2: cursor emblem"], detail: ["把光标印在衣服上，小尺寸下轮廓也清楚。", "A simple cursor on the shirt, clear at small sizes."] },
  { id: "desk", label: ["R3：小操作台", "R3: little desk"], detail: ["身前摆上小键盘和鼠标，像坐在一起操作电脑。", "A little keyboard and mouse, as if using a computer together."] },
  { id: "held-mouse", label: ["D3：原方案对照", "D3: previous design"], detail: ["保留嘴边静音记号，对照原先的手持鼠标。", "Keep the accepted mute mark and compare the original held mouse."] },
] as const;
const SAMPLES: { label: [string, string]; state: PawnState }[] = [
  { label: ["未参与控制", "Not controlling"], state: {} },
  { label: ["协作中", "Collaborating"], state: { collaboration: true } },
  { label: ["仅语音", "Voice only"], state: { voice: { microphone: true } } },
  { label: ["语音与协作", "Voice and control"], state: { voice: { microphone: true }, collaboration: true } },
  { label: ["闭麦，协作中", "Muted, collaborating"], state: { voice: { microphone: false }, collaboration: true } },
  { label: ["闭耳机，协作中", "Deafened, collaborating"], state: { voice: { microphone: true, deafened: true }, collaboration: true } },
  { label: ["闭麦闭耳机，协作中", "Muted, deafened, collaborating"], state: { voice: { microphone: false, deafened: true }, collaboration: true } },
  { label: ["房主，闭麦", "Host, muted"], state: { host: true, voice: { microphone: false } } },
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
  return <>
    {voice ? <>
      {voice.deafened ? <g>
        <path d="M15 21q0 7 9 7t9-7" strokeWidth="1.6" />
        <path d="M15 19v5m18-5v5" strokeWidth="3.4" />
      </g> : <g>
        <path d={host ? "M14.8 15v-2a9.2 9.2 0 0 1 3.5-7.2m11.4 0a9.2 9.2 0 0 1 3.5 7.2v2"
          : "M14.8 15v-2a9.2 9.2 0 0 1 18.4 0v2"} strokeWidth="1.6" />
        <path d="M14.8 13v5m18.4-5v5" strokeWidth="3.4" />
      </g>}
      {!voice.microphone ? <path d="M21.5 17.5l5 3m0-3l-5 3" strokeWidth="1.4" /> : null}
    </> : null}
    {collaboration ? <ControlAdornment study={study} /> : null}
  </>;
}

function ControlAdornment({ study }: { study: PawnStudy }) {
  if (study === "mouse-pin") return <g transform="translate(14 30)"><Glyph name="mouse" size={20} /></g>;
  if (study === "cursor-pin") return <path transform="translate(18 31) scale(.6)"
    d="M2 2v21l6-6 5 9 4-2-5-9h9Z" fill="currentColor" stroke="none" />;
  if (study === "desk") return <>
    <path d="M15 35q0 5 4 7m14-7q0 5-1 7" strokeOpacity=".5" />
    <g fill="var(--couch)" strokeWidth="1.2">
      <rect x="12" y="39" width="17" height="9" rx="2" />
      <rect x="31" y="39" width="5" height="9" rx="2.5" />
    </g>
    <path d="M15 42h.01m3 0h.01m3 0h.01m3 0h.01M16 45h9m8.5-5.5v2.5M11 49h26" strokeWidth="1.2" />
  </>;
  return <g transform="translate(0 4)">
    <path d="M15.5 38q1.5 4.5 5 4.5m7 0q3.5 0 5-4.5" strokeOpacity=".55" />
    <rect x="20" y="36" width="8" height="11" rx="4" fill="var(--couch)" strokeWidth="1.4" />
    <path d="M24 36.5v4" strokeWidth="1.2" />
  </g>;
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
      <h3>{en ? "A little sign of co-play" : "参与远控，怎么表达"}</h3>
      <SwitchItem checked={guides} onChange={onGuides} label={en ? "Centre guides" : "中心线对照"} />
    </div>
    <p>{en ? "Keep D3's headphones and mute mark. Choose a control cue to see it on the couch below. Every design represents the same control permission."
      : "保留 D3 的耳机与嘴边静音记号。点选远控标记，下方沙发同步展示；三种都表示参与远控。"}</p>
    <div className="cp-pawn-study-grid">
      {STUDIES.map(study => <section key={study.id} className="cp-pawn-study" data-study={study.id} data-selected={selected === study.id || undefined}>
        <header><Chip title={study.label[language]} selected={selected === study.id} onClick={() => onSelect(study.id)}>{study.label[language]}</Chip></header>
        <p>{study.detail[language]}</p>
        {study.id !== "held-mouse" ? <div className="cp-pawn-study-detail" aria-label={en ? "Enlarged detail" : "放大细节"}>
          {[false, true].map(collaboration => {
            const state: PawnState = { voice: { microphone: false }, collaboration };
            return <figure key={String(collaboration)}><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID}
              {...state} adornment={pawnStudyAdornment(study.id, state)} />
              <figcaption>{en ? collaboration ? "Co-playing" : "Not controlling" : collaboration ? "协作中" : "未参与控制"}</figcaption>
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
