import { useId } from "react";
import { Chip } from "../../components/living/primitives";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
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
  return <Glyph name={CHANNEL_ICON_PRESETS.find(value => value.icon === icon)?.icon ?? "couch"} size={size} />;
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

export function ChannelIdentityFields({ name, icon, label, disabled, onName, onIcon }: {
  name: string; icon: string; label: string; disabled: boolean;
  onName(name: string): void; onIcon(icon: string): void;
}) {
  const id = useId();
  const { lang } = useCopy();
  return <>
    <label className="c3-identity-name" htmlFor={id}><span>{label}</span>
      <input id={id} className="c3-input" required maxLength={64} autoComplete="off" value={name}
        disabled={disabled} onChange={event => onName(event.target.value)} />
    </label>
    <fieldset className="c3-identity-picker" disabled={disabled}>
      <legend>{lang === "zh" ? "图标" : "Icon"}</legend>
      <ChannelIconChoices value={icon} onChange={onIcon} disabled={disabled} />
    </fieldset>
  </>;
}
