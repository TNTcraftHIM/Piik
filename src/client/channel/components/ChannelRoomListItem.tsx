import { useEffect, useId, useState } from "react";
import { Glyph } from "../../ui/icons";
import { joinItems, useCopy } from "../../ui/copy";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelRoomItem } from "./ChannelRoomItem";
import { ChannelRoomParticipants } from "./ChannelRoomParticipants";
import { ChannelUser } from "./ChannelUser";
import { roomActivityPeople, roomHasUnread, roomPeople, roomSessionViewing } from "../presentation";

/** As many faces as fit beside a room's name. With more people, the last place is given to the count of the rest. */
const PILE_FACES = 4;

/** Folding the participant roster changes presentation, never room activities. */
export function ChannelRoomListItem({ channel, room, selected, settingsOpen, unopened, onSelect, onManage, ordering, pile = false, nameHint = false }: {
  channel: ChannelController; room: ChannelRoom; selected: boolean; settingsOpen: boolean; unopened?: boolean;
  /** Show the people present as a few faces. The row's disclosure lists who is in the room, and nothing about what they do. */
  pile?: boolean;
  /** The list is folded to a rail: the room name appears on hover and focus. */
  nameHint?: boolean;
  onSelect(): void; onManage(): void;
  ordering?: { index: number; total: number; onMove(direction: -1 | 1): void; onDrag(): void; onDrop(): void; onEnd(): void; active: boolean };
}) {
  const { t, lang } = useCopy();
  const [open, setOpen] = useState(!pile), id = useId();
  const state = channel.state;
  const voices = state?.voice.filter(voice => voice.roomId === room.id) ?? [];
  const people = state && !ordering && !pile ? roomActivityPeople(state, room.id, channel.profiles, channel) : [];
  const present = state && pile && room.authorized ? roomPeople(state, room.id, channel.profiles, channel) : [];
  const screens = state?.publications.filter(source => source.roomId === room.id && source.kind === "screen") ?? [];
  const watches = state?.watchActivities.filter(source => source.roomId === room.id) ?? [];
  const [over, setOver] = useState(false);
  const shown = present.length > PILE_FACES ? PILE_FACES - 1 : present.length;
  const names = joinItems(lang, present.map(person => person.name));
  const faces = <>
    {present.slice(0, shown).map(person => <PawnSvg key={person.userId} centered color={participantColor(person.userId)} identity={person.userId} avatar={person.avatar} />)}
    {present.length > shown && <span aria-hidden="true">+{present.length - shown}</span>}
  </>;
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
      <ChannelRoomItem room={room} selected={selected} settingsOpen={settingsOpen} nameHint={nameHint}
        unread={roomHasUnread(room, channel.readByRoom[room.id])} unopened={unopened}
        participantDisclosure={(pile ? !nameHint && present.length : people.length) ? { open, count: (pile ? present : people).length, controls: id, onToggle: () => setOpen(!open) } : undefined}
        voice={voices.some(voice => voice.sessionId === channel.sessionId)} sourceCount={screens.length + watches.length}
        sharing={screens.some(source => channel.ownedScreens.has(source.id)) || watches.some(source => source.sessionId === channel.sessionId)}
        viewing={state && room.authorized && room.available ? roomSessionViewing(screens, watches, state.subscriptions, channel) : undefined}
        onSelect={onSelect} onManage={onManage} />
    {pile ? present.length > 0 && <>
      {/* The faces are a picture of who is there. Beside a control they would read as a way in. */}
      <span className="c3-room-pile" role="img" aria-label={names}>{faces}</span>
      {!nameHint && <div id={id} className="c3-room-people" role="group" aria-label={names} hidden={!open}>
        {open && present.map(person => <ChannelUser key={person.userId} id={person.userId} name={person.name} avatar={person.avatar}
          self={person.userId === channel.self?.id} owner={!!person.owner}
          // Someone still in voice or sharing is listed after their last page went offline, and is shown as offline.
          online={state!.sessions.some(session => session.userId === person.userId && session.online)} />)}
      </div>}
    </>
      : <div id={id} hidden={!open}>{open && people.length > 0 && <ChannelRoomParticipants channel={channel} room={room} people={people} />}</div>}
  </div>;
}
