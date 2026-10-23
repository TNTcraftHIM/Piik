import { PawnSvg, type PawnState } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Chip, SwitchItem } from "../components/living/primitives";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import "./pawn-appearance-studies.css";

export type PawnStudy = "vest" | "scarf" | "team-pin" | "cursor-pin";
const STUDIES = [
  { id: "vest", label: ["R4：小马甲", "R4: teammate vest"], detail: ["参与操控就穿上小马甲，把身份融进人物衣着。", "A little vest identifies a participant in remote control."] },
  { id: "scarf", label: ["R5：搭档领巾", "R5: teammate scarf"], detail: ["一条领巾作为搭档标记，轮廓简洁，带一点俏皮。", "A simple scarf marks a teammate, with a playful silhouette."] },
  { id: "team-pin", label: ["R6：双人胸章", "R6: team badge"], detail: ["用双人图案表示协作，继续复用已有的符号。", "The existing people symbol becomes a small collaboration badge."] },
  { id: "cursor-pin", label: ["R2：原方案对照", "R2: previous design"], detail: ["上一轮的光标图案，保留作对照。", "The previous cursor emblem, kept for comparison."] },
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
  if (study === "vest") return <>
    <path d="M17 29l7 7 7-7 3 17q-10 4-20 0Z" fill="currentColor" fillOpacity=".15" strokeWidth="1.2" />
    <path d="M24 36v13m-6-7h3m6 0h3" strokeWidth="1.2" />
  </>;
  if (study === "scarf") return <g fill="currentColor" stroke="none">
    <path d="M15 29q9 5 18 0l-7 8-2-2-2 2Z" />
    <path d="M22 35v8l2-2 2 2v-8Z" />
  </g>;
  if (study === "team-pin") return <g transform="translate(15 30)"><Glyph name="users" size={18} /></g>;
  return <path transform="translate(18 31) scale(.6)"
    d="M2 2v21l6-6 5 9 4-2-5-9h9Z" fill="currentColor" stroke="none" />;
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
    <p>{en ? "Keep D3's headphones and mute mark. These accessories identify approved collaborators, regardless of their input device. Choose one to see it on the couch."
      : "保留 D3 的耳机与嘴边静音记号。配饰表示已获准参与操控，不区分输入设备。点选后可在沙发中对照。"}</p>
    <div className="cp-pawn-study-grid">
      {STUDIES.map(study => <section key={study.id} className="cp-pawn-study" data-study={study.id} data-selected={selected === study.id || undefined}>
        <header><Chip title={study.label[language]} selected={selected === study.id} onClick={() => onSelect(study.id)}>{study.label[language]}</Chip></header>
        <p>{study.detail[language]}</p>
        {study.id !== "cursor-pin" ? <div className="cp-pawn-study-detail" aria-label={en ? "Enlarged detail" : "放大细节"}>
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
