import { useEffect, useId, useState } from "react";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelRoomItem } from "./ChannelRoomItem";
import { ChannelRoomParticipants } from "./ChannelRoomParticipants";
import { roomActivityPeople, roomSessionViewing } from "../presentation";

/** Folding the participant roster changes presentation, never room activities. */
export function ChannelRoomListItem({ channel, room, selected, settingsOpen, onSelect, onManage, ordering }: {
  channel: ChannelController; room: ChannelRoom; selected: boolean; settingsOpen: boolean;
  onSelect(): void; onManage(): void;
  ordering?: { index: number; total: number; onMove(direction: -1 | 1): void; onDrag(): void; onDrop(): void; onEnd(): void; active: boolean };
}) {
  const { t } = useCopy();
  const [open, setOpen] = useState(true), id = useId();
  const state = channel.state;
  const voices = state?.voice.filter(voice => voice.roomId === room.id) ?? [];
  const people = state && !ordering ? roomActivityPeople(state, room.id, channel.profiles, channel) : [];
  const screens = state?.publications.filter(source => source.roomId === room.id && source.kind === "screen") ?? [];
  const watches = state?.watchActivities.filter(source => source.roomId === room.id) ?? [];
  const [over, setOver] = useState(false);
  useEffect(() => { if (!ordering?.active) setOver(false); }, [ordering?.active]);
  return <div className="c3-room-list-item" data-ordering={!!ordering || undefined} data-drop={over && ordering?.active || undefined}
    onDragOver={event => { if (ordering?.active) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
    onDrop={event => { if (ordering?.active) { event.preventDefault(); ordering.onDrop(); setOver(false); } }}>
      {ordering && <div className="c3-room-order-controls">
        <button type="button" className="lr-btn is-dense is-quiet" draggable aria-keyshortcuts="ArrowUp ArrowDown" aria-describedby="c3-room-order-help"
          aria-label={t("room.order.move", { name: room.name, position: String(ordering.index + 1), total: String(ordering.total) })}
          onDragStart={event => { event.dataTransfer.setData("text/plain", room.id); event.dataTransfer.effectAllowed = "move"; ordering.onDrag(); }}
          onDragEnd={() => { setOver(false); ordering.onEnd(); }}
          onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); ordering.onMove(event.key === "ArrowUp" ? -1 : 1); } }}><Glyph name="grip" size={16} /></button>
        <button type="button" className="lr-btn is-dense is-quiet" disabled={ordering.index === 0} aria-label={t("room.order.up", { name: room.name })}
          onClick={() => ordering.onMove(-1)}><Glyph name="arrowUp" size={14} /></button>
        <button type="button" className="lr-btn is-dense is-quiet" disabled={ordering.index === ordering.total - 1} aria-label={t("room.order.down", { name: room.name })}
          onClick={() => ordering.onMove(1)}><Glyph name="arrowDown" size={14} /></button>
      </div>}
      <ChannelRoomItem room={room} selected={selected} settingsOpen={settingsOpen}
        unread={room.authorized && room.lastMessageSeq > (channel.readByRoom[room.id] ?? room.lastMessageSeq)}
        participantDisclosure={people.length ? { open, count: people.length, controls: id, onToggle: () => setOpen(!open) } : undefined}
        voice={voices.some(voice => voice.sessionId === channel.sessionId)} sourceCount={screens.length + watches.length}
        sharing={screens.some(source => channel.ownedScreens.has(source.id)) || watches.some(source => source.sessionId === channel.sessionId)}
        viewing={state && room.authorized && room.available ? roomSessionViewing(screens, watches, state.subscriptions, channel) : undefined}
        onSelect={onSelect} onManage={onManage} />
    <div id={id} hidden={!open}>{open && people.length > 0 && <ChannelRoomParticipants channel={channel} room={room} people={people} />}</div>
  </div>;
}
