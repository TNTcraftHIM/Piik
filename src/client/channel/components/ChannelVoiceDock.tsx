import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { VoiceListeningButton, VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import type { ChannelController } from "../types";
import { profileAvatar, roomVoicePeople } from "../presentation";
import { ChannelVoiceSettings } from "./ChannelVoiceSettings";
import { useCallback } from "react";
import { useVoiceLevels } from "../../room-voice/use-voice-levels";
import { resolveVoiceDockControls } from "../voice-dock-controls";
import { useVoiceShortcuts } from "../use-voice-shortcuts";
import { voiceShortcutAria } from "../voice-shortcut-binding";

/** One persistent control surface for this endpoint's independently joined rooms. */
export function ChannelVoiceDock({ channel, selected, onSelect, onBrowse }: {
  channel: ChannelController; selected: string; onSelect: (id: string) => void; onBrowse: (id: string) => void;
}) {
  const { t } = useCopy();
  const state = channel.state;
  const { joined, activity, microphoneDisabled, toggle } = resolveVoiceDockControls(channel, selected);
  const shortcuts = useVoiceShortcuts(activity?.roomId, toggle,
    channel.connection === "connected" ? channel.backgroundVoiceShortcuts : undefined);
  const roomId = activity?.roomId ?? "";
  const readLevels = useCallback(() => channel.voiceActivity(roomId), [channel.voiceActivity, roomId]);
  const levels = useVoiceLevels(readLevels, !!activity);
  if (!activity || !state) return null;
  const nameOfRoom = (id: string) => state.channel.rooms.find(room => room.id === id)?.name ?? id;
  const { muted, deafened } = activity;
  const available = channel.connection === "connected" && !!state.channel.rooms.find(room => room.id === roomId)?.available;
  const appearances = roomVoicePeople(state, roomId, levels);
  const participants = state.users.filter(user => appearances.has(user.id));
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  return <section className="c3-voice-dock" aria-label={t("channel.voiceDock.voiceControls")}>
    <Glyph name="headphones" size={22} />
    <div className="c3-voice-destination">
      <div className="c3-voice-room-info">
        <small>{t("channel.voiceDock.voiceJoined")}</small>
        <Tooltip className="c3-voice-room" overflow={{ text: nameOfRoom(roomId), selector: "button, select" }}>
        {joined.length === 1 ? <button type="button" onClick={() => onBrowse(roomId)}>{nameOfRoom(roomId)}</button>
          : <select className="lr-select" aria-label={t("channel.voiceDock.selectRoom")} value={roomId}
            onChange={event => onSelect(event.target.value)}>
            {joined.map(value => <option key={value.roomId} value={value.roomId}>{nameOfRoom(value.roomId)}</option>)}
          </select>}
        </Tooltip>
      </div>
      <ChannelVoiceSettings channel={channel} roomId={roomId} available={available} shortcuts={shortcuts} />
    </div>
    <div className="c3-voice-participants" aria-label={t("channel.voiceDock.voiceParticipants")}>
      {participants.slice(0, 4).map(user => {
        const avatar = profileAvatar(user, channel.profiles.get(user.id)) ?? undefined;
        const voice = appearances.get(user.id)!;
        return <Tooltip key={user.id}
          kind={voice.deafened ? "hint-voice-deafen" : voice.microphone ? "hint-voice-microphone-on" : "hint-voice-microphone-off"} text={user.name}>
          <span aria-label={user.name}><PawnSvg color={participantColor(user.id)} identity={user.id} avatar={avatar} voice={voice} /></span>
        </Tooltip>;
      })}
      {participants.length > 4 && <small>+{participants.length - 4}</small>}
    </div>
    <div className="c3-voice-controls">
      <AudioVolumeMenu volume={channel.voiceInput.volume} onVolume={channel.setInputVolume} label="host.microphone.volume">
        <VoiceMicrophoneButton active={!muted} level={levels.get(channel.sessionId ?? "")} disabled={microphoneDisabled} quiet
          keyShortcuts={voiceShortcutAria(shortcuts.bindings.microphone)} onClick={() => toggle("microphone")} />
      </AudioVolumeMenu>
      <AudioVolumeMenu volume={channel.listeningVolume} onVolume={channel.setListeningVolume} label="voice.listeningVolume">
        <VoiceListeningButton deafened={deafened} quiet
          keyShortcuts={voiceShortcutAria(shortcuts.bindings.listening)} onClick={() => toggle("listening")} />
      </AudioVolumeMenu>
      <Btn icon="door" title="voice.leave" hint="hint-voice-leave" draw="voice-membership" size="compact" quiet
        onClick={() => run(channel.leaveVoice(roomId))} />
    </div>
  </section>;
}
