import type { ConnectionDetail } from "../components/living/ConnectionDetails";
import { Pill } from "../components/living/primitives";
import type { CopyKey } from "../ui/copy";
import { STATUS_CATALOG, type StatusDescriptor } from "../ui/media-status";
import type { RoomVoiceSnapshot } from "./session";
import type { VoiceConnectionMetric } from "./browser-endpoint";

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

export function voiceMetricsForPeer(metrics: readonly VoiceConnectionMetric[], peerId: string) {
  return metrics.filter(item => item.direction === "receive" && item.peerId === peerId ||
    item.direction === "send" && item.viaPeerId === peerId);
}

export function voiceConnectionDetails({ voice, peerId, metrics = [], peerName, t }: {
  voice: RoomVoiceSnapshot | null | undefined;
  peerId?: string;
  metrics?: readonly VoiceConnectionMetric[];
  peerName?: (id: string) => string;
  t: (key: CopyKey, vars?: Record<string, string>) => string;
}): ConnectionDetail[] {
  const details = describeVoiceConnection(voice, peerId);
  if (!details) return [];
  const own = !peerId || peerId === voice?.peerId;
  const selected = own
    ? metrics
    : voiceMetricsForPeer(metrics, peerId!);
  const notice = (!selected.length || details.status.tone === "bad" || details.status.tone === "warn")
    ? <Pill icon={details.status.icon} tone={details.status.tone} label={t(details.status.labelKey)}
        comic={details.status.comic} motion={details.status.pulse ? "progress" : "still"} /> : null;
  // An aggregate voice error must not mark each healthy RTP sample as failed.
  return [
    ...(notice ? [{ key: "voice-status", media: "audio" as const, label: t("voice.details.title"), note: notice }] : []),
    ...selected.map((item): ConnectionDetail => {
      const key = `voice/${item.connectionId}/${item.direction}/${item.peerId}`;
      const other = item.direction === "send" ? item.viaPeerId : item.peerId;
      const name = other ? peerName?.(other) : item.route === "sfu" ? "SFU" : undefined;
      const forwarded = item.direction === "send" && item.peerId !== voice?.peerId;
      const label = forwarded ? t("voice.details.forwardTo", { source: peerName?.(item.peerId) ?? item.peerId, name: name ?? "SFU" })
        : own && name
        ? t(item.direction === "send" ? "voice.details.sendTo" : "voice.details.receiveFrom", { name })
        : t(item.direction === "send" ? "voice.details.send" : "voice.details.receive");
      const viaName = item.direction === "receive" && item.viaPeerId && item.viaPeerId !== item.peerId
        ? peerName?.(item.viaPeerId) : null;
      return { key, connectionId: item.connectionId, media: "audio", label, route: item.route, direction: item.direction,
        metrics: item.metrics,
        note: viaName ? <small className="lr-media-detail-via">{t("voice.details.via", { name: viaName })}</small> : undefined,
      };
    }),
  ];
}
