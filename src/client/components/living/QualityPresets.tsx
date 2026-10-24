import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MIN_AUDIO_BITRATE } from "../../../shared/protocol";
import {
  QUALITY_PROFILES, QUALITY_PROFILE_KEYS, QUALITY_RESOLUTIONS, DEGRADATION_PREFERENCE_KEYS, qualityResolutionEqual,
  captureFramerateCeiling, supportsCaptureProfile, MIN_VIDEO_FRAMERATE, MIN_VIDEO_BITRATE,
  VIDEO_CAPTURE_LIMITS, type VideoCaptureLimits, type QualityProfile, type QualityProfileId, type QualityResolution,
  SCREEN_AUDIO_BITRATES, type ScreenAudioPreset, type DegradationPreference,
} from "../../media/quality";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Cap, Chip } from "./primitives";
import { QualityTileGlyph } from "./QualityTileGlyph";
import { Tooltip } from "./Tooltip";

const PRESET_LABELS: Record<QualityProfileId, CopyKey> = {
  "720p30": "host.quality.light",
  "1080p30": "host.quality.hd",
  "1080p60": "host.quality.highFps",
};

const RESOLUTION_HINTS: Partial<Record<keyof typeof QUALITY_RESOLUTIONS, CopyKey>> = {
  "1440p": "host.video.resolution1440p",
  "2160p": "host.video.resolution2160p",
};

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
          aria-pressed={selected === id} aria-label={`${t(PRESET_LABELS[id])} · ${caption}`}
          disabled={disabled || !supportsCaptureProfile(profile, limits)} onClick={() => onSelect(id)}>
          <QualityTileGlyph resolution={`${profile.resolution.height}p`} framerate={profile.maxFramerate} />
          {vis ? null : <strong>{t(PRESET_LABELS[id])}</strong>}
          <small>{vis ? `${profile.resolution.height} ${profile.maxFramerate}` : caption}</small>
        </button>
      </Tooltip>;
    })}
  </div>;
}

export function PictureSettingsSummary({ value }: { value: QualityProfile }) {
  const { t } = useCopy();
  return <span className="lr-sharing-picture-summary" aria-label={t("host.settings.pictureLimits")}>
    <span>{value.resolution.width} × {value.resolution.height}</span>
    <span>{value.maxFramerate} fps</span>
    <span>{value.maxBitrate / 1_000_000} Mbps</span>
  </span>;
}

export function ResolutionControl({ value, limits, disabled, onChange }: {
  value: QualityResolution;
  limits: VideoCaptureLimits;
  disabled: boolean;
  onChange: (resolution: QualityResolution) => void;
}) {
  const { t, vis } = useCopy();
  const controls = useRef<HTMLDivElement>(null);
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  useEffect(() => setInvalid(false), [value.width, value.height]);
  const axes = ["width", "height"] as const;
  const reset = (container: HTMLElement) => {
    setInvalid(false);
    for (const axis of axes) container.querySelector<HTMLInputElement>(`input[name="${axis}"]`)!.value = String(value[axis]);
  };
  const apply = (container: HTMLElement) => {
    const width = container.querySelector<HTMLInputElement>('input[name="width"]')!;
    const height = container.querySelector<HTMLInputElement>('input[name="height"]')!;
    if (![width, height].every(input => input.validity.valid && Number.isFinite(input.valueAsNumber))) {
      setInvalid(true);
      return;
    }
    const next = { width: width.valueAsNumber, height: height.valueAsNumber };
    if (captureFramerateCeiling(next, limits) < MIN_VIDEO_FRAMERATE) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (!qualityResolutionEqual(value, next)) onChange(next);
  };
  return <div className="lr-resolution-controls" ref={controls}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) apply(event.currentTarget);
    }}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing ||
          !(event.target instanceof HTMLInputElement) || (event.key !== "Enter" && event.key !== "Escape")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") reset(event.currentTarget);
      event.target.blur();
    }}>
    <div className="lr-quality-heading">
      <span className="lr-door-glyph"><Glyph name="expand" size={19} /><Cap k="host.advanced.resolution" /></span>
      <Tooltip kind="hint-quality" text={vis ? undefined : t("host.video.resolutionHint", {
        width: String(limits.maxVideoResolution.width), height: String(limits.maxVideoResolution.height),
        pixels: limits.maxVideoPixels.toLocaleString("en-US"),
      })}>
        <span className="lr-input lr-video-size" key={`${value.width}x${value.height}`}
          role="group" aria-label={t("host.advanced.resolution")}>
          {axes.map((axis, index) => <Fragment key={axis}>
            {index === 1 ? <span aria-hidden="true">×</span> : null}
            <input type="number" inputMode="numeric" name={axis} defaultValue={value[axis]} required
              min={4} max={limits.maxVideoResolution[axis]} step={2} disabled={disabled}
              aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}
              onInput={() => setInvalid(false)}
              aria-label={t(axis === "width" ? "host.video.width" : "host.video.height")} />
          </Fragment>)}
          <span aria-hidden="true">px</span>
        </span>
      </Tooltip>
    </div>
    {invalid && <small id={errorId} className="lr-quality-validation" role="alert">{t("host.video.resolutionInvalid", {
      width: String(limits.maxVideoResolution.width), height: String(limits.maxVideoResolution.height),
      pixels: limits.maxVideoPixels.toLocaleString("en-US"),
    })}</small>}
    <div className="lr-row-group" role="group" aria-label={t("host.advanced.resolution")}>
      {Object.entries(QUALITY_RESOLUTIONS).map(([label, resolution]) => <Chip key={label}
        selected={qualityResolutionEqual(value, resolution)}
        disabled={disabled || captureFramerateCeiling(resolution, limits) < MIN_VIDEO_FRAMERATE}
        title={label} hint="hint-quality"
        hintText={t(RESOLUTION_HINTS[label as keyof typeof QUALITY_RESOLUTIONS] ?? "host.video.resolutionPreset", {
          width: String(resolution.width), height: String(resolution.height),
        })} onClick={() => {
          // Selecting even the current preset replaces an unsubmitted draft.
          reset(controls.current!);
          onChange(resolution);
        }}>{label}</Chip>)}
    </div>
  </div>;
}

