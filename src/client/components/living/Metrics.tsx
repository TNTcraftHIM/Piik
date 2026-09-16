// Connection metrics as living-room meter cells: glyph + value, plus the
// label in text modes. Secondary metrics expand behind a chevron.
import { useId } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Tooltip } from "./Tooltip";
import { Pill } from "./primitives";
import type { ConnectionMetrics } from "../../types";
import { formatPacketLossPercent } from "../connection-details";
import { METRIC_PRESENTATION, type MetricLabel } from "./metric-presentation";
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
): string[] {
  const warnings: string[] = [];
  const codecName = (codec: string) => codec.split("/").at(-1) ?? codec;
  if (
    metrics.codec &&
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
): MetricValue[] {
  const values: MetricValue[] = [];
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
  addNumber("stats.rtt", metrics.rttMs, "ms");
  if (metrics.codec) {
    values.push({
      label: "stats.codec",
      value: metrics.codec.split("/").at(-1) ?? metrics.codec,
    });
  }

  if (direction === "send") {
    addNumber("stats.outgoing", metrics.availableOutgoingKbps, "kbps");
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
    addNumber("stats.jitter", metrics.jitterMs, "ms", 1);
    addNumber("stats.dropped", metrics.intervalFramesDropped, "", 0);
    addNumber("stats.decodeMs", metrics.intervalDecodeMs, "ms", 1);
    addNumber("stats.freezeCount", metrics.intervalFreezeCount, "", 0);
    addNumber("stats.freezeDuration", metrics.intervalFreezeDurationMs, "ms", 1);
  }

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
    addNumber("stats.videoBuffer", metrics.videoJitterBufferDelayMs, "ms", 1);
    addNumber("stats.audioBuffer", metrics.audioJitterBufferDelayMs, "ms", 1);
    if (metrics.audioConcealedSamplesPercent !== null) {
      values.push({
        label: "stats.audioConcealedRate",
        value: formatPacketLossPercent(metrics.audioConcealedSamplesPercent, t("stats.unknown")),
      });
    }
    addNumber("stats.audioConcealed", metrics.intervalAudioConcealmentEvents, "", 0);
  }

  return values;
}

export function MetricCell({ icon, label, value, glyphOnly, hint, tone = "off" }: MetricValue) {
  const { t, vis } = useCopy();
  const display = vis && value === t("stats.unknown") ? "—" : value;
  return (
    <Tooltip toggleOnClick kind={hint ?? METRIC_PRESENTATION[label].hint} tone={tone} motion={tone === "warn" ? "still" : "demo"}
      text={vis ? undefined : `${t(label)} · ${display}`}>
    <button type="button" className="lr-meter-cell" aria-label={`${t(label)} · ${display}`}
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

export function MetricCells({
  metrics,
  direction,
  expanded,
  onToggle,
}: {
  metrics: ConnectionMetrics;
  direction: "send" | "receive";
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}) {
  const { t, vis } = useCopy();
  const primary: MetricValue[] = [
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
  const secondary = secondaryMetrics(metrics, direction, t);
  const warnings = codecContractWarnings(metrics, t);
  const secondaryId = useId();
  const moreTitle = t(expanded ? "stats.less" : "stats.more");
  const moreButton = (
    <button
      type="button"
      className={`lr-btn lr-metrics-more${expanded ? " is-open" : ""}`}
      aria-label={moreTitle}
      aria-expanded={expanded}
      aria-controls={secondaryId}
      onClick={(event) => {
        // Pointer activation must not pin the hint open; keyboard keeps focus.
        if (event.detail !== 0) event.currentTarget.blur();
        onToggle(!expanded);
      }}
    >
      <Glyph name="chevron" size={15} />
      {vis ? null : <span className="lr-cap">{moreTitle}</span>}
    </button>
  );

  return (
    <>
      <div className="lr-meter" role="group" aria-label={t("stats.title")}>
        {primary.map((value) => <MetricCell key={value.label} {...value} />)}
      </div>
      {secondary.length > 0 ? (
        <>
          <Tooltip kind={expanded ? "hint-collapse" : "hint-more-metrics"} text={vis ? undefined : moreTitle} align="start">
            {moreButton}
          </Tooltip>
          {expanded ? (
            <div id={secondaryId} className="lr-meter" role="group" aria-label={t("stats.more")}>
              {secondary.map((value) => <MetricCell key={value.label} {...value} />)}
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
