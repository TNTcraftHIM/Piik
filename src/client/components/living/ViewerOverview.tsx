import type { ConnectionMetrics } from "../../types";
import { formatPacketLossPercent } from "../connection-details";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import type { StatusDescriptor } from "../../ui/media-status";
import { Tooltip } from "./Tooltip";
import { METRIC_PRESENTATION, metricHintText, type MetricLabel } from "./metric-presentation";
import type { RoomVoiceSnapshot } from "../../room-voice/participant-presentation";
import { describeVoiceConnection, voiceMetricsForPeer, type VoiceConnectionMetric } from "../../room-voice/VoiceConnectionDetails";

export interface ViewerOverviewEntry {
  key: string;
  name: string;
  status: StatusDescriptor;
  route: "p2p" | "sfu" | null;
  metrics: ConnectionMetrics | null;
}

function finite(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

export function ViewerOverview({
  entries,
  selectedKey,
  onSelect,
  pictureActive,
  voice,
  voiceMetrics = [],
}: {
  entries: readonly ViewerOverviewEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  pictureActive: boolean;
  voice?: RoomVoiceSnapshot | null;
  voiceMetrics?: readonly VoiceConnectionMetric[];
}) {
  const { t } = useCopy();
  const voiceActive = voice?.room?.enabled === true;
  const unknown = t("stats.unknown");
  const numberValue = (
    value: number | null | undefined,
    digits: number,
    unit = "",
  ): string =>
    finite(value ?? null) ? `${value!.toFixed(digits)}${unit}` : unknown;
  const heading = (key: MetricLabel) => (
    <Tooltip toggleOnClick kind={METRIC_PRESENTATION[key].hint} text={metricHintText(key, t)}>
      <button type="button" aria-label={t(key)} style={{ border: 0, padding: 0, background: "none", color: "inherit", font: "inherit" }}>
        {t(key)}
      </button>
    </Tooltip>
  );

  return (
    <section
      className={`lr-viewer-overview${pictureActive ? " has-picture" : ""}${voiceActive ? " has-voice" : ""}`}
      id="host-viewer-overview"
      aria-label={t("host.viewerOverview")}
    >
      <div className="lr-viewer-overview-scroll">
        <div className="lr-viewer-overview-head">
          <span>{t("common.viewers")}</span>
          {pictureActive && <>
          <span>{t("host.settings.picture")}</span>
          {heading("stats.resolution")}
          {heading("stats.fps")}
          {heading("stats.bitrate")}
          {heading("stats.loss")}
          {heading("stats.rtt")}
          </>}
          {voiceActive && <span>{t(pictureActive ? "voice.details.title" : "voice.details.receive")}</span>}
          {voiceActive && !pictureActive && <>
            {heading("stats.audio")}{heading("stats.rtt")}{heading("stats.audioLoss")}{heading("stats.audioJitter")}
          </>}
        </div>
        <div className="lr-viewer-overview-body">
          {entries.map((entry) => {
            const statusLabel = t(entry.status.labelKey);
            const hint = entry.status.tooltip ?? entry.status.comic;
            const metrics = entry.metrics;
            const resolution = metrics?.resolution ?? unknown;
            const fps = numberValue(metrics?.framesPerSecond, 1, " fps");
            const bitrate = numberValue(metrics?.bitrateKbps, 0, " kbps");
            const loss = metrics
              ? formatPacketLossPercent(metrics.packetLossPercent, unknown)
              : unknown;
            const rtt = numberValue(metrics?.rttMs, 0, " ms");
            const voiceDetail = describeVoiceConnection(voice, entry.key);
            const voiceObservation = voiceMetricsForPeer(voiceMetrics, entry.key).find(item => item.direction === "receive");
            const voiceSample = voiceObservation?.metrics;
            const voiceLabel = t(voiceDetail?.status.labelKey ?? "voice.outside");
            const voiceRoute = voiceObservation?.route.toUpperCase() ?? (voiceDetail?.upstream.kind === "peer" ? "P2P" : voiceDetail?.upstream.kind === "sfu" ? "SFU" : null);
            const route =
              entry.route === "sfu"
                ? "SFU"
                : entry.route === "p2p"
                  ? "P2P"
                  : "—";
            const row = (
              <button
                type="button"
                className={`lr-viewer-overview-row${selectedKey === entry.key ? " is-selected" : ""}`}
                aria-pressed={selectedKey === entry.key}
                aria-label={[entry.name, statusLabel, pictureActive ? route : null,
                  voiceActive ? `${t("voice.details.title")} · ${voiceRoute ?? voiceLabel}` : null].filter(Boolean).join(" · ")}
                onClick={() => onSelect(entry.key)}
              >
                <span className="lr-viewer-overview-person">
                  <span className="lr-viewer-overview-pawn">
                    <PawnSvg color={participantColor(entry.key)} identity={entry.key} />
                    <i className="lr-pawn-led" data-tone={entry.status.tone}
                      data-pulse={entry.status.pulse || undefined} aria-hidden="true" />
                  </span>
                  <span className="lr-viewer-overview-person-copy">
                    <b>{entry.name}</b>
                    <small>{statusLabel}</small>
                  </span>
                </span>
                {pictureActive && <><span className={`lr-viewer-overview-route is-${entry.route ?? "pending"}`}>
                  <Glyph
                    name={
                      entry.route === "sfu"
                        ? "server"
                        : entry.route === "p2p"
                          ? "network"
                          : "loader"
                    }
                    size={14}
                  />
                  <b>{route}</b>
                </span>
                <span>{resolution}</span>
                <span>{fps}</span>
                <span>{bitrate}</span>
                <span>{loss}</span>
                <span>{rtt}</span>
                </>}
                {voiceActive && <span className="lr-viewer-overview-voice" data-tone={voiceDetail?.status.tone ?? "off"}>
                  <Glyph name={voiceDetail?.status.icon ?? "headphonesOff"} size={14} />
                  <span><b>{voiceRoute ?? voiceLabel}</b>
                    {voiceRoute && <small>{voiceLabel}</small>}
                  </span>
                </span>}
                {voiceActive && !pictureActive && <>
                  <span>{numberValue(voiceSample?.bitrateKbps, 0, " kbps")}</span>
                  <span>{numberValue(voiceSample?.rttMs, 0, " ms")}</span>
                  <span>{formatPacketLossPercent(voiceSample?.packetLossPercent ?? null, unknown)}</span>
                  <span>{numberValue(voiceSample?.jitterMs, 1, " ms")}</span>
                </>}
              </button>
            );
            return (
              <Tooltip
                key={entry.key}
                className="lr-overview-row-hint"
                kind={hint}
                tone={entry.status.tone}
                motion={entry.status.pulse ? "progress" : undefined}
                text={statusLabel}
                overflow={{ text: entry.name, selector: ".lr-viewer-overview-person-copy > b" }}
                align="start"
              >
                {row}
              </Tooltip>
            );
          })}
        </div>
      </div>
    </section>
  );
}
