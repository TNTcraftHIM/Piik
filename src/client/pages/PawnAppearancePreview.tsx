import { useState } from "react";
import { PawnSvg, type PawnState } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { SwitchItem } from "../components/living/primitives";
import { prepareIdentityImage } from "../channel/identity-image";
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
  const [voice, setVoice] = useState(true);
  const [microphone, setMicrophone] = useState(true);
  const [deafened, setDeafened] = useState(false);
  const [collaboration, setCollaboration] = useState(true);
  const [host, setHost] = useState(false);
  const [avatar, setAvatar] = useState<string | undefined>("/favicon.svg");
  const [imageError, setImageError] = useState(false);
  async function chooseImage(file: File) {
    setImageError(false);
    try { setAvatar(await prepareIdentityImage(file)); }
    catch { setImageError(true); }
  }
  return <div id="pawn-appearance-preview" className="cp-pawn-preview" data-guides={guides || undefined}>
    <div className="cp-tools">
      <h3>{en ? "Your picture, the same little person" : "自己的头像，熟悉的小人"}</h3>
      <SwitchItem checked={!!avatar} onChange={value => { setImageError(false); setAvatar(value ? "/favicon.svg" : undefined); }}
        label={en ? "Belly picture" : "腹部头像"} />
      <label className="cp-pawn-avatar-file">{en ? "Try a local picture" : "试试本地图片"}
        <input type="file" accept="image/*" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void chooseImage(file);
        }} />
      </label>
    </div>
    {imageError && <p className="cp-input-error" role="alert">{en ? "Couldn't open this image. Try another." : "这张图片无法打开，请换一张。"}</p>}
    <p>{en ? "The colour stays around the picture. The face, headphones and gestures stay the same. This local preview does not save or upload the image."
      : "头像外保留角色色边，头部、耳麦和动作不变。本地预览不会保存或上传图片。"}</p>
    <div className="cp-pawn-avatar-surfaces">
      <section className="cp-pawn-avatar-couch">
        <h4>{en ? "Couch · 42 × 50" : "沙发 · 42 × 50"}</h4>
        <div>{[undefined, { microphone: true }, { microphone: false }, { microphone: false, deafened: true }].map((voice, index) =>
          <figure key={index}><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID} avatar={avatar} voice={voice} />
            <figcaption>{[en ? "Idle" : "空闲", en ? "Listening" : "收听中", en ? "Muted" : "闭麦", en ? "Deafened" : "闭耳机"][index]}</figcaption></figure>)}</div>
      </section>
      <section className="cp-pawn-avatar-sidebar">
        <h4>{en ? "Voice list · 24 × 32" : "语音列表 · 24 × 32"}</h4>
        <div><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID} avatar={avatar} voice={{ microphone: true }} />
          <span>{en ? "Clover" : "小叶"}</span></div>
        <div><PawnSvg color={participantColor("avatar-preview-friend")} identity="avatar-preview-friend" avatar={avatar} voice={{ microphone: false }} collaboration />
          <span>{en ? "Amu" : "阿沐"}</span></div>
      </section>
      <section className="cp-pawn-avatar-chat">
        <h4>{en ? "Conversation · 29 × 36" : "聊天 · 29 × 36"}</h4>
        <div><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID} avatar={avatar} />
          <div><strong>{en ? "Clover" : "小叶"}</strong><p>{en ? "Found a picture for my little person." : "给小人换了一张喜欢的头像。"}</p></div></div>
      </section>
    </div>
    <div className="cp-tools">
      <h3>{en ? "Participant states" : "人物状态"}</h3>
      <SwitchItem checked={guides} onChange={onGuides} label={en ? "Centre guides" : "中心线对照"} />
    </div>
    <p>{en ? "The microphone boom unfolds when unmuted and folds up when muted. The mouse uses the remote-control toolbar symbol."
      : "开麦时伸出麦克风杆，闭麦时折起。鼠标复用播控同款图标。"}</p>
    <div className="cp-pawn-motion">
      <div className="cp-tools">
        <SwitchItem checked={voice} onChange={setVoice} label={en ? "Voice" : "语音"} />
        <SwitchItem checked={microphone} onChange={setMicrophone} label={en ? "Microphone" : "麦克风"} />
        <SwitchItem checked={deafened} onChange={setDeafened} label={en ? "Deafened" : "闭耳机"} />
        <SwitchItem checked={collaboration} onChange={setCollaboration} label={en ? "Collaborating" : "协作中"} />
        <SwitchItem checked={host} onChange={setHost} label={en ? "Host" : "房主"} />
      </div>
      <div className="cp-pawn-motion-figures">
        {[false, true].map(large => <figure key={String(large)} className={large ? "is-large" : undefined}>
          <span className="cp-pawn-figure"><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID}
            avatar={avatar} host={host} voice={voice ? { microphone, deafened } : undefined} collaboration={collaboration} /></span>
          <figcaption>{large ? "2×" : "48px"}</figcaption>
        </figure>)}
      </div>
    </div>
    <div className="cp-pawn-samples">
      {SAMPLES.map(({ label, state }, index) => <figure key={index}>
        <span className="cp-pawn-figure"><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID} avatar={avatar} {...state} /></span>
        <figcaption>{label[en ? 1 : 0].split(en ? ", " : "，").map(part => <span key={part}>{part}</span>)}</figcaption>
      </figure>)}
    </div>
    <h3>{en ? "Headset states" : "耳麦状态对照"}</h3>
    <p>{en ? "Headphones move from the head to the neck when listening is paused. The microphone and control permission stay independent."
      : "正常收听时戴在头上，闭耳机时挂在脖子上。麦克风与远控权限仍独立显示。"}</p>
    <div className="cp-pawn-headphone-comparison">
      {[false, true].flatMap(deafened => [true, false].map(microphone => <figure key={`${deafened}-${microphone}`}>
        <span className="cp-pawn-figure"><PawnSvg color={participantColor(SAMPLE_ID)} identity={SAMPLE_ID}
          avatar={avatar} voice={{ microphone, deafened }} collaboration /></span>
        <figcaption><span>{en ? deafened ? "Deafened" : "Listening" : deafened ? "闭耳机" : "收听中"}</span>
          <span>{en ? microphone ? "Mic on" : "Muted" : microphone ? "开麦" : "闭麦"}</span></figcaption>
      </figure>))}
    </div>
    <a className="cp-pawn-couch-link" href="#pawn-study-couch">{en ? "See the current design on the couch" : "查看下方沙发中的效果"}</a>
  </div>;
}
