import { listeningVoicePublications, type roomActivityPeople } from "../presentation";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelUser } from "./ChannelUser";

/** Real-time participants come from the room, not the browsed conversation. */
export function ChannelRoomParticipants({ channel, room, people }: { channel: ChannelController; room: ChannelRoom; people: ReturnType<typeof roomActivityPeople> }) {
  const { state } = channel;
  const { t } = useCopy();
  if (!state || !people.length) return null;
  const audible = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams)
    .filter(source => source.roomId === room.id).map(source => source.userId));
  return <div className="c3-room-participants" role="group" aria-label={t("channel.roomParticipants.activity")}>
    <small className="c3-room-participants-label">{t("channel.roomParticipants.activity")}</small>
    {people.map(user => <ChannelUser key={user.id} id={user.id} name={user.name} avatar={user.avatar ?? undefined}
      self={user.id === channel.self?.id} owner={false} online={state.sessions.some(session => session.userId === user.id && session.online)}
      roomActivity={user} voicePlayback={audible.has(user.id) ? channel : undefined} />)}
  </div>;
}
