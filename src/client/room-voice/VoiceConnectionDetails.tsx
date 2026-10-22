import { RouteGlyph } from "../components/living/PawnDetail";
import { Pill } from "../components/living/primitives";
import { useCopy } from "../ui/copy";
import { Glyph } from "../ui/icons";
import { STATUS_CATALOG, type StatusDescriptor } from "../ui/media-status";
import type { RoomVoiceSnapshot } from "./session";
import "./room-voice.css";

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
  return { status, upstream, bitrate: room.bitrate };
}

export function VoiceConnectionDetails({ voice, peerId }: {
  voice: RoomVoiceSnapshot | null | undefined;
  peerId?: string;
}) {
  const { t, vis } = useCopy();
  const details = describeVoiceConnection(voice, peerId);
  if (!details) return null;
  const { status, upstream, bitrate } = details;

  return <div className="lr-voice-connection-details" role="group" aria-label={t("voice.details.title")}>
    <span className="lr-meter-tag">
      <Glyph name="headphones" size={17} />
      <span className={vis ? "visually-hidden" : "lr-cap"}>{t("voice.details.title")}</span>
    </span>
    <Pill icon={status.icon} tone={status.tone} label={t(status.labelKey)}
      comic={(status.tooltip ?? status.comic)!} motion={status.pulse ? "progress" : "still"} />
    {upstream && upstream.kind !== "none" && <RouteGlyph route={upstream.kind === "sfu" ? "sfu" : "p2p"} />}
    <span className="lr-meter-cell">
      <Glyph name="puzzle" size={16} />
      <span className="lr-meter-text"><b>Opus</b>
        <small className={vis ? "visually-hidden" : undefined}>{t("voice.details.codec")}</small>
      </span>
    </span>
    {bitrate !== undefined && <span className="lr-meter-cell">
      <Glyph name="gauge" size={16} />
      <span className="lr-meter-text">
        <b>{vis ? "≤ " : ""}{bitrate / 1000} kbps</b>
        <small className={vis ? "visually-hidden" : undefined}>{t("voice.details.bitrateLimit")}</small>
      </span>
    </span>}
  </div>;
}
