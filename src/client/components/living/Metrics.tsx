// Connection metrics as living-room meter cells: glyph + value, plus the
// label in text modes. Secondary metrics expand behind a chevron.
import { useId } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Tooltip } from "./Tooltip";
import { Pill } from "./primitives";
import type { ConnectionMetrics } from "../../types";
import { formatPacketLossPercent } from "../connection-details";
import { METRIC_PRESENTATION, metricHintText, type MetricLabel } from "./metric-presentation";
import type { ComicKind, HintKind } from "../../ui/visual-kinds";
import type { ComicTone } from "./comic-presentation";

interface MetricValue {
  icon?: GlyphName;
  label: MetricLabel;
  value: string;
  hint?: ComicKind | HintKind;
  tone?: ComicTone;
  /** Visual mode shows the glyph alone; the value stays in the a11y name. */
  glyphOnly?: boolean;
}

interface MetricGroup { label: CopyKey; values: MetricValue[] }

// One display for each observed sender reason. Unknown reasons remain explicit;
// none describes this field, not a verdict about the whole connection.
const QUALITY_REASONS = {
  none: { valueKey: "stats.quality.normal", icon: "check", hint: "hint-metric-quality", tone: "off" },
  bandwidth: { valueKey: "stats.quality.bandwidth", icon: "gauge", hint: "bandwidth-limited", tone: "warn" },
  cpu: { valueKey: "stats.quality.cpu", icon: "cpu", hint: "encoder-limited", tone: "warn" },
  other: { valueKey: "stats.quality.other", icon: "alert", hint: "hint-metric-quality", tone: "warn" },
  unclassified: { valueKey: "stats.quality.unclassified", icon: "alert", hint: "hint-metric-quality", tone: "warn" },
} satisfies Record<string, { valueKey: CopyKey; icon: GlyphName; hint: ComicKind | HintKind; tone: ComicTone }>;

export function codecContractWarnings(
  metrics: ConnectionMetrics,
  t: (key: CopyKey, vars?: Record<string, string>) => string,
  media: "video" | "audio" = "video",
): string[] {
  const warnings: string[] = [];
  const codecName = (codec: string) => codec.split("/").at(-1) ?? codec;
  if (
    media === "video" && metrics.codec &&
    !["video/h264", "video/vp8"].includes(metrics.codec.toLowerCase())
  ) {
    warnings.push(t("stats.warn.codec", { codec: codecName(metrics.codec) }));
  }
  if (metrics.audioCodec && metrics.audioCodec.toLowerCase() !== "audio/opus") {
    warnings.push(t("stats.warn.audioCodec", { codec: codecName(metrics.audioCodec) }));
  }
  return warnings;
}

