import { useEffect, useId, useRef, useState } from "react";
import { Chip } from "../../components/living/primitives";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { isIdentityImage, prepareIdentityImage } from "../identity-image";
import { ChannelAction } from "./ChannelMedia";
import "./channel-identity.css";

export const CHANNEL_ICON_PRESETS: { icon: GlyphName; name: [string, string] }[] = [
  { icon: "couch", name: ["客厅", "Lounge"] },
  { icon: "gamepad", name: ["游戏", "Games"] },
  { icon: "clapperboard", name: ["电影", "Movies"] },
  { icon: "popcorn", name: ["爆米花", "Popcorn"] },
  { icon: "headphones", name: ["音乐", "Music"] },
  { icon: "book", name: ["阅读", "Reading"] },
  { icon: "heart", name: ["喜欢", "Heart"] },
  { icon: "star", name: ["星星", "Star"] },
];

/** Unknown decorative keys stay in the model; only their presentation falls back. */
export function ChannelIdentityMark({ icon, size = 24 }: { icon: string; size?: number }) {
  const [failed, setFailed] = useState("");
  return <span className="c3-identity-mark" style={{ width: size, height: size }} aria-hidden="true">
    {isIdentityImage(icon) && failed !== icon ? <img src={icon} alt="" onError={() => setFailed(icon)} />
      : <Glyph name={CHANNEL_ICON_PRESETS.find(value => value.icon === icon)?.icon ?? "couch"} size={size} />}
  </span>;
}

export function ChannelIconChoices({ value, onChange, disabled = false }: {
  value: string; onChange(icon: GlyphName): void; disabled?: boolean;
}) {
  const { lang, vis } = useCopy();
  return <div className="c3-identity-options" role="group" aria-label={lang === "zh" ? "图标" : "Icon"}>
    {CHANNEL_ICON_PRESETS.map(preset => {
      const title = preset.name[lang === "zh" ? 0 : 1];
      return <Chip key={preset.icon} title={title} selected={value === preset.icon} disabled={disabled}
        onClick={() => onChange(preset.icon)}><Glyph name={preset.icon} size={21} />{!vis && <span>{title}</span>}</Chip>;
    })}
  </div>;
}

export function ChannelIdentityPicker({ value, onChange, disabled = false, busy, onBusyChange }: {
  value: string; onChange(icon: string): void; disabled?: boolean;
  busy: boolean; onBusyChange(busy: boolean): void;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const chooser = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { request.current++; }, []);
  const select = (icon: string) => {
    request.current++; setFailed(false); onBusyChange(false); onChange(icon);
  };
  async function chooseImage(file: File) {
    const current = ++request.current;
    setFailed(false); onBusyChange(true);
    try {
      const icon = await prepareIdentityImage(file);
      if (request.current === current) onChange(icon);
    } catch {
      if (request.current === current) setFailed(true);
    } finally {
      if (request.current === current) onBusyChange(false);
    }
  }
  const image = isIdentityImage(value);
  return <fieldset className="c3-identity-picker" disabled={disabled}>
    <legend>{zh ? "图标或图片" : "Icon or image"}</legend>
    <ChannelIconChoices value={value} onChange={select} disabled={disabled} />
    <div className="c3-identity-upload">
      {image && <ChannelIdentityMark icon={value} size={36} />}
      <ChannelAction icon="arrowUp" quiet busy={busy} disabled={disabled}
        label={busy ? (zh ? "正在打开图片…" : "Opening image…")
          : image ? (zh ? "更换图片" : "Change image") : (zh ? "选择图片" : "Choose image")}
        onClick={() => chooser.current?.click()} />
      <input ref={chooser} hidden type="file" accept="image/*" onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void chooseImage(file);
      }} />
      {image && <ChannelAction icon="x" quiet disabled={disabled} label={zh ? "移除" : "Remove"} onClick={() => select("couch")} />}
    </div>
    {failed && <p className="c3-identity-error" role="alert">{zh ? "这张图片无法打开，请换一张。" : "Couldn't open this image. Try another."}</p>}
  </fieldset>;
}

export function ChannelIdentityFields({ name, icon, label, disabled, onName, onIcon, imageBusy, onImageBusyChange }: {
  name: string; icon: string; label: string; disabled: boolean;
  onName(name: string): void; onIcon(icon: string): void;
  imageBusy: boolean; onImageBusyChange(busy: boolean): void;
}) {
  const id = useId();
  return <>
    <label className="c3-identity-name" htmlFor={id}><span>{label}</span>
      <input id={id} className="c3-input" required maxLength={64} autoComplete="off" value={name}
        disabled={disabled} onChange={event => onName(event.target.value)} />
    </label>
    <ChannelIdentityPicker value={icon} onChange={onIcon} disabled={disabled} busy={imageBusy} onBusyChange={onImageBusyChange} />
  </>;
}