const AUDIO_QUALITY_CAPTIONS: Record<ScreenAudioPreset, CopyKey> = {
  saver: "host.advanced.audio.saver",
  music: "host.advanced.audio.music",
  "very-high": "host.advanced.audio.veryHigh",
};
const VOICE_QUALITY_CAPTIONS: Record<ScreenAudioPreset, CopyKey> = {
  saver: "voice.quality.saver", music: "voice.quality.standard", "very-high": "voice.quality.clear",
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
  const { t } = useCopy();
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setInvalid(false), [value, min, max, step]);
  const reset = () => { input.current!.value = String(value); setInvalid(false); };
  const select = (next: number) => {
    // A preset or slider replaces the draft, including a choice of the current value.
    reset();
    if (next !== value) onChange(next);
  };
  const number = <label className="lr-input lr-quality-number">
    <input ref={input} type="number" inputMode={step < 1 ? "decimal" : "numeric"} name={name} key={value}
      defaultValue={value} min={min} max={max} step={step} disabled={disabled} required aria-label={label}
      aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}
      onInput={() => setInvalid(false)}
      onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing ||
            (event.key !== "Enter" && event.key !== "Escape")) return;
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
    const valid = field.validity.valid && Number.isFinite(field.valueAsNumber);
    setInvalid(!valid);
    if (valid && field.valueAsNumber !== value) onChange(field.valueAsNumber);
  }}>{children(number, select)}
    {invalid && <small id={errorId} className="lr-quality-validation" role="alert">{t("host.quality.invalidNumber", {
      min: String(min), max: String(max), step: String(step), unit,
    })}</small>}
  </div>;
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
      sliderMin: 15, sliderMax: 60, sliderStep: 5,
      change: (maxFramerate: number) => onChange({ maxFramerate }) },
    { name: "maxBitrate", label: "host.advanced.bitrate", icon: "gauge", hint: "hint-metric-bitrate",
      value: value.maxBitrate / 1_000_000, min: MIN_VIDEO_BITRATE / 1_000_000,
      max: limits.maxVideoBitrate / 1_000_000, step: 0.1, unit: "Mbps",
      sliderMin: 2, sliderMax: 12, sliderStep: 0.5,
      change: (mbps: number) => onChange({ maxBitrate: Math.round(mbps * 1_000_000) }) },
  ] as const;
  return <div className="lr-sharing-limits">
    {controls.map(control => {
      // Keep the slider on its own steps; typed values must never be rounded by the DOM.
      const sliderMax = Math.min(control.sliderMax, Math.floor(control.max / control.sliderStep) * control.sliderStep);
      const hasCommonRange = sliderMax >= control.sliderMin;
      const commonValue = Math.min(sliderMax, Math.max(control.sliderMin,
        Math.round(control.value / control.sliderStep) * control.sliderStep));
      const custom = !hasCommonRange || control.value !== commonValue;
      return <QualityNumberControl key={control.name} {...control}
        className="lr-quality-rate" label={t(control.label)}
        disabled={disabled || control.max < control.min} onChange={control.change}>
        {(input, select) => <>
          <div className="lr-quality-heading">
            <span className="lr-door-glyph"><Glyph name={control.icon} size={19} /><Cap k={control.label} /></span>
            <Tooltip kind={control.hint} text={vis ? undefined : t("host.video.inputHint", {
              min: String(control.min), max: String(control.max), unit: control.unit,
            })}>
              {input}
            </Tooltip>
          </div>
          {custom ? <div className="lr-quality-custom">
            <span className="lr-quality-custom-label">
              <Glyph name="pencil" size={16} />
              <span className={vis ? "visually-hidden" : "lr-cap"}>{t("host.video.custom")}</span>
            </span>
            {hasCommonRange ? <Tooltip kind={control.hint} text={vis ? undefined : t("host.video.returnCommonHint", {
              value: String(commonValue), unit: control.unit,
            })}>
              <button type="button" className="lr-btn is-dense" disabled={disabled}
                aria-label={`${t(control.label)}\n${t("host.video.returnCommonHint", { value: String(commonValue), unit: control.unit })}`}
                onClick={event => {
                  const group = event.currentTarget.closest(".lr-quality-rate");
                  select(commonValue);
                  // The return button disappears; keep keyboard focus in this field.
                  if (event.detail === 0) requestAnimationFrame(() => group?.querySelector<HTMLInputElement>('input[type="number"]')?.focus());
                }}>
                <Glyph name="sliders" size={17} /><Cap k="host.video.returnCommon" />
              </button>
            </Tooltip> : null}
          </div> : <>
            <input type="range" min={control.sliderMin} max={sliderMax} step={control.sliderStep}
              value={control.value} disabled={disabled}
              style={{ "--range-fill": `${100 * (control.value - control.sliderMin) / (sliderMax - control.sliderMin || 1)}%` } as CSSProperties}
              aria-label={`${t(control.label)}\n${t("host.video.commonRange")}`}
              onChange={event => select(event.currentTarget.valueAsNumber)}
              onClick={event => select(event.currentTarget.valueAsNumber)} />
            <div className="lr-quality-range-labels" aria-hidden="true">
              <span>{control.sliderMin}</span>
              <span>{sliderMax} {control.unit}</span>
            </div>
          </>}
        </>}
      </QualityNumberControl>;
    })}
  </div>;
}

