import { useId, type ReactNode } from "react";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn } from "../../components/living/primitives";
import { joinItems, useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { ChannelRoom } from "../protocol";
import { participantViewingLabel, viewingAppearance, type ParticipantViewing } from "../presentation";
import { ChannelIdentityMark } from "./ChannelIdentity";
import "./channel-room-item.css";

/** Room navigation and room management are separate actions on the same item.
 * An unavailable room this device should host but could not open is not described as offline. */
export function ChannelRoomItem({ room, selected, voice = false, sharing = false, viewing,
  sourceCount = 0, settingsOpen = false, unread = false, unopened = false, participantDisclosure, peopleFaces, compact = false, participantCount, onSelect, onManage }: {
  room: ChannelRoom; selected: boolean; voice?: boolean; sharing?: boolean; viewing?: ParticipantViewing; unopened?: boolean;
  sourceCount?: number; settingsOpen?: boolean; unread?: boolean; onSelect(): void; onManage(): void;
  compact?: boolean; participantCount?: number; peopleFaces?: ReactNode;
  participantDisclosure?: { open: boolean; count: number; controls: string; onToggle(): void };
}) {
  const { t, lang } = useCopy();
  const unreadId = useId(), offlineId = useId(), activityId = useId();
  const settingsLabel = t("room.item.settings", { name: room.name });
  const offlineLabel = t(unopened ? "room.item.unopened" : "room.item.offline");
  const activity = sharing ? t("channel.roomParticipants.sharing") : viewing ? participantViewingLabel(viewing, t)
    : sourceCount > 0 ? `${t("screen.sharedScreens")} ${sourceCount}` : "";
  const activityLabel = joinItems(lang, [
    room.access === "private" ? t("room.settings.private") : "",
    voice ? t("channel.joinVoice.voiceJoined") : "",
    activity,
    participantCount ? [t("channel.people.users"), participantCount].join(" ") : "",
  ].filter(Boolean));
  return <div className="c3-room-item" data-compact={compact || undefined} data-selected={selected || undefined} data-unread={unread || undefined} data-settings-open={settingsOpen || undefined} data-offline={!room.available || undefined}>
    {participantDisclosure && <span className="c3-room-voice-toggle lr-embedded-actions">
      <Btn icon="chevron" size="dense" quiet textTooltip
        title={{ text: t(participantDisclosure.open ? "room.item.hideParticipants" : "room.item.showParticipants", { count: String(participantDisclosure.count) }) }}
        expanded={participantDisclosure.open} controls={participantDisclosure.controls} onClick={participantDisclosure.onToggle} />
    </span>}
    <Tooltip className="c3-room-label" {...(compact ? { text: room.name } : { overflow: { text: room.name, selector: "strong" } })}>
      <button type="button" className="lr-btn is-quiet c3-room-link" aria-label={room.name}
        aria-describedby={[unread && unreadId, !room.available && offlineId, activityLabel && activityId].filter(Boolean).join(" ") || undefined}
        aria-current={selected ? "page" : undefined} onClick={onSelect}>
        <ChannelIdentityMark icon={room.icon} picture={selected ? room.picture : undefined} size={21} />
        {compact ? peopleFaces : <strong>{room.name}</strong>}
        {!compact && <span className="c3-room-activity" aria-hidden="true">
          {room.access === "private" && <Glyph name="lock" size={13} />}
          {!room.available && <span>{offlineLabel}</span>}
          {voice && <Glyph name="headphones" size={14} />}
          {sharing ? <Glyph name="cast" size={14} /> : viewing ? <Glyph name={viewingAppearance[viewing].icon} size={14} />
            : sourceCount > 0 ? <span>{sourceCount}<Glyph name="tv" size={13} /></span> : null}
        </span>}
      </button>
    </Tooltip>
    {!compact && peopleFaces}
    {unread && <span id={unreadId} className="c3-room-unread-label">{t("room.item.unread")}</span>}
    {!room.available && <span id={offlineId} className="visually-hidden">{offlineLabel}</span>}
    {activityLabel && <span id={activityId} className="visually-hidden">{activityLabel}</span>}
    {!compact && (room.authorized || room.canManage) && <span className="c3-room-manage">
      <Btn icon="sliders" size="dense" quiet title={{ text: settingsLabel }} textTooltip
        expanded={settingsOpen} hasPopup="dialog" tone={settingsOpen ? "on" : undefined} onClick={onManage} />
    </span>}
  </div>;
}
