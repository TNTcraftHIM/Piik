import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { MicrophoneSettings } from "../../components/living/MicrophoneSettings";
import { AudioVolumeControl } from "../../components/living/AudioVolumeControl";
import { AudioBitrateControl } from "../../components/living/QualityPresets";
import { WrappingSegmentedControl } from "../../components/living/WrappingSegmentedControl";
import { MAX_AUDIO_SEND_BITRATE } from "../../media/quality";
import { supportsStrongerSuppression } from "../../media/microphone-input";
import { dbfsFromLevel, microphoneModes, VOICE_ACTIVATION_RANGE_DBFS } from "../../media/voice-gate";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { useVoiceLevels } from "../../room-voice/use-voice-levels";
import { useCopy } from "../../ui/copy";
import { SurfaceDocument, useSurfaceDocument } from "../../ui/panel-window";
import type { ChannelController } from "../types";
import type { useVoiceShortcuts } from "../use-voice-shortcuts";
import { voiceShortcutLabel, type VoiceShortcutBinding } from "../voice-shortcut-binding";
import { ChannelVoiceShortcutSettings } from "./ChannelVoiceShortcutSettings";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import "./channel-voice-settings.css";

type VoiceSettingsProps = {
  channel: ChannelController; roomId?: string; available: boolean; shortcuts: ReturnType<typeof useVoiceShortcuts>;
};

export function ChannelVoiceSettings({ triggerDocument, renderTrigger, ...props }: VoiceSettingsProps & {
  triggerDocument?: Document; renderTrigger?: (trigger: ReactNode) => ReactNode;
}) {
  const { t } = useCopy();
  const surface = useSurfaceDocument();
  const [openDocument, setOpenDocument] = useState<Document | null>(null);
  useEffect(() => {
    const view = openDocument?.defaultView;
    const close = () => setOpenDocument(null);
    view?.addEventListener("pagehide", close);
    return () => view?.removeEventListener("pagehide", close);
  }, [openDocument]);
  const trigger = <Btn icon="sliders" title="voice.settings" hint="hint-advanced" quiet size="compact"
    hasPopup="dialog" expanded={!!openDocument} onClick={() => setOpenDocument(triggerDocument ?? surface)} />;
  return <>
    {renderTrigger ? renderTrigger(trigger) : trigger}
    {openDocument && <SurfaceDocument.Provider value={openDocument}>
      <ChannelSettingsDialog title={t("voice.settings")} compact dismissOnBackdrop onClose={() => setOpenDocument(null)}>
        <ChannelVoiceSettingsForm {...props} />
      </ChannelSettingsDialog>
    </SurfaceDocument.Provider>}
  </>;
}

export function ChannelVoiceSettingsForm({ channel, roomId, available, shortcuts }: VoiceSettingsProps) {
  const { t } = useCopy();
  const id = useId();
  const busy = channel.voiceBusy();
  const enabled = channel.state?.publications.some(publication => publication.kind === "voice" && publication.sessionId === channel.sessionId) ?? false;
  const room = channel.state?.channel.rooms.find(room => room.id === roomId);
  const supportsEnhanced = supportsStrongerSuppression();
  const configure = (settings: Parameters<ChannelController["configureVoiceInput"]>[0]) => { void channel.configureVoiceInput(settings).catch(() => {}); };
  return <div className="c3-settings-panels c3-voice-settings">
    <section aria-labelledby={id}>
      <h3 id={id}>{t("voice.settings.sharedMicrophone")}</h3>
      <MicrophoneModeSettings channel={channel} disabled={busy} captured={enabled}
        talk={shortcuts.bindings.talk} mac={shortcuts.mac} />
      <MicrophoneSettings host={false} enabled={enabled} disabled={!available || busy}
        loadDevices={channel.microphones} deviceId={channel.voiceInput.deviceId} onDevice={deviceId => configure({ deviceId })}
        volume={channel.voiceInput.volume} onVolume={channel.setInputVolume}
        voiceProcessing={channel.voiceInput.voiceProcessing} onVoiceProcessing={voiceProcessing => configure({ voiceProcessing })} />
      <SwitchItem checked={Boolean(channel.voiceInput.strongerSuppression)}
        onChange={strongerSuppression => configure({ strongerSuppression })}
        disabled={!available || busy || !channel.voiceInput.strongerSuppression && (!channel.voiceInput.voiceProcessing || !supportsEnhanced)}
        label={t("voice.noise.enhanced")} hint="hint-voice-microphone-processing" note={t("voice.noise.enhancedHint")} />
      {!supportsEnhanced && <p role="status">{t("voice.noise.unsupported")}</p>}
    </section>
    {roomId === undefined && <div className="lr-door-group lr-audio-settings">
      <AudioVolumeControl volume={channel.listeningVolume} onVolume={channel.setListeningVolume} label="voice.listeningVolume" />
    </div>}
    <ChannelVoiceShortcutSettings pushToTalk={channel.voiceTransmission.mode === "push"} {...shortcuts} />
    {roomId && room?.canManage && <section aria-labelledby={id + "-room"}>
      <h3 id={id + "-room"}>{room.name}</h3>
      <AudioBitrateControl purpose="voice" value={room.voiceBitrate} max={MAX_AUDIO_SEND_BITRATE}
        disabled={!available || channel.pending.has(`room:${roomId}`)}
        onChange={bitrate => { void channel.setRoomVoiceBitrate(roomId, bitrate).catch(() => {}); }} />
    </section>}
  </div>;
}

/** How the shared microphone transmits. Mute still overrides every mode. */
function MicrophoneModeSettings({ channel, disabled, captured, talk, mac }: {
  channel: ChannelController; disabled: boolean; captured: boolean; talk: VoiceShortcutBinding | null; mac: boolean;
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
    {mode === "activity" && <ActivationThreshold channel={channel} disabled={disabled} captured={captured} />}
  </section>;
}

/** The slider sets the level voice activation needs; the meter beneath reads the microphone before the gate, on the same scale. */
function ActivationThreshold({ channel, disabled, captured }: {
  channel: ChannelController; disabled: boolean; captured: boolean;
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
  const level = useVoiceLevels(read, captured).get("input");
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
