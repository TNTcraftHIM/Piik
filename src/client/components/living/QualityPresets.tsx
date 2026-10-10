import { Fragment, useRef } from "react";
import { MIN_AUDIO_BITRATE } from "../../../shared/protocol";
import {
  QUALITY_PROFILES, QUALITY_PROFILE_KEYS, QUALITY_RESOLUTIONS, qualityResolutionEqual,
  captureFramerateCeiling, VIDEO_CAPTURE_LIMITS, type VideoCaptureLimits, type QualityProfileId, type QualityResolution,
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
          disabled={disabled || profile.maxFramerate > captureFramerateCeiling(profile.resolution, limits)} onClick={() => onSelect(id)}>
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
    if (captureFramerateCeiling(next, limits) < 15) {
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
        disabled={disabled || captureFramerateCeiling(resolution, limits) < 15}
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

export function AudioBitrateControl({ value, max, disabled, onChange }: {
  value: number;
  max: number;
  disabled: boolean;
  onChange: (bitrate: number) => void;
}) {
  const { t, vis } = useCopy();
  return <div className="lr-door-group">
    <span className="lr-door-glyph"><Glyph name="speaker" size={19} /><Cap k="host.advanced.audio" /></span>
    <div className="lr-row-group" role="group" aria-label={t("host.advanced.audio")}>
      {(Object.keys(SCREEN_AUDIO_BITRATES) as ScreenAudioPreset[]).map(preset => {
        const bitrate = SCREEN_AUDIO_BITRATES[preset];
        return <Chip key={preset} selected={value === bitrate} disabled={disabled || bitrate > max}
          title={t("host.audio.title", { label: t(AUDIO_QUALITY_CAPTIONS[preset]), kbps: String(bitrate / 1_000) })}
          hint="hint-audio-quality" onClick={() => onChange(bitrate)}>
          <Cap k={AUDIO_QUALITY_CAPTIONS[preset]} /><small className="lr-audio-rate">{bitrate / 1_000}</small>
        </Chip>;
      })}
    </div>
    <Tooltip kind="hint-audio-quality" text={vis ? undefined : t("host.audio.bitrateHint", {
      min: String(MIN_AUDIO_BITRATE / 1_000), max: String(max / 1_000),
    })}>
      <label className="lr-input lr-audio-bitrate">
        <input type="number" inputMode="numeric" name="audioBitrate" key={value}
          defaultValue={value / 1_000} min={MIN_AUDIO_BITRATE / 1_000} max={max / 1_000} step={1}
          disabled={disabled} aria-label={t("host.advanced.audioBitrate")}
          onBlur={event => {
            const input = event.currentTarget;
            if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) {
              input.value = String(value / 1_000);
              return;
            }
            if (input.valueAsNumber * 1_000 !== value) onChange(input.valueAsNumber * 1_000);
          }}
          onKeyDown={event => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") event.currentTarget.value = String(value / 1_000);
            event.currentTarget.blur();
          }} />
        <span>kbps</span>
      </label>
    </Tooltip>
  </div>;
}
