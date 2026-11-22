import { useId, type CSSProperties } from "react";
import { Tooltip } from "./Tooltip";
import type { HintKind } from "./hints";
import { useCopy, type CopyKey } from "../../ui/copy";

export function AudioVolumeControl({ volume, onVolume, disabled, label, hint, hintText, max = 2, compact = false }: {
  volume: number; onVolume: (volume: number) => void; disabled?: boolean;
  label: CopyKey; hint?: HintKind; hintText?: CopyKey;
  max?: number;
  compact?: boolean;
}) {
  const { t } = useCopy();
  const id = useId(), percent = Math.round(volume * 100);
  const slider = <input id={id} type="range" min={0} max={max * 100} step={1} value={percent} disabled={disabled}
    style={{ "--range-fill": `${percent / max}%` } as CSSProperties}
    aria-label={t(label)} aria-valuetext={`${percent}%`}
    onChange={event => onVolume(Number(event.target.value) / 100)} />;
  return <>
    {!compact && <label htmlFor={id}>
      <span>{t(label)}</span>
      <span className="lr-volume-value" aria-hidden="true">{percent}%</span>
    </label>}
    {hint ? <Tooltip kind={hint} text={t(hintText ?? label)}>{slider}</Tooltip> : slider}
  </>;
}
