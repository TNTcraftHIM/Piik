import { Fragment, useRef, type ReactNode } from "react";
import { MIN_AUDIO_BITRATE } from "../../../shared/protocol";
import {
  QUALITY_PROFILES, QUALITY_PROFILE_KEYS, QUALITY_RESOLUTIONS, qualityResolutionEqual,
  captureFramerateCeiling, supportsCaptureProfile, MIN_VIDEO_FRAMERATE, MIN_VIDEO_BITRATE,
  VIDEO_CAPTURE_LIMITS, type VideoCaptureLimits, type QualityProfile, type QualityProfileId, type QualityResolution,
  SCREEN_AUDIO_BITRATES, type ScreenAudioPreset,
} from "../../media/quality";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Cap, Chip } from "./primitives";
import { QualityTileGlyph } from "./QualityTileGlyph";
import { Tooltip } from "./Tooltip";

export function QualityPresets({ selected, limits = VIDEO_CAPTURE_LIMITS, disabled = false, busy = false, onSelect }: {
  selected: QualityProfileId | null;
  limits?: VideoCaptureLimits;
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
          aria-pressed={selected === id} aria-label={caption}
          disabled={disabled || !supportsCaptureProfile(profile, limits)} onClick={() => onSelect(id)}>
          <QualityTileGlyph resolution={`${profile.resolution.height}p`} framerate={profile.maxFramerate} />
          <small>{vis ? `${profile.resolution.height}·${profile.maxFramerate}` : caption}</small>
        </button>
      </Tooltip>;
    })}
  </div>;
}

export function ResolutionControl({ value, limits, disabled, onChange }: {
  value: QualityResolution;
  limits: VideoCaptureLimits;
  disabled: boolean;
  onChange: (resolution: QualityResolution) => void;
}) {
  const { t, vis } = useCopy();
  const controls = useRef<HTMLDivElement>(null);
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
    if (captureFramerateCeiling(next, limits) < MIN_VIDEO_FRAMERATE) {
      reset(container);
      return;
    }
    if (!qualityResolutionEqual(value, next)) onChange(next);
  };
  return <div className="lr-resolution-controls" ref={controls}
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
        disabled={disabled || captureFramerateCeiling(resolution, limits) < MIN_VIDEO_FRAMERATE}
        title={label} hint="hint-quality" onClick={() => {
          // Selecting even the current preset replaces an unsubmitted draft.
          reset(controls.current!);
          onChange(resolution);
        }}>{label}</Chip>)}
    </div>
    <Tooltip kind="hint-quality" text={vis ? undefined : t("host.video.resolutionHint", {
      width: String(limits.maxVideoResolution.width), height: String(limits.maxVideoResolution.height),
      pixels: limits.maxVideoPixels.toLocaleString("en-US"),
    })}>
      <span className="lr-input lr-video-size" key={`${value.width}x${value.height}`}
        role="group" aria-label={t("host.advanced.resolution")}>
        {axes.map((axis, index) => <Fragment key={axis}>
          {index === 1 ? <span aria-hidden="true">×</span> : null}
          <input type="number" inputMode="numeric" name={axis} defaultValue={value[axis]}
            min={4} max={limits.maxVideoResolution[axis]} step={2} disabled={disabled}
            aria-label={t(axis === "width" ? "host.video.width" : "host.video.height")} />
        </Fragment>)}
        <span aria-hidden="true">px</span>
      </span>
    </Tooltip>
  </div>;
}

const AUDIO_QUALITY_CAPTIONS: Record<ScreenAudioPreset, CopyKey> = {
  saver: "host.advanced.audio.saver",
  music: "host.advanced.audio.music",
  "very-high": "host.advanced.audio.veryHigh",
};

function QualityNumberControl({ value, min, max, step, unit, name, label, disabled, onChange, className, children }: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  name: string;
  label: string;
  disabled: boolean;
  onChange: (value: number) => void;
  className: string;
  children: (input: ReactNode, select: (value: number) => void) => ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const reset = () => { input.current!.value = String(value); };
  const select = (next: number) => {
    // A preset or slider replaces the draft, including a choice of the current value.
    reset();
    if (next !== value) onChange(next);
  };
  const number = <label className="lr-input lr-quality-number">
    <input ref={input} type="number" inputMode={step < 1 ? "decimal" : "numeric"} name={name} key={value}
      defaultValue={value} min={min} max={max} step={step} disabled={disabled} aria-label={label}
      onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") reset();
        event.currentTarget.blur();
      }} />
    <span>{unit}</span>
  </label>;
  return <div className={className} onBlur={event => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    const field = input.current!;
    if (!field.validity.valid || !Number.isFinite(field.valueAsNumber)) reset();
    else if (field.valueAsNumber !== value) onChange(field.valueAsNumber);
  }}>{children(number, select)}</div>;
}

