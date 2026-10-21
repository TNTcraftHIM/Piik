import { useId, type CSSProperties } from "react";
import { Tooltip } from "./Tooltip";
import type { HintKind } from "./hints";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";

export function AudioVolumeControl({ volume, onVolume, disabled, label, icon, hint, hintText }: {
  volume: number; onVolume: (volume: number) => void; disabled?: boolean;
  label: CopyKey; icon: GlyphName; hint?: HintKind; hintText?: CopyKey;
}) {
  const { t, vis } = useCopy();
  const id = useId(), percent = Math.round(volume * 100);
  const slider = <input id={id} type="range" min={0} max={200} step={1} value={percent} disabled={disabled}
    style={{ "--range-fill": `${percent / 2}%` } as CSSProperties}
    aria-label={t(label)} aria-valuetext={`${percent}%`}
    onChange={event => onVolume(Number(event.target.value) / 100)} />;
  return <>
    <label htmlFor={id}>
      <span>{vis ? <Glyph name={icon} size={18} /> : t(label)}</span>
      <output htmlFor={id}>{percent}%</output>
    </label>
    {hint ? <Tooltip kind={hint} text={vis ? undefined : t(hintText ?? label)}>{slider}</Tooltip> : slider}
  </>;
}
