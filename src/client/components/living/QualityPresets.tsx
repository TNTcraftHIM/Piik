import { Fragment } from "react";
import {
  QUALITY_PROFILES, QUALITY_PROFILE_KEYS, QUALITY_RESOLUTIONS, qualityResolutionEqual,
  type QualityProfileId, type QualityResolution,
} from "../../media/quality";
import { useCopy } from "../../ui/copy";
import { Chip } from "./primitives";
import { QualityTileGlyph } from "./QualityTileGlyph";
import { Tooltip } from "./Tooltip";

export function QualityPresets({ selected, disabled = false, busy = false, onSelect }: {
  selected: QualityProfileId | null;
  disabled?: boolean;
  busy?: boolean;
  onSelect: (id: QualityProfileId) => void;
}) {
  const { t, vis } = useCopy();
  return <div className="lr-tiles" aria-busy={busy}>
    {(Object.keys(QUALITY_PROFILES) as QualityProfileId[]).map((id, index) => {
      const profile = QUALITY_PROFILES[id];
      const caption = t(QUALITY_PROFILE_KEYS[id]);
      return <Tooltip key={id} kind="hint-quality" align={index === 0 ? "start" : "center"}
        text={vis ? undefined : t("host.quality.title", { label: caption, mbps: (profile.maxBitrate / 1_000_000).toFixed(0) })}>
        <button type="button" className={`lr-tile${selected === id ? " is-selected" : ""}`}
          aria-pressed={selected === id} aria-label={caption} disabled={disabled} onClick={() => onSelect(id)}>
          <QualityTileGlyph resolution={`${profile.resolution.height}p`} framerate={profile.maxFramerate} />
          <small>{vis ? `${profile.resolution.height}·${profile.maxFramerate}` : caption}</small>
        </button>
      </Tooltip>;
    })}
  </div>;
}

export function ResolutionControl({ value, maximum, disabled, onChange }: {
  value: QualityResolution;
  maximum: QualityResolution;
  disabled: boolean;
  onChange: (resolution: QualityResolution) => void;
}) {
  const { t, vis } = useCopy();
  const axes = ["width", "height"] as const;
  const reset = (container: HTMLElement) => {
    for (const axis of axes) container.querySelector<HTMLInputElement>(`input[name="${axis}"]`)!.value = String(value[axis]);
  };
  const apply = (container: HTMLElement) => {
    const width = container.querySelector<HTMLInputElement>('input[name="width"]')!;
    const height = container.querySelector<HTMLInputElement>('input[name="height"]')!;
    if (![width, height].every(input => input.validity.valid && Number.isFinite(input.valueAsNumber))) {
      reset(container);
      return;
    }
    const next = { width: width.valueAsNumber, height: height.valueAsNumber };
    if (!qualityResolutionEqual(value, next)) onChange(next);
  };
  return <div className="lr-resolution-controls"
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) apply(event.currentTarget);
    }}
    onKeyDown={event => {
      if (!(event.target instanceof HTMLInputElement) || (event.key !== "Enter" && event.key !== "Escape")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") reset(event.currentTarget);
      event.target.blur();
    }}>
    <div className="lr-row-group" role="group" aria-label={t("host.advanced.resolution")}>
      {Object.entries(QUALITY_RESOLUTIONS).map(([label, resolution]) => <Chip key={label}
        selected={qualityResolutionEqual(value, resolution)}
        disabled={disabled || resolution.width > maximum.width || resolution.height > maximum.height}
        title={label} hint="hint-quality" onClick={() => onChange(resolution)}>{label}</Chip>)}
    </div>
    <Tooltip kind="hint-quality" text={vis ? undefined : t("host.video.resolutionHint", {
      width: String(maximum.width), height: String(maximum.height),
    })}>
      <span className="lr-input lr-video-size" key={`${value.width}x${value.height}`}
        role="group" aria-label={t("host.advanced.resolution")}>
        {axes.map((axis, index) => <Fragment key={axis}>
          {index === 1 ? <span aria-hidden="true">×</span> : null}
          <input type="number" inputMode="numeric" name={axis} defaultValue={value[axis]}
            min={4} max={maximum[axis]} step={2} disabled={disabled}
            aria-label={t(axis === "width" ? "host.video.width" : "host.video.height")} />
        </Fragment>)}
        <span aria-hidden="true">px</span>
      </span>
    </Tooltip>
  </div>;
}
