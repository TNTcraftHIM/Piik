import { useCallback, useId, useRef, useState } from "react";
import { MicrophoneSettings } from "../../components/living/MicrophoneSettings";
import { AudioBitrateControl } from "../../components/living/QualityPresets";
import { WrappingSegmentedControl } from "../../components/living/WrappingSegmentedControl";
import { MAX_AUDIO_SEND_BITRATE } from "../../media/quality";
import { supportsStrongerSuppression } from "../../media/microphone-input";
import { dbfsFromLevel, microphoneModes, VOICE_ACTIVATION_RANGE_DBFS } from "../../media/voice-gate";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useVoiceLevels } from "../../room-voice/use-voice-levels";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { useVoiceShortcuts } from "../use-voice-shortcuts";
import { voiceShortcutLabel, type VoiceShortcutBinding } from "../voice-shortcut-binding";
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
      <ChannelVoiceShortcutSettings open={open} pushToTalk={channel.voiceTransmission.mode === "push"} {...shortcuts} />
      <strong>{t("voice.settings.sharedMicrophone")}</strong>
      <MicrophoneModeSettings channel={channel} open={open} disabled={busy} captured={enabled}
        talk={shortcuts.bindings.talk} mac={shortcuts.mac} />
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

/** How the shared microphone transmits. Mute still overrides every mode. */
function MicrophoneModeSettings({ channel, open, disabled, captured, talk, mac }: {
  channel: ChannelController; open: boolean; disabled: boolean; captured: boolean; talk: VoiceShortcutBinding | null; mac: boolean;
}) {
  const { t } = useCopy();
  const id = useId();
  const { mode } = channel.voiceTransmission;
  const hint = mode === "open" ? t("voice.mode.openHint") : mode === "activity" ? t("voice.mode.activityHint")
    : talk ? t("voice.mode.pushHint", { shortcut: voiceShortcutLabel(talk, mac) }) : t("voice.mode.pushUnbound");
  return <section className="c3-voice-mode" aria-labelledby={`${id}-title`}>
    <span id={`${id}-title`}>{t("voice.mode")}</span>
    <WrappingSegmentedControl role="radiogroup" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}>
      {microphoneModes.map(value => <label key={value} className={value === mode ? "is-selected" : undefined}>
        <input type="radio" name={id} value={value} checked={value === mode} disabled={disabled}
          onChange={() => { void channel.setMicrophoneMode(value).catch(() => {}); }} />
        <span>{t(`voice.mode.${value}`)}</span>
      </label>)}
    </WrappingSegmentedControl>
    <p id={`${id}-hint`}>{hint}</p>
    {mode === "activity" && <ActivationThreshold channel={channel} open={open} disabled={disabled} captured={captured} />}
  </section>;
}

/** The slider sets the level voice activation needs; the meter beneath reads the microphone before the gate, on the same scale. */
function ActivationThreshold({ channel, open, disabled, captured }: {
  channel: ChannelController; open: boolean; disabled: boolean; captured: boolean;
}) {
  const { t } = useCopy();
  const id = useId();
  const [min, max] = VOICE_ACTIVATION_RANGE_DBFS;
  const threshold = channel.voiceTransmission.activationThreshold;
  // The shared level poller follows the visible surface; it reads maps keyed by source.
  const read = useCallback(async () => {
    const level = channel.microphoneLevel();
    return new Map(level === undefined ? [] : [["input", level]]);
  }, [channel.microphoneLevel]);
  const level = useVoiceLevels(read, open && captured).get("input");
  const dbfs = level === undefined ? undefined : dbfsFromLevel(level);
  const position = (value: number) => `${Math.min(100, Math.max(0, (value - min) / (max - min) * 100))}%`;
  const valueText = `${threshold} dB`;
  return <div className="lr-door-group lr-audio-settings c3-voice-activation">
    <label htmlFor={id}><span>{t("voice.mode.sensitivity")}</span><span className="lr-volume-value" aria-hidden="true">{valueText}</span></label>
    <input id={id} type="range" min={min} max={max} step={1} value={threshold} disabled={disabled} aria-valuetext={valueText}
      onChange={event => channel.setActivationThreshold(Number(event.target.value))} />
    {captured ? <span className="c3-voice-activation-meter" aria-hidden="true" data-passing={dbfs !== undefined && dbfs >= threshold || undefined}>
      {dbfs !== undefined && <span style={{ width: position(dbfs) }} />}
    </span> : <small>{t("voice.mode.levelUnavailable")}</small>}
  </div>;
}
