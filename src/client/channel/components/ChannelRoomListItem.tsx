import { useId, useState } from "react";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelRoomItem } from "./ChannelRoomItem";
import { ChannelRoomVoiceMembers } from "./ChannelRoomVoiceMembers";

/** Folding the voice roster changes its presentation, never voice membership. */
export function ChannelRoomListItem({ channel, room, selected, settingsOpen, onSelect, onManage }: {
  channel: ChannelController; room: ChannelRoom; selected: boolean; settingsOpen: boolean;
  onSelect(): void; onManage(): void;
}) {
  const [open, setOpen] = useState(true), id = useId();
  const state = channel.state;
  const voices = state?.voice.filter(voice => voice.roomId === room.id) ?? [];
  const voiceUsers = new Set(voices.flatMap(voice => state?.sessions.filter(session => session.id === voice.sessionId).map(session => session.userId) ?? []));
  const screens = state?.publications.filter(source => source.roomId === room.id && source.kind === "screen") ?? [];
  return <div className="c3-room-list-item">
      <ChannelRoomItem room={room} selected={selected} settingsOpen={settingsOpen}
        voiceDisclosure={voiceUsers.size ? { open, count: voiceUsers.size, controls: id, onToggle: () => setOpen(!open) } : undefined}
        voice={voices.some(voice => voice.sessionId === channel.sessionId)} screenCount={screens.length}
        sharing={screens.some(source => channel.ownedScreens.has(source.id))}
        watching={screens.some(source => state?.subscriptions.includes(source.id) && !channel.ownedScreens.has(source.id))}
        onSelect={onSelect} onManage={onManage} />
    <div id={id} hidden={!open}><ChannelRoomVoiceMembers channel={channel} room={room} /></div>
  </div>;
}
