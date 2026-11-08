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
import { ChannelVoiceSettings } from "./ChannelVoiceSettings";
import { useCallback } from "react";
import { useVoiceLevels } from "../../room-voice/use-voice-levels";

/** One persistent control surface for this endpoint's independently joined rooms. */
export function ChannelVoiceDock({ channel, selected, onSelect, onBrowse }: {
  channel: ChannelController; selected: string; onSelect: (id: string) => void; onBrowse: (id: string) => void;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const state = channel.state;
  const joined = state?.voice.filter(value => value.sessionId === channel.sessionId) ?? [];
  const activity = joined.find(value => value.roomId === selected) ?? joined[0];
  const roomId = activity?.roomId ?? "";
  const readLevels = useCallback(() => channel.voiceActivity(roomId), [channel.voiceActivity, roomId]);
  const levels = useVoiceLevels(readLevels, !!activity);
  if (!activity || !state) return null;
  const nameOfRoom = (id: string) => state.channel.rooms.find(room => room.id === id)?.name ?? id;
  const { muted, deafened } = activity;
  const available = channel.connection === "connected" && !!state.channel.rooms.find(room => room.id === roomId)?.available;
  const participants = state.users.flatMap(user => {
    const appearance = voiceAppearance(state, user.id, roomId);
    const endpoints = state.sessions.filter(session => session.userId === user.id).map(session => session.id);
    const values = state.voice.filter(voice => voice.roomId === roomId && !voice.muted && endpoints.includes(voice.sessionId))
      .flatMap(voice => levels.has(voice.sessionId) ? [levels.get(voice.sessionId)!] : []);
    return appearance ? [{ user, ...appearance, level: values.length ? Math.max(...values) : undefined }] : [];
  });
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  return <section className="c3-voice-dock" aria-label={zh ? "语音控制" : "Voice controls"}>
    <Glyph name="headphones" size={22} />
    <div className="c3-voice-destination">
      <small>{zh ? "语音已加入" : "Voice joined"}</small>
      <Tooltip className="c3-voice-room" overflow={{ text: nameOfRoom(roomId), selector: "button, select" }}>
      {joined.length === 1 ? <button type="button" onClick={() => onBrowse(roomId)}>{nameOfRoom(roomId)}</button>
        : <select aria-label={zh ? "选择要控制的语音房间" : "Choose a voice room to control"} value={roomId}
          onChange={event => onSelect(event.target.value)}>
          {joined.map(value => <option key={value.roomId} value={value.roomId}>{nameOfRoom(value.roomId)}</option>)}
        </select>}
      </Tooltip>
    </div>
    <div className="c3-voice-participants" aria-label={zh ? "当前语音用户" : "Voice participants"}>
      {participants.slice(0, 4).map(({ user, ...voice }) => <Tooltip key={user.id}
        kind={voice.deafened ? "hint-voice-deafen" : voice.microphone ? "hint-voice-microphone-on" : "hint-voice-microphone-off"} text={user.name}>
        <span aria-label={user.name}><PawnSvg color={participantColor(user.id)} identity={user.id} voice={voice} /></span>
      </Tooltip>)}
      {participants.length > 4 && <small>+{participants.length - 4}</small>}
    </div>
    <div className="c3-voice-controls">
      <AudioVolumeMenu volume={channel.voiceInput.volume} onVolume={channel.setInputVolume} label="host.microphone.volume" icon="microphone">
        <VoiceMicrophoneButton active={!muted} level={levels.get(channel.sessionId ?? "")} disabled={muted && !channel.canUnmute(roomId)} quiet
          onClick={() => run(channel.setMuted(roomId, !muted))} />
      </AudioVolumeMenu>
      <AudioVolumeMenu volume={channel.listeningVolume} onVolume={channel.setListeningVolume} label="voice.listeningVolume" icon="headphones">
        <VoiceListeningButton deafened={deafened} quiet
          onClick={() => run(channel.setDeafened(roomId, !deafened))} />
      </AudioVolumeMenu>
      <ChannelVoiceSettings channel={channel} roomId={roomId} available={available} />
      <span className="c3-control-divider" />
      <Btn icon="door" title="voice.leave" hint="hint-voice-leave" draw="voice-membership" size="compact" quiet
        onClick={() => run(channel.leaveVoice(roomId))} />
    </div>
  </section>;
}