export function VideoRateControls({ value, limits, disabled, onChange }: {
  value: QualityProfile;
  limits: VideoCaptureLimits;
  disabled: boolean;
  onChange: (value: Partial<Pick<QualityProfile, "maxFramerate" | "maxBitrate">>) => void;
}) {
  const { t, vis } = useCopy();
  const fpsMax = captureFramerateCeiling(value.resolution, limits);
  const controls = [
    { name: "maxFramerate", label: "host.advanced.framerate", icon: "frames", hint: "hint-metric-fps",
      value: value.maxFramerate, min: MIN_VIDEO_FRAMERATE, max: fpsMax, step: 1, unit: "fps",
      change: (maxFramerate: number) => onChange({ maxFramerate }) },
    { name: "maxBitrate", label: "host.advanced.bitrate", icon: "gauge", hint: "hint-metric-bitrate",
      value: value.maxBitrate / 1_000_000, min: MIN_VIDEO_BITRATE / 1_000_000,
      max: limits.maxVideoBitrate / 1_000_000, step: 0.1, unit: "Mbps",
      change: (mbps: number) => onChange({ maxBitrate: Math.round(mbps * 1_000_000) }) },
  ] as const;
  return <div className="lr-sharing-limits">
    {controls.map(control => <div className="lr-door-group" key={control.name}>
      <span className="lr-door-glyph"><Glyph name={control.icon} size={19} /><Cap k={control.label} /></span>
      <Tooltip kind={control.hint} text={vis ? undefined : t(control.label)} className="lr-slider-hint">
        <QualityNumberControl {...control} className="lr-quality-rate" label={t(control.label)}
          disabled={disabled || control.max < control.min} onChange={control.change}>
          {(input, select) => <>
            <input type="range" min={control.min} max={Math.max(control.min, control.max)} step={control.step}
              value={control.value} disabled={disabled || control.max < control.min} aria-label={t(control.label)}
              onChange={event => select(event.currentTarget.valueAsNumber)}
              onClick={event => select(event.currentTarget.valueAsNumber)} />
            {input}
          </>}
        </QualityNumberControl>
      </Tooltip>
    </div>)}
  </div>;
}

export function AudioBitrateControl({ value, max, disabled, onChange }: {
  value: number;
  max: number;
  disabled: boolean;
  onChange: (bitrate: number) => void;
}) {
  const { t, vis } = useCopy();
  return <div className="lr-door-group">
    <span className="lr-door-glyph"><Glyph name="speaker" size={19} /><Cap k="host.advanced.audio" /></span>
    <QualityNumberControl value={value / 1_000} min={MIN_AUDIO_BITRATE / 1_000} max={max / 1_000} step={1}
      name="audioBitrate" unit="kbps" label={t("host.advanced.audioBitrate")} className="lr-door-group"
      disabled={disabled} onChange={kbps => onChange(kbps * 1_000)}>
      {(input, select) => <>
        <div className="lr-row-group" role="group" aria-label={t("host.advanced.audio")}>
          {(Object.keys(SCREEN_AUDIO_BITRATES) as ScreenAudioPreset[]).map(preset => {
            const bitrate = SCREEN_AUDIO_BITRATES[preset];
            return <Chip key={preset} selected={value === bitrate} disabled={disabled || bitrate > max}
              title={t("host.audio.title", { label: t(AUDIO_QUALITY_CAPTIONS[preset]), kbps: String(bitrate / 1_000) })}
              hint="hint-audio-quality" onClick={() => select(bitrate / 1_000)}>
              <Cap k={AUDIO_QUALITY_CAPTIONS[preset]} /><small className="lr-audio-rate">{bitrate / 1_000}</small>
            </Chip>;
          })}
        </div>
        <Tooltip kind="hint-audio-quality" text={vis ? undefined : t("host.audio.bitrateHint", {
          min: String(MIN_AUDIO_BITRATE / 1_000), max: String(max / 1_000),
        })}>{input}</Tooltip>
      </>}
    </QualityNumberControl>
  </div>;
}
