import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Chip } from "../../components/living/primitives";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { isIdentityImage, prepareIdentityImage } from "../identity-image";
import { ChannelAction } from "./ChannelAction";
import "./channel-identity.css";

export const CHANNEL_ICON_PRESETS: { icon: GlyphName; name: CopyKey }[] = [
  { icon: "couch", name: "channel.identity.lounge" },
  { icon: "gamepad", name: "channel.identity.games" },
  { icon: "clapperboard", name: "channel.identity.movies" },
  { icon: "popcorn", name: "channel.identity.popcorn" },
  { icon: "headphones", name: "channel.identity.music" },
  { icon: "book", name: "channel.identity.reading" },
  { icon: "heart", name: "channel.identity.heart" },
  { icon: "star", name: "channel.identity.star" },
];

/** Unknown decorative keys stay in the model; only their presentation falls back. */
export function ChannelIdentityMark({ icon, picture, size = 24 }: { icon: string; picture?: string | null; size?: number }) {
  const [failed, setFailed] = useState("");
  const image = picture ?? icon;
  return <span className="c3-identity-mark" style={{ width: size, height: size }} aria-hidden="true">
    {isIdentityImage(image) && failed !== image ? <img src={image} alt="" onError={() => setFailed(image)} />
      : <Glyph name={CHANNEL_ICON_PRESETS.find(value => value.icon === icon)?.icon ?? "couch"} size={size} />}
  </span>;
}

export function ChannelIconChoices({ value, onChange, disabled = false }: {
  value: string; onChange(icon: GlyphName): void; disabled?: boolean;
}) {
  const { t } = useCopy();
  return <div className="c3-identity-options" role="group" aria-label={t("channel.identity.icon")}>
    {CHANNEL_ICON_PRESETS.map(preset => {
      const title = t(preset.name);
      return <Chip key={preset.icon} title={title} selected={value === preset.icon} disabled={disabled}
        onClick={() => onChange(preset.icon)}><Glyph name={preset.icon} size={21} /><span>{title}</span></Chip>;
    })}
  </div>;
}

/** A file changes only the owning form's draft; that form owns Save and Cancel. */
export function ChannelIdentityImageInput({ value, onChange, disabled = false, busy, onBusyChange, presets = false, fallbackPreview }: {
  value: string | null; onChange(image: string | null): void; disabled?: boolean;
  busy: boolean; onBusyChange(busy: boolean): void; presets?: boolean; fallbackPreview?: ReactNode;
}) {
  const { t } = useCopy();
  const chooser = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [failed, setFailed] = useState(false);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  useEffect(() => () => { request.current++; }, []);
  const select = (icon: string | null) => {
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
  const image = value && isIdentityImage(value) ? value : null;
  return <>
    {presets && <ChannelIconChoices value={value ?? "couch"} onChange={select} disabled={disabled} />}
    <div className="c3-identity-upload">
      {image && image !== failedImage ? <img className="c3-identity-image-preview" src={image} alt=""
        onError={() => setFailedImage(image)} /> : fallbackPreview}
      <div className="c3-identity-upload-actions">
        <ChannelAction icon="arrowUp" quiet busy={busy} disabled={disabled}
          label={busy ? t("channel.identity.openingImage")
            : image ? t("channel.identity.changeImage") : t("channel.identity.chooseImage")}
          onClick={() => chooser.current?.click()} />
        <input ref={chooser} hidden type="file" accept="image/*" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void chooseImage(file);
        }} />
        {image && <ChannelAction icon="x" quiet disabled={disabled} label={t("channel.identity.remove")} onClick={() => select(presets ? "couch" : null)} />}
      </div>
    </div>
    {(failed || (value && value === failedImage)) && <p className="c3-identity-error" role="alert">{t("channel.identity.imageOpenFailed")}</p>}
  </>;
}

export function ChannelIdentityPicker({ value, onChange, disabled = false, busy, onBusyChange }: {
  value: string; onChange(icon: string): void; disabled?: boolean;
  busy: boolean; onBusyChange(busy: boolean): void;
}) {
  const { t } = useCopy();
  return <fieldset className="c3-identity-picker" disabled={disabled}>
    <legend>{t("channel.identity.iconOrImage")}</legend>
    <ChannelIdentityImageInput value={value} presets
      onChange={image => onChange(image ?? "couch")} disabled={disabled} busy={busy} onBusyChange={onBusyChange} />
  </fieldset>;
}

export function ChannelIdentityFields({ name, icon, label, disabled, onName, onIcon, imageBusy, onImageBusyChange, roomPicture }: {
  name: string; icon: string; label: string; disabled: boolean;
  onName(name: string): void; onIcon(icon: string): void;
  imageBusy: boolean; onImageBusyChange(busy: boolean): void;
  roomPicture?: { value: string | null; onChange(picture: string | null): void };
}) {
  const id = useId();
  const { t } = useCopy();
  return <>
    <label className="c3-identity-name" htmlFor={id}><span>{label}</span>
      <input id={id} className="c3-input" required maxLength={64} autoComplete="off" value={name}
        disabled={disabled} onChange={event => onName(event.target.value)} />
    </label>
    <details className="c3-identity-appearance">
      <summary><ChannelIdentityMark icon={icon} picture={roomPicture?.value} size={24} /><span>{t(roomPicture ? "room.settings.appearance" : "channel.identity.changeIconOrImage")}</span></summary>
      {roomPicture ? <fieldset className="c3-identity-picker" disabled={disabled}>
        <legend>{t("room.settings.publicIcon")}</legend>
        <ChannelIconChoices value={icon} onChange={onIcon} disabled={disabled} />
        <p className="c3-room-picture-label">{t("room.settings.picture")}</p>
        <ChannelIdentityImageInput value={roomPicture.value} onChange={roomPicture.onChange}
          disabled={disabled} busy={imageBusy} onBusyChange={onImageBusyChange} />
      </fieldset> : <ChannelIdentityPicker value={icon} onChange={onIcon} disabled={disabled} busy={imageBusy} onBusyChange={onImageBusyChange} />}
    </details>
  </>;
}
