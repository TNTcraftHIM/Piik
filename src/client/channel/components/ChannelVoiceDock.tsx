import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { VoiceListeningButton, VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import type { ChannelController } from "../types";
import { voiceAppearance } from "../presentation";

/** One persistent control surface for this endpoint's independently joined rooms. */
export function ChannelVoiceDock({ channel, selected, onSelect, onBrowse }: {
  channel: ChannelController; selected: string; onSelect: (id: string) => void; onBrowse: (id: string) => void;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const state = channel.state;
  const joined = state?.voice.filter(value => value.sessionId === channel.sessionId) ?? [];
  const activity = joined.find(value => value.roomId === selected) ?? joined[0];
  if (!activity || !state) return null;
  const nameOfRoom = (id: string) => state.channel.rooms.find(room => room.id === id)?.name ?? id;
  const { roomId, muted, deafened } = activity;
  const available = channel.connection === "connected" && !!state.channel.rooms.find(room => room.id === roomId)?.available;
  const participants = state.users.flatMap(user => {
    const appearance = voiceAppearance(state, user.id, roomId);
    return appearance ? [{ user, ...appearance }] : [];
  });
  const busy = channel.pending.has(`voice:${roomId}`);
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  return <section className="c3-voice-dock" aria-label={zh ? "语音控制" : "Voice controls"}>
    <Glyph name="headphones" size={22} />
    <div className="c3-voice-destination">
      <small>{zh ? "语音已加入" : "Voice joined"}</small>
      {joined.length === 1 ? <button type="button" onClick={() => onBrowse(roomId)}>{nameOfRoom(roomId)}</button>
        : <select aria-label={zh ? "选择要控制的语音房间" : "Choose a voice room to control"} value={roomId}
          onChange={event => onSelect(event.target.value)}>
          {joined.map(value => <option key={value.roomId} value={value.roomId}>{nameOfRoom(value.roomId)}</option>)}
        </select>}
    </div>
    <div className="c3-voice-participants" aria-label={zh ? "当前语音用户" : "Voice participants"}>
      {participants.slice(0, 4).map(({ user, ...voice }) => <Tooltip key={user.id}
        kind={voice.deafened ? "hint-voice-deafen" : voice.microphone ? "hint-voice-microphone-on" : "hint-voice-microphone-off"} text={user.name}>
        <span aria-label={user.name}><PawnSvg color={participantColor(user.id)} identity={user.id} voice={voice} /></span>
      </Tooltip>)}
      {participants.length > 4 && <small>+{participants.length - 4}</small>}
    </div>
    <div className="c3-voice-controls">
      <AudioVolumeMenu volume={channel.inputVolume} onVolume={channel.setInputVolume} label="host.microphone.volume" icon="microphone">
        <VoiceMicrophoneButton active={!muted} disabled={!available} busy={busy} quiet
          onClick={() => run(channel.setMuted(roomId, !muted))} />
      </AudioVolumeMenu>
      <AudioVolumeMenu volume={channel.listeningVolume} onVolume={channel.setListeningVolume} label="voice.listeningVolume" icon="headphones">
        <VoiceListeningButton deafened={deafened} disabled={!available} busy={busy} quiet
          onClick={() => run(channel.setDeafened(roomId, !deafened))} />
      </AudioVolumeMenu>
      <span className="c3-control-divider" />
      <Btn icon="door" title="voice.leave" hint="hint-voice-leave" draw="voice-membership" size="compact" quiet
        busy={busy} disabled={busy} onClick={() => run(channel.leaveVoice(roomId))} />
    </div>
  </section>;
}
