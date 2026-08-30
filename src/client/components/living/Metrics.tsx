// Connection metrics as living-room meter cells: glyph + value, plus the
// label in text modes. Secondary metrics expand behind a chevron.
import { useId, useState, type ReactNode } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { ComicTooltip } from "./ComicTooltip";
import { Pill } from "./primitives";
import type { ConnectionMetrics } from "../../types";
import { formatPacketLossPercent } from "../connection-details";

interface MetricValue {
  icon: GlyphName;
  label: CopyKey;
  value: string;
  title?: string;
}

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
    label: CopyKey,
    icon: GlyphName,
    value: number | null,
    unit: string,
    digits = 0,
    title?: string,
  ) => {
    if (value !== null && Number.isFinite(value)) {
      values.push({ icon, label, value: `${readable(value, digits)} ${unit}`, title });
    }
  };
  const qualityReason = (value: string): string => {
    const keys: Record<string, CopyKey> = {
      none: "stats.quality.normal",
      bandwidth: "stats.quality.bandwidth",
      cpu: "stats.quality.cpu",
      other: "stats.quality.other",
    };
    return t(keys[value] ?? "stats.quality.unclassified");
  };

  addNumber("stats.rtt", "clock", metrics.rttMs, "ms");
  if (metrics.codec) {
    values.push({
      icon: "cpu",
      label: "stats.codec",
      value: metrics.codec.split("/").at(-1) ?? metrics.codec,
    });
  }

  if (direction === "send") {
    addNumber("stats.outgoing", "gauge", metrics.availableOutgoingKbps, "kbps");
    if (metrics.qualityLimitationReason) {
      values.push({
        icon: "gauge",
        label: "stats.qualityState",
        value: qualityReason(metrics.qualityLimitationReason),
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
      values.push({ icon: "expand", label: "stats.capture", value: captureParts.join(" · ") });
    }
    addNumber("stats.inputFps", "wave", metrics.mediaSourceFramesPerSecond, "fps", 1);
    if (metrics.encoderImplementation) {
      values.push({
        icon: "cpu",
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
    addNumber("stats.encodeMs", "clock", metrics.intervalEncodeMs, "ms", 1);
  } else {
    addNumber("stats.jitter", "wave", metrics.jitterMs, "ms", 1);
    addNumber("stats.dropped", "drop", metrics.framesDropped, "", 0);
    addNumber("stats.decodeMs", "clock", metrics.intervalDecodeMs, "ms", 1);
    addNumber("stats.freezeCount", "alert", metrics.intervalFreezeCount, "", 0);
    addNumber("stats.freezeDuration", "clock", metrics.intervalFreezeDurationMs, "ms", 1);
  }

  addNumber("stats.audio", "speaker", metrics.audioBitrateKbps, "kbps");
  if (metrics.audioPacketLossPercent !== null) {
    values.push({
      icon: "drop",
      label: "stats.audioLoss",
      value: formatPacketLossPercent(metrics.audioPacketLossPercent, t("stats.unknown")),
    });
  }
  addNumber("stats.audioJitter", "wave", metrics.audioJitterMs, "ms", 1);

  if (direction === "receive") {
    addNumber("stats.playoutDelta", "clock", metrics.audioVideoPlayoutDeltaMs, "ms", 1);
    addNumber("stats.videoBuffer", "clock", metrics.videoJitterBufferDelayMs, "ms", 1);
    addNumber("stats.audioBuffer", "clock", metrics.audioJitterBufferDelayMs, "ms", 1);
    if (metrics.audioConcealedSamplesPercent !== null) {
      values.push({
        icon: "drop",
        label: "stats.audioConcealedRate",
        value: formatPacketLossPercent(metrics.audioConcealedSamplesPercent, t("stats.unknown")),
      });
    }
    addNumber("stats.audioConcealed", "speaker", metrics.intervalAudioConcealmentEvents, "", 0);
  }

  return values;
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
  const cell = ({ icon, label, value, title }: MetricValue): ReactNode => {
    if (vis && label === "stats.qualityState") return null;
    const display = vis && value === t("stats.unknown") ? "—" : value;
    return (
    <span className="lr-meter-cell" title={vis ? undefined : title ?? t(label)} key={label + display}>
      <Glyph name={icon} size={16} />
      {vis ? (
        <>
          <b>{display}</b>
          <span className="visually-hidden">{t(label)}</span>
        </>
      ) : (
        <span className="lr-meter-text">
          <b>{display}</b>
          <small>{t(label)}</small>
        </span>
      )}
    </span>
    );
  };

  const primary: MetricValue[] = [
    { icon: "expand", label: "stats.resolution", value: metrics.resolution ?? t("stats.unknown") },
    {
      icon: "wave",
      label: "stats.fps",
      value: metrics.framesPerSecond === null || !Number.isFinite(metrics.framesPerSecond)
        ? t("stats.unknown")
        : `${metrics.framesPerSecond.toFixed(1)} fps`,
    },
    {
      icon: "gauge",
      label: "stats.bitrate",
      value: metrics.bitrateKbps === null || !Number.isFinite(metrics.bitrateKbps)
        ? t("stats.unknown")
        : `${metrics.bitrateKbps.toFixed(0)} kbps`,
    },
    { icon: "drop", label: "stats.loss", value: formatPacketLossPercent(metrics.packetLossPercent, t("stats.unknown")) },
  ];
  const secondary = secondaryMetrics(metrics, direction, t);
  const warnings = codecContractWarnings(metrics, t);
  const secondaryId = useId();
  const moreTitle = t(expanded ? "stats.less" : "stats.more");
  const moreButton = (
    <button
      type="button"
      className={`lr-btn lr-metrics-more${expanded ? " is-open" : ""}`}
      title={vis ? undefined : moreTitle}
      aria-label={moreTitle}
      aria-expanded={expanded}
      aria-controls={secondaryId}
      onClick={(event) => {
        // Hint-wrapped in vis: pointer activation must not leave the comic
        // pinned open by focus (keyboard clicks keep focus).
        if (vis && event.detail !== 0) event.currentTarget.blur();
        onToggle(!expanded);
      }}
    >
      <Glyph name="chevron" size={15} />
      {vis ? null : <span className="lr-cap">{t("stats.more")}</span>}
    </button>
  );

  return (
    <>
      <div className="lr-meter" role="group" aria-label={t("stats.title")}>
        {primary.map(cell)}
      </div>
      {secondary.length > 0 ? (
        <>
          {vis ? (
            // This button lands at the card's left edge (the meter takes a
            // full flex basis), so prefer start; ComicTooltip re-picks from
            // live geometry if that would clip.
            <ComicTooltip kind="hint-more-metrics" align="start">{moreButton}</ComicTooltip>
          ) : (
            moreButton
          )}
          {expanded ? (
            <div id={secondaryId} className="lr-meter" role="group" aria-label={t("stats.more")}>
              {secondary.map(cell)}
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

// Standalone wrapper for pages that keep the expanded state themselves.
export function useMetricsExpanded(): [boolean, (next: boolean) => void] {
  const [expanded, setExpanded] = useState(false);
  return [expanded, setExpanded];
}