function secondaryMetrics(
  metrics: ConnectionMetrics,
  direction: "send" | "receive",
  t: (key: CopyKey, vars?: Record<string, string>) => string,
  media: "video" | "audio",
): MetricGroup[] {
  const groups: MetricGroup[] = [];
  let values: MetricValue[] = [];
  const group = (label: CopyKey) => { values = []; groups.push({ label, values }); };
  const readable = (value: number | null, digits = 0): string =>
    value === null || !Number.isFinite(value) ? t("stats.unknown") : value.toFixed(digits);
  const addNumber = (
    label: MetricLabel,
    value: number | null,
    unit: string,
    digits = 0,
  ) => {
    if (value !== null && Number.isFinite(value)) {
      values.push({ label, value: `${readable(value, digits)} ${unit}` });
    }
  };
  if (media === "audio") {
    group("stats.group.encoding");
    if (metrics.audioCodec) values.push({ label: "voice.details.codec", value: metrics.audioCodec.split("/").at(-1)! });
    if (direction === "receive") {
      group("stats.group.playback");
      addNumber("stats.audioBuffer", metrics.audioJitterBufferDelayMs, "ms", 1);
      if (metrics.audioConcealedSamplesPercent !== null) values.push({ label: "stats.audioConcealedRate",
        value: formatPacketLossPercent(metrics.audioConcealedSamplesPercent, t("stats.unknown")) });
      addNumber("stats.audioConcealed", metrics.intervalAudioConcealmentEvents, "", 0);
    }
    return groups.filter(group => group.values.length);
  }
  group("stats.group.network");
  addNumber("stats.rtt", metrics.rttMs, "ms");
  if (direction === "send") addNumber("stats.outgoing", metrics.availableOutgoingKbps, "kbps");
  else addNumber("stats.jitter", metrics.jitterMs, "ms", 1);
  group("stats.group.capture");
  if (metrics.codec) {
    values.push({
      label: "stats.codec",
      value: metrics.codec.split("/").at(-1) ?? metrics.codec,
    });
  }

  if (direction === "send") {
    if (metrics.qualityLimitationReason) {
      const { valueKey, ...presentation } = Object.hasOwn(QUALITY_REASONS, metrics.qualityLimitationReason)
        ? QUALITY_REASONS[metrics.qualityLimitationReason as keyof typeof QUALITY_REASONS]
        : QUALITY_REASONS.unclassified;
      values.push({
        ...presentation,
        label: "stats.qualityState",
        value: t(valueKey),
        // A limitation reason is a sentence, not a measured value: visual
        // mode states it with the glyph and keeps the words for AT.
        glyphOnly: true,
      });
    }
    const captureParts: string[] = [];
    if (metrics.captureWidth !== null && metrics.captureHeight !== null) {
      const captureResolution = `${metrics.captureWidth}x${metrics.captureHeight}`;
      if (captureResolution !== metrics.resolution) {
        captureParts.push(captureResolution);
      }
    }
    if (metrics.captureFramesPerSecond !== null) {
      const captureFps = readable(metrics.captureFramesPerSecond, 1);
      if (
        metrics.framesPerSecond === null ||
        !Number.isFinite(metrics.framesPerSecond) ||
        captureFps !== metrics.framesPerSecond.toFixed(1)
      ) {
        captureParts.push(`${captureFps} fps`);
      }
    }
    if (captureParts.length > 0) {
      values.push({ label: "stats.capture", value: captureParts.join(" · ") });
    }
    addNumber("stats.inputFps", metrics.mediaSourceFramesPerSecond, "fps", 1);
    if (metrics.encoderImplementation) {
      values.push({
        label: "stats.encoder",
        value: `${metrics.encoderImplementation}${
          metrics.powerEfficientEncoder === true
            ? " · ✓"
            : metrics.powerEfficientEncoder === false
              ? " · ✗"
              : ""
        }`,
      });
    }
    addNumber("stats.encodeMs", metrics.intervalEncodeMs, "ms", 1);
  } else {
    group("stats.group.playback");
    addNumber("stats.dropped", metrics.intervalFramesDropped, "", 0);
    addNumber("stats.decodeMs", metrics.intervalDecodeMs, "ms", 1);
    addNumber("stats.freezeCount", metrics.intervalFreezeCount, "", 0);
    addNumber("stats.freezeDuration", metrics.intervalFreezeDurationMs, "ms", 1);
    addNumber("stats.videoBuffer", metrics.videoJitterBufferDelayMs, "ms", 1);
  }

  group("stats.group.sourceAudio");
  addNumber("stats.audio", metrics.audioBitrateKbps, "kbps");
  if (metrics.audioPacketLossPercent !== null) {
    values.push({
      label: "stats.audioLoss",
      value: formatPacketLossPercent(metrics.audioPacketLossPercent, t("stats.unknown")),
    });
  }
  addNumber("stats.audioJitter", metrics.audioJitterMs, "ms", 1);

  if (direction === "receive") {
    addNumber("stats.playoutDelta", metrics.audioVideoPlayoutDeltaMs, "ms", 1);
    addNumber("stats.audioBuffer", metrics.audioJitterBufferDelayMs, "ms", 1);
    if (metrics.audioConcealedSamplesPercent !== null) {
      values.push({
        label: "stats.audioConcealedRate",
        value: formatPacketLossPercent(metrics.audioConcealedSamplesPercent, t("stats.unknown")),
      });
    }
    addNumber("stats.audioConcealed", metrics.intervalAudioConcealmentEvents, "", 0);
  }

  return groups.filter(group => group.values.length);
}

export function hasDetailedMetrics(metrics: ConnectionMetrics, direction: "send" | "receive", media: "video" | "audio" = "video") {
  return secondaryMetrics(metrics, direction, key => key, media).length > 0;
}

export function CaptureMetricCells({ resolution, frameRate, codec, hasSourceAudio }: {
  resolution: string | null; frameRate: number | null; codec: string | null; hasSourceAudio: boolean;
}) {
  const { t, vis } = useCopy();
  return <div className="lr-meter" role="group" aria-label={t("host.captureAria")}>
    <MetricCell label="stats.resolution" value={resolution ?? t("stats.unknown")} />
    <MetricCell label="stats.fps" value={frameRate ? `${frameRate.toFixed(0)} fps` : vis ? "—" : t("host.capture.fpsUnknown")} />
    <MetricCell label="stats.codec" value={codec?.toUpperCase() ?? (vis ? "—" : t("host.capture.codecPending"))} />
    <Tooltip toggleOnClick kind={hasSourceAudio ? "hint-source-audio" : "no-audio"}
      text={vis ? undefined : t(hasSourceAudio ? "host.capture.hasAudio" : "host.capture.noAudio")} tone="off">
      <button type="button" className="lr-meter-cell"
        style={{ border: 0, color: "inherit", font: "inherit", textAlign: "start" }}
        aria-label={t(hasSourceAudio ? "host.capture.hasAudio" : "host.capture.noAudio")}>
        <Glyph name={hasSourceAudio ? "speaker" : "speakerOff"} size={16} />
        {!vis && <b>{t(hasSourceAudio ? "host.capture.hasAudio" : "host.capture.noAudio")}</b>}
      </button>
    </Tooltip>
  </div>;
}