export function AudioBitrateControl({ value, max, disabled, onChange, purpose = "screen" }: {
  value: number;
  max: number;
  disabled: boolean;
  onChange: (bitrate: number) => void;
  purpose?: "screen" | "voice";
}) {
  const { t, vis } = useCopy();
  const title = purpose === "voice" ? "voice.bitrate" : "host.advanced.audio";
  const presets = purpose === "voice" ? { saver: 32_000, music: 64_000, "very-high": 96_000 } : SCREEN_AUDIO_BITRATES;
  const captions = purpose === "voice" ? VOICE_QUALITY_CAPTIONS : AUDIO_QUALITY_CAPTIONS;
  return <QualityNumberControl value={value / 1_000} min={MIN_AUDIO_BITRATE / 1_000} max={max / 1_000} step={1}
    name="audioBitrate" unit="kbps" label={t(purpose === "voice" ? "voice.bitrate" : "host.advanced.audioBitrate")} className="lr-door-group lr-audio-quality"
    disabled={disabled} onChange={kbps => onChange(kbps * 1_000)}>
    {(input, select) => <>
      <div className="lr-quality-heading">
        <span className="lr-door-glyph"><Glyph name={purpose === "voice" ? "microphone" : "speaker"} size={19} /><Cap k={title} /></span>
        <Tooltip kind="hint-audio-quality" text={vis ? undefined : t(purpose === "voice" ? "voice.bitrateHint" : "host.audio.bitrateHint", {
          min: String(MIN_AUDIO_BITRATE / 1_000), max: String(max / 1_000),
        })}>{input}</Tooltip>
      </div>
      <div className="lr-row-group" role="group" aria-label={t(title)}>
        {(Object.keys(SCREEN_AUDIO_BITRATES) as ScreenAudioPreset[]).map(preset => {
          const bitrate = presets[preset];
          return <Chip key={preset} selected={value === bitrate} disabled={disabled || bitrate > max}
            title={t("host.audio.title", { label: t(captions[preset]), kbps: String(bitrate / 1_000) })}
            hint="hint-audio-quality" onClick={() => select(bitrate / 1_000)}>
            <Cap k={captions[preset]} /><small className="lr-audio-rate">{bitrate / 1_000}</small>
          </Chip>;
        })}
      </div>
    </>}
  </QualityNumberControl>;
}

export function PicturePreferenceControl({ value, disabled, onChange }: {
  value: DegradationPreference; disabled: boolean; onChange: (value: DegradationPreference) => void;
}) {
  const { t } = useCopy();
  const choices = [
    { value: "maintain-resolution", icon: "mountain", hint: "host.advanced.preference.resolutionHint", comic: "hint-prefer-resolution" },
    { value: "balanced", icon: "balance", hint: "host.advanced.preference.balancedHint", comic: "hint-degrade-pref" },
    { value: "maintain-framerate", icon: "frames", hint: "host.advanced.preference.framerateHint", comic: "hint-prefer-framerate" },
  ] as const;
  return <div className="lr-door-group lr-picture-preference">
    <span className="lr-door-glyph"><Glyph name="mountain" size={19} /><Cap k="host.advanced.preference" /></span>
    <div className="lr-row-group" role="group" aria-label={t("host.advanced.preference")}>
      {choices.map(choice => <Chip key={choice.value} name="degradationPreference" value={choice.value}
        selected={value === choice.value} disabled={disabled} onClick={() => onChange(choice.value)}
        title={`${t(DEGRADATION_PREFERENCE_KEYS[choice.value])}\n${t(choice.hint)}`} hint={choice.comic}>
        <Glyph name={choice.icon} size={18} /><Cap k={DEGRADATION_PREFERENCE_KEYS[choice.value]} />
      </Chip>)}
    </div>
  </div>;
}
