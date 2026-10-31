import { useId, useRef, useState } from "react";
import { MicrophoneSettings } from "../../components/living/MicrophoneSettings";
import { Btn } from "../../components/living/primitives";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import "./channel-voice-settings.css";

export function ChannelVoiceSettings({ channel, available }: { channel: ChannelController; available: boolean }) {
  const { t } = useCopy();
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel, { side: "above" });
  const busy = channel.pending.has("voice-input") || [...channel.pending].some(key => key.startsWith("voice:"));
  const enabled = channel.state?.publications.some(publication => publication.kind === "voice" && publication.sessionId === channel.sessionId) ?? false;
  const configure = (settings: Parameters<ChannelController["configureVoiceInput"]>[0]) => { void channel.configureVoiceInput(settings).catch(() => {}); };
  return <>
    <span ref={trigger}>
      <Btn icon="sliders" title="voice.settings" hint="hint-advanced" quiet size="compact"
        popoverTarget={id} controls={id} expanded={open} disabled={!available} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("voice.settings")} className="lr-anchored-card c3-voice-settings"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      <strong>{t("voice.settings")}</strong>
      <MicrophoneSettings host={false} enabled={enabled} disabled={!available || busy}
        loadDevices={channel.microphones} deviceId={channel.voiceInput.deviceId} onDevice={deviceId => configure({ deviceId })}
        volume={channel.voiceInput.volume} onVolume={channel.setInputVolume}
        voiceProcessing={channel.voiceInput.voiceProcessing} onVoiceProcessing={voiceProcessing => configure({ voiceProcessing })} />
    </div>
  </>;
}
