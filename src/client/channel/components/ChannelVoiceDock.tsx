import { memberName, duplicateMemberNames } from "../member-name";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Btn } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { VoiceRendering } from "../use-voice-playback";
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
import { resolveVoiceDockControls } from "../voice-dock-controls";
import { useVoiceShortcuts } from "../use-voice-shortcuts";
import { SPEAKING_LEVEL } from "../../media/voice-gate";
import { ChannelVoiceRooms, type VoiceRoomDensity } from "./ChannelVoiceRooms";

type VoiceDockProps = {
  channel: ChannelController;
  renderingBySpeaker: ReadonlyMap<string, VoiceRendering>;
  onBrowse: (id: string) => void;
  browsingRoomId: string;
  density?: VoiceRoomDensity;
  directRoomId?: string;
};

/** One persistent control surface for this endpoint's independently joined rooms. */
export function ChannelVoiceDock(props: VoiceDockProps) {
  const { channel, renderingBySpeaker, onBrowse } = props;
  const { t } = useCopy();
  const state = channel.state;
  const { joined, activity } = resolveVoiceDockControls(channel, props.directRoomId ?? "");
  const shortcutSession = joined.length || channel.voiceMicrophonePending() ? channel.sessionId ?? undefined : undefined;
  const shortcuts = useVoiceShortcuts(shortcutSession, channel.toggleVoiceShortcut,
    joined.length && channel.connection === "connected" ? channel.backgroundVoiceShortcuts : undefined,
    joined.length && channel.voiceTransmission.mode === "push" ? channel.talk : undefined);
  const controls = useRef<HTMLDivElement>(null);
  // What adjusts all of my voice stands with the voice controls: the rooms render its place, and it is filled here.
  const [toolsHome, setToolsHome] = useState<HTMLElement | null>(null);
  const roomId = activity?.roomId ?? "";
  const overlay = useContext(VoiceOverlay);
  const readRemote = !!overlay?.target && !activity?.deafened;
  const readLevels = useCallback(() => channel.voiceActivity(roomId, !readRemote), [channel.voiceActivity, roomId, readRemote]);
  const levels = useVoiceLevels(readLevels, !!activity && !!overlay?.target && (!activity.muted || readRemote), overlay?.target?.ownerDocument);
  useEffect(() => { if (!activity && overlay?.target) overlay.close(); }, [activity, overlay]);
  if (!joined.length || !state) return null;
  const nameOfRoom = (id: string) => state.channel.rooms.find(room => room.id === id)?.name ?? id;
  const interaction = channel.interactionsByRoom.get(roomId) ?? null;
  const roomName = nameOfRoom(roomId);
  const appearances = overlay?.target ? roomVoicePeople(state, roomId, levels) : null;
  const speaking = appearances ? state.users.filter(user => (appearances.get(user.id)?.level ?? 0) > SPEAKING_LEVEL) : [];
  const duplicates = duplicateMemberNames(speaking);
  const overlayTools = overlay && activity && <>
    <Btn icon={overlay.mode === "editing" ? "check" : "pip"} size="compact" quiet textTooltip
      title={overlay.mode === "panel" ? { text: t("channel.voiceDock.openRoomOverlay", { name: roomName }) } : overlay.mode === "editing" ? "channel.voiceDock.pinOverlay" : "channel.voiceDock.adjustOverlay"}
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
            <span>{memberName(user.id, user.name, duplicates.has(user.name))}</span>
          </div>)}
        </div>
        <div className="c3-speaking-overlay-chat">
          <RoomChatOverlay session={interaction} visible />
        </div>
      </div>
    </SurfaceDocument.Provider>, overlay.target);
  const mutedNotice = <MutedTalkNotice anchor={controls} shown={shortcuts.talking && joined.every(value => value.muted)} />;
  const inputAvailable = channel.connection === "connected" && state.channel.rooms.some(room => room.available
    && joined.some(value => value.roomId === room.id));
  // The rows, the rail and the bar each give the tools a place, and can replace it while settings are open.
  const renderTools = (settings: ReactNode) => toolsHome && createPortal(
    <SurfaceDocument.Provider value={toolsHome.ownerDocument}><div className="c3-voice-shared-tools">{settings}{overlayTools}</div></SurfaceDocument.Provider>, toolsHome);
  return <>
    <div ref={controls} className="c3-voice-dock-rooms">
      <ChannelVoiceRooms key={props.density} channel={channel} state={state} joined={joined} browsingRoomId={props.browsingRoomId}
        onBrowse={onBrowse} renderingBySpeaker={renderingBySpeaker} shortcuts={shortcuts}
        shortcutRoomId={joined.length === 1 ? activity?.roomId : undefined} density={props.density}
        directRoomId={props.directRoomId} toolsHome={setToolsHome} />
      {mutedNotice}
    </div>
    <ChannelVoiceSettings channel={channel} available={inputAvailable} shortcuts={shortcuts}
      triggerDocument={toolsHome?.ownerDocument} renderTrigger={renderTools} />
    {overlayView}
  </>;
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
