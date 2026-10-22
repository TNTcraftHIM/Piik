import { RouteGlyph } from "../components/living/PawnDetail";
import { Pill } from "../components/living/primitives";
import { useCopy } from "../ui/copy";
import { Glyph } from "../ui/icons";
import { STATUS_CATALOG, type StatusDescriptor } from "../ui/media-status";
import type { RoomVoiceSession } from "./session";
import { useRoomVoiceSnapshot } from "./use-room-voice-state";
import "./room-voice.css";

export function VoiceConnectionDetails({ session, peerId }: {
  session: Pick<RoomVoiceSession, "subscribe" | "getSnapshot"> | null | undefined;
  peerId?: string;
}) {
  const { t, vis } = useCopy();
  const snapshot = useRoomVoiceSnapshot(session);
  const room = snapshot?.room;
  const target = peerId ?? snapshot?.peerId;
  const member = room?.members.find(member => member.peerId === target);
  const joined = Boolean(room?.enabled && member?.joined);
  const upstream = joined ? member?.upstream : undefined;
  const hostRoot = target === room?.hostPeerId;
  const ownDetails = target === snapshot?.peerId;
  const unavailable = ownDetails && snapshot?.error === "transport";
  const status: StatusDescriptor = !room?.enabled
    ? { tone: "off", labelKey: "voice.details.closed", icon: "headphonesOff", tooltip: "hint-voice-closed" }
    : !joined
      ? { tone: "off", labelKey: "voice.outside", icon: "headphonesOff", tooltip: "hint-voice-join" }
      : unavailable
        ? { tone: "bad", labelKey: "voice.details.unavailable", icon: "alert", comic: "route-failed" }
        : !snapshot?.connected || !member?.connected || !hostRoot && upstream?.kind === "none"
          ? { ...STATUS_CATALOG.joining, comic: upstream?.kind === "sfu" ? "connecting-sfu" : "connecting-p2p" }
          : ownDetails && room!.unavailable.length > 0
            ? { tone: "warn", labelKey: "voice.details.partial", icon: "alert", comic: "route-failed" }
            : hostRoot
              ? { ...STATUS_CATALOG.voiceConnected, labelKey: "voice.details.joined" }
              : STATUS_CATALOG.voiceConnected;

  return <div className="lr-voice-connection-details" role="group" aria-label={t("voice.details.title")}>
    <span className="lr-meter-tag">
      <Glyph name="headphones" size={17} />
      <span className={vis ? "visually-hidden" : "lr-cap"}>{t("voice.details.title")}</span>
    </span>
    <Pill icon={status.icon} tone={status.tone} label={t(status.labelKey)}
      comic={(status.tooltip ?? status.comic)!} motion={status.pulse ? "progress" : "still"} />
    {upstream && upstream.kind !== "none" && <RouteGlyph route={upstream.kind === "sfu" ? "sfu" : "p2p"} />}
    {joined && <span className="lr-meter-cell">
      <Glyph name="puzzle" size={16} />
      <span className="lr-meter-text"><b>Opus</b>
        <small className={vis ? "visually-hidden" : undefined}>{t("voice.details.codec")}</small>
      </span>
    </span>}
    {joined && room?.bitrate !== undefined && <span className="lr-meter-cell">
      <Glyph name="gauge" size={16} />
      <span className="lr-meter-text">
        <b>{vis ? "≤ " : ""}{room.bitrate / 1000} kbps</b>
        <small className={vis ? "visually-hidden" : undefined}>{t("voice.details.bitrateLimit")}</small>
      </span>
    </span>}
  </div>;
}
