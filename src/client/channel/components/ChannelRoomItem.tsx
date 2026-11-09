import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { ChannelRoom } from "../protocol";
import { ChannelIdentityMark } from "./ChannelIdentity";
import "./channel-room-item.css";

/** Room navigation and room management are separate actions on the same item. */
export function ChannelRoomItem({ room, selected, voice = false, sharing = false, watching = false,
  screenCount = 0, settingsOpen = false, onSelect, onManage }: {
  room: ChannelRoom; selected: boolean; voice?: boolean; sharing?: boolean; watching?: boolean;
  screenCount?: number; settingsOpen?: boolean; onSelect(): void; onManage(): void;
}) {
  const { lang, vis } = useCopy();
  const settingsLabel = lang === "zh" ? `${room.name}的房间设置` : `Settings for ${room.name}`;
  return <div className="c3-room-item" data-selected={selected || undefined} data-settings-open={settingsOpen || undefined}>
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
