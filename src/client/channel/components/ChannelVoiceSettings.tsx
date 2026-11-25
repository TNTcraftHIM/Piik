import { useId, useRef, useState } from "react";
import { MicrophoneSettings } from "../../components/living/MicrophoneSettings";
import { AudioBitrateControl } from "../../components/living/QualityPresets";
import { MAX_AUDIO_SEND_BITRATE } from "../../media/quality";
import { supportsStrongerSuppression } from "../../media/microphone-input";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { useVoiceShortcuts } from "../use-voice-shortcuts";
import { ChannelVoiceShortcutSettings } from "./ChannelVoiceShortcutSettings";
import "./channel-voice-settings.css";

export function ChannelVoiceSettings({ channel, roomId, available, shortcuts }: {
  channel: ChannelController; roomId: string; available: boolean; shortcuts: ReturnType<typeof useVoiceShortcuts>;
}) {
  const { t } = useCopy();
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel, { side: "above" });
  const busy = channel.voiceBusy();
  const enabled = channel.state?.publications.some(publication => publication.kind === "voice" && publication.sessionId === channel.sessionId) ?? false;
  const room = channel.state?.channel.rooms.find(room => room.id === roomId);
  const configure = (settings: Parameters<ChannelController["configureVoiceInput"]>[0]) => { void channel.configureVoiceInput(settings).catch(() => {}); };
  return <>
    <span ref={trigger}>
      <Btn icon="sliders" title="voice.settings" hint="hint-advanced" quiet size="compact"
        hasPopup="dialog" popoverTarget={id} controls={id} expanded={open} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("voice.settings")} className="lr-anchored-card c3-voice-settings"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      <ChannelVoiceShortcutSettings open={open} {...shortcuts} />
      <strong>{t("voice.settings.sharedMicrophone")}</strong>
      {open && <MicrophoneSettings host={false} enabled={enabled} disabled={!available || busy}
        loadDevices={channel.microphones} deviceId={channel.voiceInput.deviceId} onDevice={deviceId => configure({ deviceId })}
        volume={channel.voiceInput.volume} onVolume={channel.setInputVolume}
        voiceProcessing={channel.voiceInput.voiceProcessing} onVoiceProcessing={voiceProcessing => configure({ voiceProcessing })} />}
      <SwitchItem checked={Boolean(channel.voiceInput.strongerSuppression)}
        onChange={strongerSuppression => configure({ strongerSuppression })}
        disabled={!available || busy || !channel.voiceInput.strongerSuppression && (!channel.voiceInput.voiceProcessing || !supportsStrongerSuppression())}
        label={t("voice.noise.enhanced")} hint="hint-voice-microphone-processing" note={t("voice.noise.enhancedHint")} />
      {!supportsStrongerSuppression() && <p role="status">{t("voice.noise.unsupported")}</p>}
      {room?.canManage && <AudioBitrateControl purpose="voice" value={room.voiceBitrate} max={MAX_AUDIO_SEND_BITRATE}
        disabled={!available || channel.pending.has(`room:${roomId}`)}
        onChange={bitrate => { void channel.setRoomVoiceBitrate(roomId, bitrate).catch(() => {}); }} />}
    </div>
  </>;
}
