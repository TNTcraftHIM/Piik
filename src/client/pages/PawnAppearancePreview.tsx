import { PawnSvg, type PawnState } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { SwitchItem } from "../components/living/primitives";
import { useCopy } from "../ui/copy";
import "./pawn-appearance-preview.css";

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

export function PawnAppearancePreview({ guides, onGuides }: {
  guides: boolean; onGuides: (value: boolean) => void;
}) {
  const { lang } = useCopy();
  const en = lang === "en";
  return <div id="pawn-appearance-preview" className="cp-pawn-preview" data-guides={guides || undefined}>
    <div className="cp-tools">
      <h3>{en ? "Participant states" : "人物状态"}</h3>
      <SwitchItem checked={guides} onChange={onGuides} label={en ? "Centre guides" : "中心线对照"} />
    </div>
    <p>{en ? "D3 headphones and mute mark, with the same mouse symbol as the remote-control toolbar."
      : "D3 耳机与嘴边静音记号，搭配播控同款鼠标标志。"}</p>
    <div className="cp-pawn-samples">
      {SAMPLES.map(({ label, state }, index) => <figure key={index}>
        <span className="cp-pawn-figure"><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID} {...state} /></span>
        <figcaption>{label[en ? 1 : 0].split(en ? ", " : "，").map(part => <span key={part}>{part}</span>)}</figcaption>
      </figure>)}
    </div>
    <h3>{en ? "Listening and deafened" : "收听与闭耳机"}</h3>
    <p>{en ? "Headphones move from the head to the neck when listening is paused. The microphone and control permission stay independent."
      : "正常收听时戴在头上，闭耳机时挂在脖子上。麦克风与远控权限仍独立显示。"}</p>
    <div className="cp-pawn-headphone-comparison">
      {[false, true].map(deafened => <figure key={String(deafened)}>
        <span className="cp-pawn-figure"><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID}
          voice={{ microphone: false, deafened }} collaboration /></span>
        <figcaption>{en ? deafened ? "Deafened" : "Listening" : deafened ? "闭耳机：挂在脖子上" : "收听中：戴在头上"}</figcaption>
      </figure>)}
    </div>
    <a className="cp-pawn-couch-link" href="#pawn-study-couch">{en ? "See the current design on the couch" : "查看下方沙发中的效果"}</a>
  </div>;
}
