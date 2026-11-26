import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { VoiceListeningButton, VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import type { ChannelController } from "../types";
import { roomVoiceStatus, type VoiceRendering } from "../use-voice-playback";
import { profileAvatar, roomVoicePeople } from "../presentation";
import { ChannelVoiceSettings } from "./ChannelVoiceSettings";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { createPortal } from "react-dom";
import { RoomChatOverlay, RoomChatOverlaySettings, RoomChatToggle } from "../../components/living/RoomChatOverlay";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { SurfaceDocument } from "../../ui/panel-window";
import { VoiceOverlay } from "./voice-overlay";
import { useVoiceLevels } from "../../room-voice/use-voice-levels";
import { resolveRoomVoiceControls, resolveVoiceDockControls } from "../voice-dock-controls";
import { useVoiceShortcuts } from "../use-voice-shortcuts";
import { voiceShortcutAria, voiceShortcutLabel } from "../voice-shortcut-binding";
import { SPEAKING_LEVEL } from "../../media/voice-gate";
import { ChannelVoiceRooms, VOICE_STATUS_LABEL, type VoiceRoomDensity } from "./ChannelVoiceRooms";

type VoiceDockProps = {
  channel: ChannelController;
  renderingBySpeaker: ReadonlyMap<string, VoiceRendering>;
  onBrowse: (id: string) => void;
} & ({
  presentation?: "legacy";
  selected: string;
  onSelect: (id: string) => void;
} | {
  presentation: "rooms";
  browsingRoomId: string;
  density?: VoiceRoomDensity;
  directRoomId?: string;
  toolsTarget?: HTMLElement | null;
});

/** One persistent control surface for this endpoint's independently joined rooms. */
export function ChannelVoiceDock(props: VoiceDockProps) {
  const { channel, renderingBySpeaker, onBrowse } = props;
  const roomList = props.presentation === "rooms";
  const { t } = useCopy();
  const state = channel.state;
  const legacy = resolveVoiceDockControls(channel, roomList ? undefined : props.selected);
  const { joined } = legacy;
  const activity = roomList ? joined.length === 1 ? joined[0] : undefined : legacy.activity;
  const { microphoneDisabled, microphonePending, toggle } = roomList ? resolveRoomVoiceControls(channel, activity) : legacy;
  const shortcuts = useVoiceShortcuts(activity?.roomId, toggle,
    channel.connection === "connected" ? channel.backgroundVoiceShortcuts : undefined,
    joined.length && channel.voiceTransmission.mode === "push" ? channel.talk : undefined);
  const controls = useRef<HTMLDivElement>(null);
  const roomId = activity?.roomId ?? "";
  const overlay = useContext(VoiceOverlay);
  const readRemote = !!overlay?.target && !activity?.deafened;
  const readLevels = useCallback(() => channel.voiceActivity(roomId, !readRemote), [channel.voiceActivity, roomId, readRemote]);
  const levels = useVoiceLevels(readLevels, !!activity && (roomList ? !!overlay?.target && (!activity.muted || readRemote)
    : !activity.muted || readRemote), overlay?.target?.ownerDocument);
  useEffect(() => { if (!activity && overlay?.target) overlay.close(); }, [activity, overlay]);
  if (!joined.length || !state) return null;
  const nameOfRoom = (id: string) => state.channel.rooms.find(room => room.id === id)?.name ?? id;
  const interaction = channel.interactionsByRoom.get(roomId) ?? null;
  const roomName = nameOfRoom(roomId);
  const multipleRooms = joined.length > 1;
  const { microphone, listening } = shortcuts.bindings;
  const available = channel.connection === "connected" && !!state.channel.rooms.find(room => room.id === roomId)?.available;
  const appearances = overlay?.target ? roomVoicePeople(state, roomId, levels) : null;
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  const speaking = appearances ? state.users.filter(user => (appearances.get(user.id)?.level ?? 0) > SPEAKING_LEVEL) : [];
  const overlayTools = overlay && activity && <>
    <Btn icon={overlay.mode === "editing" ? "check" : "pip"} size="compact" quiet textTooltip
      title={overlay.mode === "panel" ? roomList ? { text: t("channel.voiceDock.openRoomOverlay", { name: roomName }) }
        : "channel.voiceDock.openOverlay" : overlay.mode === "editing" ? "channel.voiceDock.pinOverlay" : "channel.voiceDock.adjustOverlay"}
      onClick={overlay.mode === "panel" ? overlay.show : overlay.edit} />
    {overlay.target && <Btn icon="x" size="compact" quiet textTooltip title="common.close" onClick={overlay.close} />}
  </>;
  const overlayView = overlay?.target && activity && createPortal(<SurfaceDocument.Provider value={overlay.target.ownerDocument}>
      <div className="c3-speaking-overlay">
        <div className="c3-speaking-overlay-header">
          <strong title={roomName}>{roomName}</strong>
          <span role="img" aria-label={t(activity.muted ? "voice.microphoneInactive" : "voice.microphoneActive")}>
            <Glyph name={activity.muted ? "microphoneOff" : "microphone"} size={16} />
          </span>
          <span role="img" aria-label={t(activity.deafened ? "voice.listeningPaused" : "voice.listeningActive")}>
            <Glyph name={activity.deafened ? "headphonesOff" : "headphones"} size={16} />
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
    </SurfaceDocument.Provider>, overlay.target);
  const mutedNotice = <MutedTalkNotice anchor={controls} shown={shortcuts.talking && joined.every(value => value.muted)} />;
  if (roomList) {
    const inputAvailable = channel.connection === "connected" && state.channel.rooms.some(room => room.available
      && joined.some(value => value.roomId === room.id));
    const target = props.toolsTarget;
    // The desktop rail and phone header can replace the tools slot while settings are open.
    const renderTools = (settings: ReactNode) => {
      const tools = <div className="c3-voice-shared-tools">{settings}{overlayTools}</div>;
      return target ? createPortal(
        <SurfaceDocument.Provider value={target.ownerDocument}>{tools}</SurfaceDocument.Provider>, target,
      ) : tools;
    };
    return <>
      <div ref={controls} className="c3-voice-dock-rooms">
        <ChannelVoiceRooms key={props.density} channel={channel} state={state} joined={joined} browsingRoomId={props.browsingRoomId}
          onBrowse={onBrowse} renderingBySpeaker={renderingBySpeaker} shortcuts={shortcuts}
          shortcutRoomId={activity?.roomId} density={props.density}
          directRoomId={props.directRoomId} />
        {mutedNotice}
      </div>
      <ChannelVoiceSettings channel={channel} available={inputAvailable} shortcuts={shortcuts}
        triggerDocument={target?.ownerDocument} renderTrigger={renderTools} />
      {overlayView}
    </>;
  }
  if (!activity) return null;
  const { muted, deafened } = activity;
  const status = roomVoiceStatus(state, channel.sessionId, roomId, renderingBySpeaker);
  return <section className="c3-voice-dock" aria-label={t("channel.voiceDock.voiceControls")}>
    <Glyph name="headphones" size={22} />
    <div className="c3-voice-destination">
      <div className="c3-voice-room-info">
        <small data-status={status} role="status">{t(VOICE_STATUS_LABEL[status])}</small>
        <div className="c3-voice-room-choice">
          <Tooltip className="c3-voice-room" overflow={{ text: roomName, selector: "button, select" }}>
            {multipleRooms ? <select className="lr-select" aria-label={t("channel.voiceDock.selectRoom")} value={roomId}
              onChange={event => props.onSelect(event.target.value)}>
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
    {overlayView}
    {mutedNotice}
    <div ref={controls} className="c3-voice-controls">
      <AudioVolumeMenu volume={channel.voiceInput.volume} onVolume={channel.setInputVolume} label="host.microphone.volume">
        <VoiceMicrophoneButton active={!muted} level={levels.get(channel.sessionId ?? "")} disabled={microphoneDisabled}
          cancelPending={microphonePending} quiet keyShortcuts={microphoneDisabled ? undefined : voiceShortcutAria(microphone)}
          shortcutLabel={!microphoneDisabled && microphone ? voiceShortcutLabel(microphone, shortcuts.mac) : undefined} onClick={() => toggle("microphone")} />
      </AudioVolumeMenu>
      <AudioVolumeMenu volume={channel.listeningVolume} onVolume={channel.setListeningVolume} label="voice.listeningVolume">
        <VoiceListeningButton deafened={deafened} quiet
          keyShortcuts={voiceShortcutAria(listening)} shortcutLabel={listening ? voiceShortcutLabel(listening, shortcuts.mac) : undefined} onClick={() => toggle("listening")} />
      </AudioVolumeMenu>
      {overlayTools}
      <Btn icon="door" title="voice.leave" hint="hint-voice-leave" draw="voice-membership" size="compact" quiet
        onClick={() => run(channel.leaveVoice(roomId))} />
    </div>
  </section>;
}

/** Holding the talk key while every joined room is muted sends nothing; this says so above the microphone without moving the controls.
 * The gate is shared, so one unmuted room carries the press and the notice stays hidden. */
function MutedTalkNotice({ anchor, shown }: { anchor: RefObject<HTMLElement | null>; shown: boolean }) {
  const { t } = useCopy();
  const notice = useRef<HTMLParagraphElement>(null);
  useAnchoredPopover(anchor, notice, { side: "above", align: "start" });
  useLayoutEffect(() => {
    const element = notice.current;
    if (!element) return;
    if (shown) element.showPopover();
    else if (element.matches(":popover-open")) element.hidePopover();
  }, [shown]);
  return <p ref={notice} popover="manual" role="status" className="lr-anchored-card c3-voice-talk-muted">
    {shown && <><Glyph name="microphoneOff" size={16} /><span>{t("voice.microphoneInactive")}</span></>}
  </p>;
}

function VoiceOverlayChatSettings({ session }: { session: RoomInteractionSession }) {
  const { t } = useCopy();
  const id = useId();
  const [open, setOpen] = useState(false);
  return <>
    <Btn id={id + "-trigger"} icon="danmaku" size="compact" quiet textTooltip title="playback.overlay"
      hasPopup="dialog" popoverTarget={id} controls={id} expanded={open} />
    <div id={id} className="lr-anchored-card c3-speaking-overlay-settings" popover="auto"
      role="dialog" aria-labelledby={id + "-title"}
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      <div className="c3-speaking-overlay-settings-header">
        <strong id={id + "-title"}>{t("playback.overlay")}</strong>
        <RoomChatToggle session={session} size="compact" quiet />
      </div>
      <RoomChatOverlaySettings session={session} />
    </div>
  </>;
}
