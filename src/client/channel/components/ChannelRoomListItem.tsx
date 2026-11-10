import { useId, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelRoomItem } from "./ChannelRoomItem";
import { ChannelRoomVoiceMembers } from "./ChannelRoomVoiceMembers";

/** Folding the voice roster changes its presentation, never voice membership. */
export function ChannelRoomListItem({ channel, room, selected, settingsOpen, onSelect, onManage }: {
  channel: ChannelController; room: ChannelRoom; selected: boolean; settingsOpen: boolean;
  onSelect(): void; onManage(): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const [open, setOpen] = useState(true), id = useId();
  const state = channel.state;
  const voices = state?.voice.filter(voice => voice.roomId === room.id) ?? [];
  const voiceUsers = new Set(voices.flatMap(voice => state?.sessions.filter(session => session.id === voice.sessionId).map(session => session.userId) ?? []));
  const screens = state?.publications.filter(source => source.roomId === room.id && source.kind === "screen") ?? [];
  return <div className="c3-room-list-item">
    <div className="c3-room-list-heading">
      {voiceUsers.size > 0 && <span className="c3-room-voice-toggle"><Btn icon="chevron" size="dense" quiet hint="hint-collapse" controls={id} expanded={open}
        title={{ text: zh ? `${open ? "收起" : "展开"}语音成员（${voiceUsers.size}人）` : `${open ? "Hide" : "Show"} voice participants (${voiceUsers.size})` }}
        onClick={() => setOpen(!open)} /></span>}
      <ChannelRoomItem room={room} selected={selected} settingsOpen={settingsOpen}
        voice={voices.some(voice => voice.sessionId === channel.sessionId)} screenCount={screens.length}
        sharing={screens.some(source => channel.ownedScreens.has(source.id))}
        watching={screens.some(source => state?.subscriptions.includes(source.id) && !channel.ownedScreens.has(source.id))}
        onSelect={onSelect} onManage={onManage} />
    </div>
    <div id={id} hidden={!open}><ChannelRoomVoiceMembers channel={channel} room={room} /></div>
  </div>;
}
