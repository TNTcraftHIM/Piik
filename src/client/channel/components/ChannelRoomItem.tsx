import { useId } from "react";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { ChannelRoom } from "../protocol";
import { ChannelIdentityMark } from "./ChannelIdentity";
import "./channel-room-item.css";

/** Room navigation and room management are separate actions on the same item. */
export function ChannelRoomItem({ room, selected, voice = false, sharing = false, watching = false,
  sourceCount = 0, settingsOpen = false, unread = false, participantDisclosure, onSelect, onManage }: {
  room: ChannelRoom; selected: boolean; voice?: boolean; sharing?: boolean; watching?: boolean;
  sourceCount?: number; settingsOpen?: boolean; unread?: boolean; onSelect(): void; onManage(): void;
  participantDisclosure?: { open: boolean; count: number; controls: string; onToggle(): void };
}) {
  const { lang } = useCopy();
  const unreadId = useId();
  const settingsLabel = lang === "zh" ? `${room.name}的房间设置` : `Settings for ${room.name}`;
  return <div className="c3-room-item" data-selected={selected || undefined} data-unread={unread || undefined} data-settings-open={settingsOpen || undefined}>
    {participantDisclosure && <span className="c3-room-voice-toggle lr-embedded-actions">
      <Btn icon="chevron" size="dense" quiet hint="hint-collapse"
        title={{ text: lang === "zh" ? `${participantDisclosure.open ? "收起" : "展开"}参与者（${participantDisclosure.count}人）` : `${participantDisclosure.open ? "Hide" : "Show"} participants (${participantDisclosure.count})` }}
        expanded={participantDisclosure.open} controls={participantDisclosure.controls} onClick={participantDisclosure.onToggle} />
    </span>}
    <Tooltip className="c3-room-label" overflow={{ text: room.name, selector: "strong" }}>
      <button type="button" className="lr-btn is-quiet c3-room-link" aria-label={room.name}
        aria-describedby={unread ? unreadId : undefined}
        aria-current={selected ? "page" : undefined} onClick={onSelect}>
        <ChannelIdentityMark icon={room.icon} size={21} />
        <strong>{room.name}</strong>
        <span className="c3-room-activity" aria-hidden="true">
          {room.access === "private" && <Glyph name="lock" size={13} />}
          {voice && <Glyph name="headphones" size={14} />}
          {sharing ? <Glyph name="cast" size={14} /> : watching ? <Glyph name="eye" size={14} />
            : sourceCount > 0 ? <span>{sourceCount}<Glyph name="tv" size={13} /></span> : null}
        </span>
      </button>
    </Tooltip>
    {unread && <span id={unreadId} className="c3-room-unread-label">{lang === "zh" ? "有未读消息" : "Unread messages"}</span>}
    {(room.authorized || room.canManage) && <span className="c3-room-manage">
      <Btn icon="sliders" size="dense" quiet title={{ text: settingsLabel }} hint="hint-advanced"
        expanded={settingsOpen} hasPopup="dialog" tone={settingsOpen ? "on" : undefined} onClick={onManage} />
    </span>}
  </div>;
}
