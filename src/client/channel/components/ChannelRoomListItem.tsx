import { useId, useState } from "react";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelRoomItem } from "./ChannelRoomItem";
import { ChannelRoomParticipants } from "./ChannelRoomParticipants";
import { roomRealtimePeople } from "../presentation";

/** Folding the participant roster changes presentation, never room activities. */
export function ChannelRoomListItem({ channel, room, selected, settingsOpen, onSelect, onManage }: {
  channel: ChannelController; room: ChannelRoom; selected: boolean; settingsOpen: boolean;
  onSelect(): void; onManage(): void;
}) {
  const [open, setOpen] = useState(true), id = useId();
  const state = channel.state;
  const voices = state?.voice.filter(voice => voice.roomId === room.id) ?? [];
  const people = state ? roomRealtimePeople(state, room.id) : [];
  const screens = state?.publications.filter(source => source.roomId === room.id && source.kind === "screen") ?? [];
  return <div className="c3-room-list-item">
      <ChannelRoomItem room={room} selected={selected} settingsOpen={settingsOpen}
        participantDisclosure={people.length ? { open, count: people.length, controls: id, onToggle: () => setOpen(!open) } : undefined}
        voice={voices.some(voice => voice.sessionId === channel.sessionId)} screenCount={screens.length}
        sharing={screens.some(source => channel.ownedScreens.has(source.id))}
        watching={screens.some(source => state?.subscriptions.includes(source.id) && !channel.ownedScreens.has(source.id))}
        onSelect={onSelect} onManage={onManage} />
    <div id={id} hidden={!open}><ChannelRoomParticipants channel={channel} room={room} /></div>
  </div>;
}
