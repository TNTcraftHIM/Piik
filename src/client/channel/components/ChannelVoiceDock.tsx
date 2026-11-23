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
import { useCallback, useContext, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { RoomChatOverlay, RoomChatOverlaySettings, RoomChatToggle } from "../../components/living/RoomChatOverlay";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { SurfaceDocument } from "../../ui/panel-window";
import { VoiceOverlay } from "./voice-overlay";
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
  const overlay = useContext(VoiceOverlay);
  const readRemote = !!overlay?.target && !activity?.deafened;
  const readLevels = useCallback(() => channel.voiceActivity(roomId, !readRemote), [channel.voiceActivity, roomId, readRemote]);
  const levels = useVoiceLevels(readLevels, !!activity && (!activity.muted || readRemote), overlay?.target?.ownerDocument);
  useEffect(() => { if (!activity && overlay?.target) overlay.close(); }, [activity, overlay]);
  if (!activity || !state) return null;
  const nameOfRoom = (id: string) => state.channel.rooms.find(room => room.id === id)?.name ?? id;
  const interaction = channel.interactionsByRoom.get(roomId) ?? null;
  const roomName = nameOfRoom(roomId);
  const multipleRooms = joined.length > 1;
  const { muted, deafened } = activity;
  const available = channel.connection === "connected" && !!state.channel.rooms.find(room => room.id === roomId)?.available;
  const appearances = overlay?.target ? roomVoicePeople(state, roomId, levels) : null;
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  const speaking = appearances ? state.users.filter(user => (appearances.get(user.id)?.level ?? 0) > .01) : [];
  return <section className="c3-voice-dock" aria-label={t("channel.voiceDock.voiceControls")}>
    <Glyph name="headphones" size={22} />
    <div className="c3-voice-destination">
      <div className="c3-voice-room-info">
        <small>{t("channel.voiceDock.voiceJoined")}</small>
        <div className="c3-voice-room-choice">
          <Tooltip className="c3-voice-room" overflow={{ text: roomName, selector: "button, select" }}>
            {multipleRooms ? <select className="lr-select" aria-label={t("channel.voiceDock.selectRoom")} value={roomId}
              onChange={event => onSelect(event.target.value)}>
              {joined.map(value => <option key={value.roomId} value={value.roomId}>{nameOfRoom(value.roomId)}</option>)}
            </select> : <button type="button" onClick={() => onBrowse(roomId)}>{roomName}</button>}
          </Tooltip>
          {multipleRooms && <Btn icon="arrowRight" size="compact" quiet textTooltip
            title={{ text: t("channel.voiceDock.openRoom", { name: roomName }) }}
            onClick={() => onBrowse(roomId)} />}
        </div>
      </div>
      <ChannelVoiceSettings channel={channel} roomId={roomId} available={available} shortcuts={shortcuts} />
    </div>
    {overlay?.target && createPortal(<SurfaceDocument.Provider value={overlay.target.ownerDocument}>
      <div className="c3-speaking-overlay">
        <div className="c3-speaking-overlay-header">
          <strong title={roomName}>{roomName}</strong>
          <span role="img" aria-label={t(muted ? "voice.microphoneInactive" : "voice.microphoneActive")}>
            <Glyph name={muted ? "microphoneOff" : "microphone"} size={16} />
          </span>
          <span role="img" aria-label={t(deafened ? "voice.listeningPaused" : "voice.listeningActive")}>
            <Glyph name={deafened ? "headphonesOff" : "headphones"} size={16} />
          </span>
          {speaking.length > 4 && <small>+{speaking.length - 4}</small>}
          {overlay.mode === "editing" && interaction && <VoiceOverlayChatSettings key={interaction.key} session={interaction} />}
          {overlay.mode === "editing" && <Btn icon="check" size="compact" quiet title="channel.voiceDock.pinOverlay" onClick={overlay.edit} />}
        </div>
        <div className="c3-speaking-overlay-people">
          {speaking.slice(0, 4).map(user => <div key={user.id}>
            <PawnSvg centered color={participantColor(user.id)} identity={user.id}
              avatar={profileAvatar(user, channel.profiles.get(user.id)) ?? undefined} voice={appearances?.get(user.id)} />
            <span title={user.name}>{user.name}</span>
          </div>)}
        </div>
        <div className="c3-speaking-overlay-chat">
          <RoomChatOverlay session={interaction} visible />
        </div>
      </div>
    </SurfaceDocument.Provider>, overlay.target)}
    <div className="c3-voice-controls">
      <AudioVolumeMenu volume={channel.voiceInput.volume} onVolume={channel.setInputVolume} label="host.microphone.volume">
        <VoiceMicrophoneButton active={!muted} level={levels.get(channel.sessionId ?? "")} disabled={microphoneDisabled} quiet
          keyShortcuts={voiceShortcutAria(shortcuts.bindings.microphone)} onClick={() => toggle("microphone")} />
      </AudioVolumeMenu>
      <AudioVolumeMenu volume={channel.listeningVolume} onVolume={channel.setListeningVolume} label="voice.listeningVolume">
        <VoiceListeningButton deafened={deafened} quiet
          keyShortcuts={voiceShortcutAria(shortcuts.bindings.listening)} onClick={() => toggle("listening")} />
      </AudioVolumeMenu>
      {overlay && <>
        <Btn icon={overlay.mode === "editing" ? "check" : "pip"} size="compact" quiet textTooltip
          title={overlay.mode === "panel" ? "channel.voiceDock.openOverlay" : overlay.mode === "editing" ? "channel.voiceDock.pinOverlay" : "channel.voiceDock.adjustOverlay"}
          onClick={overlay.mode === "panel" ? overlay.show : overlay.edit} />
        {overlay.target && <Btn icon="x" size="compact" quiet textTooltip title="common.close" onClick={overlay.close} />}
      </>}
      <Btn icon="door" title="voice.leave" hint="hint-voice-leave" draw="voice-membership" size="compact" quiet
        onClick={() => run(channel.leaveVoice(roomId))} />
    </div>
  </section>;
}

function VoiceOverlayChatSettings({ session }: { session: RoomInteractionSession }) {
  const { t } = useCopy();
  const id = useId();
  return <>
    <Btn id={id + "-trigger"} icon="danmaku" size="compact" quiet textTooltip title="playback.overlay"
      hasPopup="dialog" popoverTarget={id} controls={id} />
    <div id={id} className="lr-anchored-card c3-speaking-overlay-settings" popover="auto"
      role="dialog" aria-labelledby={id + "-title"}>
      <div className="c3-speaking-overlay-settings-header">
        <strong id={id + "-title"}>{t("playback.overlay")}</strong>
        <RoomChatToggle session={session} size="compact" quiet />
      </div>
      <RoomChatOverlaySettings session={session} />
    </div>
  </>;
}
