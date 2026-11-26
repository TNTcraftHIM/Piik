import { useCallback, useId, useRef, useState } from "react";
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

export const VOICE_STATUS_LABEL = {
  joining: "channel.voiceDock.voiceConnecting",
  connected: "channel.voiceDock.voiceConnected",
  joined: "channel.voiceDock.voiceJoined",
} as const;

export function ChannelVoiceRooms({ channel, state, joined, browsingRoomId, onBrowse, renderingBySpeaker, shortcuts, shortcutRoomId, compact = false }: {
  channel: ChannelController; state: ChannelSnapshot; joined: readonly VoiceActivity[];
  browsingRoomId: string; onBrowse: (roomId: string) => void;
  renderingBySpeaker: ReadonlyMap<string, VoiceRendering>;
  shortcuts: Shortcuts; shortcutRoomId?: string; compact?: boolean;
}) {
  const { t } = useCopy();
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel, { side: "above", align: "start", minVisibleHeight: 120, enabled: compact });
  const label = t("channel.voiceDock.voiceControls");
  const count = String(joined.length);
  const rows = <div className="c3-voice-rooms" role="region" aria-label={label}>
    {joined.map(activity => {
      const { roomId } = activity;
      const name = state.channel.rooms.find(room => room.id === roomId)?.name ?? roomId;
      return <ChannelVoiceRoomRow key={roomId} channel={channel} activity={activity} name={name}
        current={roomId === browsingRoomId} visible={!compact || open}
        status={roomVoiceStatus(state, channel.sessionId, roomId, renderingBySpeaker)}
        shortcuts={roomId === shortcutRoomId ? shortcuts : undefined}
        onBrowse={() => { if (panel.current?.matches(":popover-open")) panel.current.hidePopover(); onBrowse(roomId); }} />;
    })}
  </div>;
  if (!compact) return rows;
  return <div className="c3-voice-rooms-compact">
    <span ref={trigger}>
      <Btn icon="headphones" size="compact" quiet cap={{ text: count }}
        title={{ text: t("channel.voiceDock.voiceRoomCount", { count }) }}
        hasPopup="dialog" popoverTarget={id} controls={id} expanded={open} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={label} className="lr-anchored-card c3-voice-rooms-popover"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      {rows}
    </div>
  </div>;
}

function ChannelVoiceRoomRow({ channel, activity, name, current, visible, status, shortcuts, onBrowse }: {
  channel: ChannelController; activity: VoiceActivity; name: string; current: boolean; visible: boolean;
  status: keyof typeof VOICE_STATUS_LABEL; shortcuts?: Shortcuts; onBrowse: () => void;
}) {
  const { t } = useCopy();
  const id = useId();
  const { roomId, sessionId, muted, deafened } = activity;
  const read = useCallback(() => channel.voiceActivity(roomId, true), [channel.voiceActivity, roomId]);
  const level = useVoiceLevels(read, visible && !muted).get(sessionId);
  const { microphoneDisabled, microphonePending, toggle } = resolveRoomVoiceControls(channel, activity);
  const microphone = microphoneDisabled ? undefined : shortcuts?.bindings.microphone;
  const listening = shortcuts?.bindings.listening;
  return <div className="c3-voice-room-row" role="group" aria-labelledby={id} data-current={current || undefined}>
    <div className="c3-voice-room-info">
      <small role="status" data-status={status}>{t(VOICE_STATUS_LABEL[status])}</small>
      <Tooltip className="c3-voice-room c3-voice-room-name" overflow={{ text: name, selector: "button" }}>
        <button id={id} type="button" aria-current={current ? "true" : undefined} onClick={onBrowse}>{name}</button>
      </Tooltip>
    </div>
    <div className="c3-voice-room-actions">
      <VoiceMicrophoneButton active={!muted} level={level} disabled={microphoneDisabled} cancelPending={microphonePending} quiet
        keyShortcuts={voiceShortcutAria(microphone ?? null)} shortcutLabel={microphone && shortcuts ? voiceShortcutLabel(microphone, shortcuts.mac) : undefined}
        onClick={() => toggle("microphone")} />
      <VoiceListeningButton deafened={deafened} quiet keyShortcuts={voiceShortcutAria(listening ?? null)}
        shortcutLabel={listening && shortcuts ? voiceShortcutLabel(listening, shortcuts.mac) : undefined} onClick={() => toggle("listening")} />
      <Btn icon="door" title="voice.leave" hint="hint-voice-leave" draw="voice-membership" size="compact" quiet
        onClick={() => { void channel.leaveVoice(roomId).catch(() => {}); }} />
    </div>
  </div>;
}
