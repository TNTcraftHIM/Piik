import { useCallback, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { VoiceListeningButton, VoiceMicrophoneButton } from "../../room-voice/VoiceAudioButtons";
import { useVoiceLevels } from "../../room-voice/use-voice-levels";
import { useCopy } from "../../ui/copy";
import type { ChannelSnapshot } from "../protocol";
import type { ChannelController } from "../types";
import { resolveRoomVoiceControls } from "../voice-dock-controls";
import { voiceShortcutAria, voiceShortcutLabel } from "../voice-shortcut-binding";
import type { useVoiceShortcuts } from "../use-voice-shortcuts";
import { roomVoiceStatus, type VoiceRendering } from "../use-voice-playback";
import "./channel-voice-rooms.css";

type VoiceActivity = ChannelSnapshot["voice"][number];
type Shortcuts = Pick<ReturnType<typeof useVoiceShortcuts>, "bindings" | "mac">;
export type VoiceRoomDensity = "rows" | "rail" | "bar";

export const VOICE_STATUS_LABEL = {
  joining: "channel.voiceDock.voiceConnecting",
  connected: "channel.voiceDock.voiceConnected",
  joined: "channel.voiceDock.voiceJoined",
} as const;

export function ChannelVoiceRooms({ channel, state, joined, browsingRoomId, onBrowse, renderingBySpeaker, shortcuts,
  shortcutRoomId, density = "rows", directRoomId, toolsHome }: {
  channel: ChannelController; state: ChannelSnapshot; joined: readonly VoiceActivity[];
  browsingRoomId: string; onBrowse: (roomId: string) => void;
  renderingBySpeaker: ReadonlyMap<string, VoiceRendering>;
  shortcuts: Shortcuts; shortcutRoomId?: string; density?: VoiceRoomDensity; directRoomId?: string;
  /** Where the tools that adjust all of my voice are placed: at the heading's end, or in a bar after the controls they
   * adjust. A rail holds what acts and nothing that adjusts; opening the list brings the heading back. */
  toolsHome?: (element: HTMLElement | null) => void;
}) {
  const { t } = useCopy();
  const label = t("channel.voiceDock.voiceControls");
  const layout = useRef<HTMLDivElement>(null);
  const direct = density === "rows" ? undefined : joined.find(activity => activity.roomId === directRoomId) ?? joined[0];
  const listed = direct ? joined.filter(activity => activity.roomId !== direct.roomId) : joined;
  const row = (activity: VoiceActivity, visible: boolean, direct = false, dismiss?: () => void, others?: ReactNode) => {
    const { roomId } = activity;
    const name = state.channel.rooms.find(room => room.id === roomId)?.name ?? roomId;
    const current = roomId === browsingRoomId;
    const status = roomVoiceStatus(state, channel.sessionId, roomId, renderingBySpeaker);
    const showRoomInfo = !direct || !current || joined.length > 1 || status === "joining";
    return <ChannelVoiceRoomRow key={roomId} channel={channel} activity={activity} name={name}
      current={current} visible={visible} direct={direct} labelled={direct && density === "bar"} status={status} showRoomInfo={showRoomInfo}
      shortcuts={roomId === shortcutRoomId ? shortcuts : undefined} toolsHome={direct ? toolsHome : undefined} others={others}
      onBrowse={() => { dismiss?.(); onBrowse(roomId); }} />;
  };
  const rows = (visible: boolean, dismiss?: () => void) => <div className="c3-voice-rooms">
    {listed.map(activity => row(activity, visible, false, dismiss))}
  </div>;

  const others = density !== "rows" && listed.length > 0 && <ChannelVoiceRoomDisclosure
    count={listed.length} layoutAnchor={density === "rail" ? layout : undefined}>{rows}</ChannelVoiceRoomDisclosure>;
  return <div ref={layout} data-density={density} className="c3-voice-room-layout" role="region" aria-label={label}>
    {density === "rows" && <div className="c3-voice-rooms-head"><h3 className="c3-voice-rooms-heading">{label}</h3><span ref={toolsHome} className="c3-voice-tools-home" /></div>}
    {/* In a bar the other rooms stand between the room's name and its controls; in the rail they end the column. */}
    {direct && row(direct, true, true, undefined, density === "bar" ? others : undefined)}
    {density === "rows" ? rows(true) : density === "rail" && others}
  </div>;
}

function ChannelVoiceRoomDisclosure({ count, layoutAnchor, children }: {
  count: number; layoutAnchor?: RefObject<HTMLDivElement | null>; children: (open: boolean, close: () => void) => ReactNode;
}) {
  const { t } = useCopy();
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(layoutAnchor ?? trigger, panel, { side: "above", align: "start", minVisibleHeight: 120 });
  const label = t("channel.voiceDock.otherVoiceRoomCount", { count: String(count) });
  return <div className="c3-voice-room-disclosure">
    <span ref={trigger}>
      <Btn icon="headphones" size="compact" quiet cap={{ text: "+" + count }}
        title={{ text: label }} textTooltip hasPopup="dialog" popoverTarget={id} controls={id} expanded={open} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={label} className="lr-anchored-card c3-voice-rooms-popover"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      {children(open, () => panel.current?.hidePopover())}
    </div>
  </div>;
}

function ChannelVoiceRoomRow({ channel, activity, name, current, visible, direct, labelled, status, showRoomInfo, shortcuts, toolsHome, others, onBrowse }: {
  channel: ChannelController; activity: VoiceActivity; name: string; current: boolean; visible: boolean;
  direct: boolean; labelled: boolean; showRoomInfo: boolean; status: keyof typeof VOICE_STATUS_LABEL; shortcuts?: Shortcuts; onBrowse: () => void;
  toolsHome?: (element: HTMLElement | null) => void; others?: ReactNode;
}) {
  const { t } = useCopy();
  const id = useId();
  const { roomId, sessionId, muted, deafened } = activity;
  const read = useCallback(() => channel.voiceActivity(roomId, true), [channel.voiceActivity, roomId]);
  const level = useVoiceLevels(read, visible && !muted).get(sessionId);
  const { microphoneDisabled, microphonePending, toggle } = resolveRoomVoiceControls(channel, activity);
  const microphone = microphoneDisabled ? undefined : shortcuts?.bindings.microphone;
  const listening = shortcuts?.bindings.listening;
  return <div className="c3-voice-room-row" role="group" aria-labelledby={showRoomInfo ? id : undefined} aria-label={showRoomInfo ? undefined : name}
    data-current={current || undefined} data-direct={direct || undefined}>
    {showRoomInfo && <div className="c3-voice-room-info">
      {(direct || status !== "joined") && <small role="status" data-status={status}>{t(VOICE_STATUS_LABEL[status])}</small>}
      <Tooltip className="c3-voice-room c3-voice-room-name" overflow={{ text: name, selector: "button" }}>
        <button id={id} type="button" aria-current={current ? "true" : undefined} onClick={onBrowse}>{name}</button>
      </Tooltip>
    </div>}
    {others}
    <div className="c3-voice-room-actions">
      <VoiceMicrophoneButton cap={labelled ? "host.device.microphone" : undefined} active={!muted} level={level} disabled={microphoneDisabled} cancelPending={microphonePending} className="is-tonal"
        keyShortcuts={voiceShortcutAria(microphone ?? null)} shortcutLabel={microphone && shortcuts ? voiceShortcutLabel(microphone, shortcuts.mac) : undefined}
        onClick={() => toggle("microphone")} />
      <VoiceListeningButton cap={labelled ? "voice.listening.short" : undefined} deafened={deafened} className="is-tonal" keyShortcuts={voiceShortcutAria(listening ?? null)}
        shortcutLabel={listening && shortcuts ? voiceShortcutLabel(listening, shortcuts.mac) : undefined} onClick={() => toggle("listening")} />
      {/* Act, adjust, and leaving last: what adjusts my voice follows the two controls it adjusts. */}
      {toolsHome && <span ref={toolsHome} className="c3-voice-tools-home" />}
      <Btn icon="door" cap={labelled ? "voice.leave.short" : undefined} title="voice.leave" hint="hint-voice-leave" size="compact" className="is-tonal"
        onClick={() => { void channel.leaveVoice(roomId).catch(() => {}); }} />
    </div>
  </div>;
}