export function MetricCell({ icon, label, value, glyphOnly, hint, tone = "off" }: MetricValue) {
  const { t, vis } = useCopy();
  const display = vis && value === t("stats.unknown") ? "—" : value;
  return (
    <Tooltip toggleOnClick kind={hint ?? METRIC_PRESENTATION[label].hint} tone={tone} motion={tone === "warn" ? "still" : "demo"}
      text={vis ? undefined : metricHintText(label, t, display)}>
    <button type="button" className="lr-meter-cell" data-metric={label} aria-label={`${t(label)} · ${display}`}
      style={{ border: 0, color: "inherit", font: "inherit", textAlign: "start" }}>
      <Glyph name={icon ?? METRIC_PRESENTATION[label].icon} size={16} />
      {vis ? (
        <>
          {glyphOnly ? null : <b>{display}</b>}
          <span className="visually-hidden">
            {glyphOnly ? [t(label), display].join(" · ") : t(label)}
          </span>
        </>
      ) : (
        <span className="lr-meter-text">
          <b>{display}</b>
          <small>{t(label)}</small>
        </span>
      )}
    </button>
    </Tooltip>
  );
}

export function MetricDetailsToggle({ expanded, onToggle, controls }: {
  expanded: boolean; onToggle: (expanded: boolean) => void; controls: string;
}) {
  const { t, vis } = useCopy();
  const moreTitle = t(expanded ? "stats.less" : "stats.more");
  return <Tooltip kind={expanded ? "hint-collapse" : "hint-more-metrics"} text={vis ? undefined : moreTitle} align="start">
    <button
      type="button"
      className={`lr-btn lr-metrics-more${expanded ? " is-open" : ""}`}
      aria-label={moreTitle}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={(event) => {
        // Pointer activation must not pin the hint open; keyboard keeps focus.
        if (event.detail !== 0) event.currentTarget.blur();
        onToggle(!expanded);
      }}
    >
      <Glyph name="chevron" size={15} />
      {vis ? null : <span className="lr-cap">{t("stats.more")}</span>}
    </button>
  </Tooltip>;
}

export function MetricCells({
  metrics,
  direction,
  expanded,
  onToggle,
  media = "video",
}: {
  metrics: ConnectionMetrics;
  direction: "send" | "receive";
  expanded: boolean;
  onToggle?: (expanded: boolean) => void;
  media?: "video" | "audio";
}) {
  const { t, vis } = useCopy();
  const primary: MetricValue[] = media === "audio" ? [
    { label: "stats.audio", value: metrics.bitrateKbps === null ? t("stats.unknown") : `${metrics.bitrateKbps.toFixed(0)} kbps` },
    { label: "stats.rtt", value: metrics.rttMs === null ? t("stats.unknown") : `${metrics.rttMs.toFixed(0)} ms` },
    { label: "stats.audioLoss", value: formatPacketLossPercent(metrics.packetLossPercent, t("stats.unknown")) },
    { label: "stats.audioJitter", value: metrics.jitterMs === null ? t("stats.unknown") : `${metrics.jitterMs.toFixed(1)} ms` },
  ] : [
    { label: "stats.resolution", value: metrics.resolution ?? t("stats.unknown") },
    {
      label: "stats.fps",
      value: metrics.framesPerSecond === null || !Number.isFinite(metrics.framesPerSecond)
        ? t("stats.unknown")
        : `${metrics.framesPerSecond.toFixed(1)} fps`,
    },
    {
      label: "stats.bitrate",
      value: metrics.bitrateKbps === null || !Number.isFinite(metrics.bitrateKbps)
        ? t("stats.unknown")
        : `${metrics.bitrateKbps.toFixed(0)} kbps`,
    },
    { label: "stats.loss", value: formatPacketLossPercent(metrics.packetLossPercent, t("stats.unknown")) },
  ];
  const secondary = secondaryMetrics(metrics, direction, t, media);
  const warnings = codecContractWarnings(metrics, t, media);
  const secondaryId = useId();

  return (
    <>
      <div className="lr-meter" role="group" aria-label={t("stats.title")}>
        {primary.map((value) => <MetricCell key={value.label} {...value} />)}
      </div>
      {secondary.length > 0 ? (
        <>
          {onToggle && <MetricDetailsToggle expanded={expanded} onToggle={onToggle} controls={secondaryId} />}
          {expanded ? (
            <div id={secondaryId} className="lr-metric-groups" role="group" aria-label={t("stats.more")}>
              {secondary.map(group => <section className="lr-metric-group" key={group.label} aria-label={t(group.label)}>
                <h4 className={vis ? "visually-hidden" : "lr-metric-group-label"}>{t(group.label)}</h4>
                <div className="lr-meter">{group.values.map(value => <MetricCell key={value.label} {...value} />)}</div>
              </section>)}
            </div>
          ) : null}
        </>
      ) : null}
      {warnings.map((warning) => (
        <Pill icon="alert" label={warning} comic="warning" key={warning} />
      ))}
    </>
  );
}
