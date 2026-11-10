import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { ChannelRoom } from "../protocol";
import { ChannelIdentityMark } from "./ChannelIdentity";
import "./channel-room-item.css";

/** Room navigation and room management are separate actions on the same item. */
export function ChannelRoomItem({ room, selected, voice = false, sharing = false, watching = false,
  screenCount = 0, settingsOpen = false, voiceDisclosure, onSelect, onManage }: {
  room: ChannelRoom; selected: boolean; voice?: boolean; sharing?: boolean; watching?: boolean;
  screenCount?: number; settingsOpen?: boolean; onSelect(): void; onManage(): void;
  voiceDisclosure?: { open: boolean; count: number; controls: string; onToggle(): void };
}) {
  const { lang, vis } = useCopy();
  const settingsLabel = lang === "zh" ? `${room.name}的房间设置` : `Settings for ${room.name}`;
  return <div className="c3-room-item" data-selected={selected || undefined} data-settings-open={settingsOpen || undefined}>
    {voiceDisclosure && <span className="c3-room-voice-toggle"><Tooltip kind="hint-collapse"
      text={lang === "zh" ? `${voiceDisclosure.open ? "收起" : "展开"}语音成员（${voiceDisclosure.count}人）` : `${voiceDisclosure.open ? "Hide" : "Show"} voice participants (${voiceDisclosure.count})`}>
      <button type="button" className="lr-btn is-dense is-quiet" aria-expanded={voiceDisclosure.open} aria-controls={voiceDisclosure.controls}
        aria-label={lang === "zh" ? "折叠语音名单" : "Toggle voice participants"} onClick={voiceDisclosure.onToggle}><Glyph name="chevron" size={12} /></button>
    </Tooltip></span>}
    <Tooltip className="c3-room-label" overflow={{ text: room.name, selector: "strong" }}>
      <button type="button" className="lr-btn is-quiet c3-room-link" aria-label={room.name}
        aria-current={selected ? "page" : undefined} onClick={onSelect}>
        <ChannelIdentityMark icon={room.icon} size={21} />
        <strong>{room.name}</strong>
        <span className="c3-room-activity" aria-hidden="true">
          {room.access === "private" && <Glyph name="lock" size={13} />}
          {voice && <Glyph name="headphones" size={14} />}
          {sharing ? <Glyph name="cast" size={14} /> : watching ? <Glyph name="eye" size={14} />
            : screenCount > 0 ? <span>{screenCount}<Glyph name="tv" size={13} /></span> : null}
        </span>
      </button>
    </Tooltip>
    {(room.authorized || room.canManage) && <span className="c3-room-manage">
      <Tooltip kind="hint-advanced" text={vis ? undefined : settingsLabel} disabled={settingsOpen}>
        <button type="button" className="lr-btn is-dense is-quiet" data-room-settings={room.id}
          aria-label={settingsLabel} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={onManage}>
          <Glyph name="sliders" size={16} />
        </button>
      </Tooltip>
    </span>}
  </div>;
}
