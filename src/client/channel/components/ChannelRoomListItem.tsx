import { useEffect, useId, useState } from "react";
import { Glyph } from "../../ui/icons";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelRoomItem } from "./ChannelRoomItem";
import { ChannelUser } from "./ChannelUser";
import { roomHasUnread, roomPeople, roomSessionViewing } from "../presentation";

const MAX_FACES = 4;

/** Room presence shares its identity projection with the couch. */
export function ChannelRoomListItem({ channel, room, selected, settingsOpen, unopened, onSelect, onManage, ordering, compact = false }: {
  channel: ChannelController; room: ChannelRoom; selected: boolean; settingsOpen: boolean; unopened?: boolean; compact?: boolean;
  onSelect(): void; onManage(): void;
  ordering?: { index: number; total: number; onMove(direction: -1 | 1): void; onDrag(): void; onDrop(): void; onEnd(): void; active: boolean };
}) {
  const { t } = useCopy();
  const [peopleOpen, setPeopleOpen] = useState(false);
  const id = useId();
  const state = channel.state;
  const voices = state?.voice.filter(voice => voice.roomId === room.id) ?? [];
  const present = state && !ordering && room.authorized && room.available
    ? roomPeople(state, room.id, channel.profiles, channel) : [];
  const shownFaces = present.length > MAX_FACES ? MAX_FACES - 1 : present.length;
  const showPeople = !compact && present.length > 0;
  const screens = state?.publications.filter(source => source.roomId === room.id && source.kind === "screen") ?? [];
  const watches = state?.watchActivities.filter(source => source.roomId === room.id) ?? [];
  const [over, setOver] = useState(false);
  useEffect(() => { if (!ordering?.active) setOver(false); }, [ordering?.active]);
  useEffect(() => { if (!showPeople) setPeopleOpen(false); }, [showPeople]);
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
        unread={roomHasUnread(room, channel.readByRoom[room.id])} unopened={unopened}
        compact={compact} participantCount={compact ? present.length : undefined}
        participantDisclosure={showPeople ? { open: peopleOpen, count: present.length, controls: id, onToggle: () => setPeopleOpen(value => !value) } : undefined}
        peopleFaces={present.length ? <span className="c3-room-faces" aria-hidden="true">
          {present.slice(0, shownFaces).map(person => <PawnSvg key={person.userId} centered color={participantColor(person.userId)}
            identity={person.userId} avatar={person.avatar} />)}
          {present.length > shownFaces && <span>+{present.length - shownFaces}</span>}
        </span> : undefined}
        voice={voices.some(voice => voice.sessionId === channel.sessionId)} sourceCount={screens.length + watches.length}
        sharing={screens.some(source => channel.ownedScreens.has(source.id)) || watches.some(source => source.sessionId === channel.sessionId)}
        viewing={state && room.authorized && room.available ? roomSessionViewing(screens, watches, state.subscriptions, channel) : undefined}
        onSelect={onSelect} onManage={onManage} />
    {showPeople && <div id={id} className="c3-room-people" role="group" aria-label={room.name} hidden={!peopleOpen}>
      {peopleOpen && present.map(person => <ChannelUser key={person.userId} id={person.userId} name={person.name} avatar={person.avatar}
        self={person.userId === channel.self?.id} owner={person.owner} online />)}
    </div>}
  </div>;
}
