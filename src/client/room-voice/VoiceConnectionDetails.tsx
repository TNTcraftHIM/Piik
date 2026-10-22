import { useState, type ReactNode } from "react";
import { RouteGlyph } from "../components/living/PawnDetail";
import { MetricCells } from "../components/living/Metrics";
import { Pill } from "../components/living/primitives";
import { useCopy } from "../ui/copy";
import { Glyph } from "../ui/icons";
import { STATUS_CATALOG, type StatusDescriptor } from "../ui/media-status";
import type { RoomVoiceSnapshot } from "./session";
import type { VoiceConnectionMetric } from "./browser-endpoint";
import { EMPTY_METRICS } from "../types";

export function describeVoiceConnection(snapshot: RoomVoiceSnapshot | null | undefined, peerId?: string) {
  const room = snapshot?.room;
  const target = peerId ?? snapshot?.peerId;
  const member = room?.members.find(member => member.peerId === target);
  if (!room?.enabled || !member?.joined) return null;
  const upstream = member.upstream;
  const hostRoot = target === room?.hostPeerId;
  const ownDetails = target === snapshot?.peerId;
  const unavailable = ownDetails && snapshot?.error === "transport";
  const status: StatusDescriptor = unavailable
    ? { tone: "bad", labelKey: "voice.details.unavailable", icon: "alert", comic: "route-failed" }
    : !snapshot?.connected || !member.connected || !hostRoot && upstream.kind === "none"
      ? { ...STATUS_CATALOG.joining, comic: upstream.kind === "sfu" ? "connecting-sfu" : "connecting-p2p" }
      : ownDetails && room.unavailable.length > 0
        ? { tone: "warn", labelKey: "voice.details.partial", icon: "alert", comic: "route-failed" }
        : hostRoot
          ? { ...STATUS_CATALOG.voiceConnected, labelKey: "voice.details.joined" }
          : STATUS_CATALOG.voiceConnected;
  return { status, upstream };
}

export function voiceMetricsForPeer(metrics: readonly VoiceConnectionMetric[], voice: RoomVoiceSnapshot | null | undefined, peerId: string) {
  return metrics.filter(item => item.direction === "receive" && item.peerId === peerId ||
    item.direction === "send" && item.peerId === voice?.peerId && item.viaPeerId === peerId);
}

function VoiceMetricRow({ item, label, route, notice, viaName }: {
  item: VoiceConnectionMetric | null; label: string; route: "p2p" | "sfu" | null;
  notice?: ReactNode; viaName?: string | null;
}) {
  const { t, vis } = useCopy();
  const [expanded, setExpanded] = useState(false);
  return <div className="lr-media-detail" role="group" aria-label={label}>
    <span className="lr-meter-tag">
      <Glyph name={item?.direction === "send" ? "arrowUp" : "headphones"} size={17} />
      <span className={vis ? "visually-hidden" : "lr-cap"}>{label}</span>
    </span>
    {viaName && <span className="lr-meter-tag">{t("voice.details.via", { name: viaName })}</span>}
    {route && <RouteGlyph route={route} />}
    {notice}
    <MetricCells metrics={item?.metrics ?? EMPTY_METRICS} media="audio" direction={item?.direction ?? "receive"}
      expanded={expanded} onToggle={setExpanded} />
  </div>;
}

export function VoiceConnectionDetails({ voice, peerId, metrics = [], peerName }: {
  voice: RoomVoiceSnapshot | null | undefined;
  peerId?: string;
  metrics?: readonly VoiceConnectionMetric[];
  peerName?: (id: string) => string;
}) {
  const { t, vis } = useCopy();
  const details = describeVoiceConnection(voice, peerId);
  if (!details) return null;
  const own = !peerId || peerId === voice?.peerId;
  const selected = own
    ? metrics.filter(item => item.direction === "receive" || item.peerId === voice?.peerId)
    : voiceMetricsForPeer(metrics, voice, peerId!);
  const rows: (VoiceConnectionMetric | null)[] = selected.length ? selected : [null];
  const notice = (!selected.length || details.status.tone === "bad" || details.status.tone === "warn")
    ? <Pill icon={details.status.icon} tone={details.status.tone} label={t(details.status.labelKey)}
        comic={details.status.comic} motion={details.status.pulse ? "progress" : "still"} /> : null;
  // An aggregate voice error must not mark each healthy RTP sample as failed.
  return <>
    {notice && selected.length > 0 && <div className="lr-media-detail" role="group" aria-label={t("voice.details.title")}>
      <span className="lr-meter-tag"><Glyph name="headphones" size={17} />
        <span className={vis ? "visually-hidden" : "lr-cap"}>{t("voice.details.title")}</span>
      </span>{notice}
    </div>}
    {rows.map(item => {
      const key = item ? `${item.connectionId}/${item.direction}/${item.peerId}` : "waiting";
      const other = item?.direction === "send" ? item.viaPeerId : item?.peerId;
      const name = other ? peerName?.(other) : item?.route === "sfu" ? "SFU" : undefined;
      const label = item ? own && name
        ? t(item.direction === "send" ? "voice.details.sendTo" : "voice.details.receiveFrom", { name })
        : t(item.direction === "send" ? "voice.details.send" : "voice.details.receive")
        : t("voice.details.title");
      const viaName = item?.direction === "receive" && item.viaPeerId && item.viaPeerId !== item.peerId
        ? peerName?.(item.viaPeerId) : null;
      const route = item?.route ?? (details.upstream.kind === "none" ? null : details.upstream.kind === "sfu" ? "sfu" : "p2p");
      return <VoiceMetricRow key={key} item={item} label={label} route={route} notice={item ? undefined : notice} viaName={viaName} />;
    })}
  </>;
}
