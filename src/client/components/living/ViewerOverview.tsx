import type { ConnectionMetrics } from "../../types";
import { formatPacketLossPercent } from "../connection-details";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import type { StatusDescriptor } from "../../ui/media-status";
import { Tooltip } from "./Tooltip";

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
}: {
  entries: readonly ViewerOverviewEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t, vis } = useCopy();
  const unknown = vis ? "—" : t("stats.unknown");
  const numberValue = (
    value: number | null | undefined,
    digits: number,
    unit = "",
  ): string =>
    finite(value ?? null) ? `${value!.toFixed(digits)}${unit}` : unknown;
  const heading = (key: CopyKey, icon: GlyphName) => (
    <span aria-label={t(key)}>
      {vis ? <Glyph name={icon} size={14} /> : t(key)}
    </span>
  );

  return (
    <section
      className="lr-viewer-overview"
      id="host-viewer-overview"
      aria-label={t("host.viewerOverview")}
    >
      <div className="lr-viewer-overview-scroll">
        <div className="lr-viewer-overview-head" aria-hidden="true">
          <span>{vis ? <Glyph name="users" size={14} /> : t("common.viewers")}</span>
          <span>{vis ? <Glyph name="network" size={14} /> : t("host.topology")}</span>
          {heading("stats.resolution", "expand")}
          {heading("stats.fps", "wave")}
          {heading("stats.bitrate", "gauge")}
          {heading("stats.loss", "drop")}
          {heading("stats.rtt", "clock")}
        </div>
        <div className="lr-viewer-overview-body">
          {entries.map((entry) => {
            const statusLabel = t(entry.status.labelKey);
            const hint = entry.status.tooltip ?? entry.status.comic;
            const metrics = entry.metrics;
            const resolution = metrics?.resolution ?? unknown;
            const fps = numberValue(metrics?.framesPerSecond, 1);
            const bitrate = numberValue(metrics?.bitrateKbps, 0);
            const loss = metrics
              ? formatPacketLossPercent(metrics.packetLossPercent, unknown)
              : unknown;
            const rtt = numberValue(metrics?.rttMs, 0, " ms");
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
                aria-label={`${entry.name} · ${statusLabel} · ${route}`}
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
                    {vis ? null : <small>{statusLabel}</small>}
                  </span>
                </span>
                <span className={`lr-viewer-overview-route is-${entry.route ?? "pending"}`}>
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
                  {vis ? (
                    <span className="visually-hidden">
                      {t(
                        entry.route === "sfu"
                          ? "state.route.sfu"
                          : entry.route === "p2p"
                            ? "state.route.p2p"
                            : "state.peer.connecting",
                      )}
                    </span>
                  ) : (
                    <b>{route}</b>
                  )}
                </span>
                <span>{resolution}</span>
                <span>{fps}</span>
                <span>{bitrate}</span>
                <span>{loss}</span>
                <span>{rtt}</span>
              </button>
            );
            return (
              <Tooltip
                key={entry.key}
                className="lr-overview-row-hint"
                kind={hint}
                tone={entry.status.tone}
                motion={entry.status.pulse ? "progress" : undefined}
                text={vis ? hint ? undefined : entry.name : `${entry.name} · ${statusLabel}`}
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
