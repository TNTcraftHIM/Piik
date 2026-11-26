import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { MicrophoneSettings } from "../../components/living/MicrophoneSettings";
import { AudioVolumeControl } from "../../components/living/AudioVolumeControl";
import { WrappingSegmentedControl } from "../../components/living/WrappingSegmentedControl";
import { supportsStrongerSuppression } from "../../media/microphone-input";
import { dbfsFromLevel, microphoneModes, VOICE_ACTIVATION_RANGE_DBFS, type MicrophoneMode } from "../../media/voice-gate";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { useVoiceLevels } from "../../room-voice/use-voice-levels";
import { useCopy } from "../../ui/copy";
import { SurfaceDocument, useSurfaceDocument } from "../../ui/panel-window";
import type { ChannelController } from "../types";
import type { useVoiceShortcuts } from "../use-voice-shortcuts";
import { voiceShortcutLabel, type VoiceShortcutBinding } from "../voice-shortcut-binding";
import { ChannelVoiceShortcutSettings } from "./ChannelVoiceShortcutSettings";
import { ChannelSettingsDialog, useSettingsAction, type SettingsAction } from "./ChannelSettingsDialog";
import "./channel-voice-settings.css";

type VoiceSettingsProps = {
  channel: ChannelController; available: boolean; shortcuts: ReturnType<typeof useVoiceShortcuts>;
};

export function ChannelVoiceSettings({ triggerDocument, renderTrigger, ...props }: VoiceSettingsProps & {
  triggerDocument?: Document; renderTrigger?: (trigger: ReactNode) => ReactNode;
}) {
  const { t } = useCopy();
  const triggerId = useId();
  const surface = useSurfaceDocument();
  const [openDocument, setOpenDocument] = useState<Document | null>(null);
  const { error, run } = useSettingsAction(!!openDocument, props.channel.sessionId);
  useEffect(() => {
    const view = openDocument?.defaultView;
    const close = () => setOpenDocument(null);
    view?.addEventListener("pagehide", close);
    return () => view?.removeEventListener("pagehide", close);
  }, [openDocument]);
  const trigger = <Btn id={triggerId} icon="sliders" title="voice.settings" hint="hint-advanced" quiet size="compact"
    hasPopup="dialog" expanded={!!openDocument} onClick={() => setOpenDocument(triggerDocument ?? surface)} />;
  return <>
    {renderTrigger ? renderTrigger(trigger) : trigger}
    {openDocument && <SurfaceDocument.Provider value={openDocument}>
      <ChannelSettingsDialog title={t("voice.settings")} error={error} compact dismissOnBackdrop onClose={() => {
        setOpenDocument(null);
        openDocument.defaultView?.requestAnimationFrame(() => {
          // A layout change can replace the button that the browser would restore.
          if (openDocument.activeElement !== openDocument.body) return;
          const currentTrigger = openDocument.getElementById(triggerId);
          if (currentTrigger?.getClientRects().length) currentTrigger.focus({ preventScroll: true });
        });
      }}>
        <ChannelVoiceSettingsForm {...props} run={run} />
      </ChannelSettingsDialog>
    </SurfaceDocument.Provider>}
  </>;
}

export function ChannelVoiceSettingsForm({ channel, available, shortcuts, run }: VoiceSettingsProps & { run: SettingsAction }) {
  const { t } = useCopy();
  const id = useId();
  const busy = channel.voiceBusy();
  const enabled = channel.state?.publications.some(publication => publication.kind === "voice" && publication.sessionId === channel.sessionId) ?? false;
  const supportsEnhanced = supportsStrongerSuppression();
  const configure = (settings: Parameters<ChannelController["configureVoiceInput"]>[0]) => {
    void run(() => channel.configureVoiceInput(settings, false));
  };
  return <div className="c3-settings-panels c3-voice-settings">
    <section aria-labelledby={id}>
      <h3 id={id}>{t("voice.settings.sharedMicrophone")}</h3>
      <MicrophoneModeSettings channel={channel} disabled={busy} captured={enabled}
        talk={shortcuts.bindings.talk} mac={shortcuts.mac}
        onChange={mode => { void run(() => channel.setMicrophoneMode(mode, false)); }} />
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
    <div className="lr-door-group lr-audio-settings">
      <AudioVolumeControl volume={channel.listeningVolume} onVolume={channel.setListeningVolume} label="voice.listeningVolume" />
    </div>
    <ChannelVoiceShortcutSettings pushToTalk={channel.voiceTransmission.mode === "push"} {...shortcuts} />
  </div>;
}

/** How the shared microphone transmits. Mute still overrides every mode. */
function MicrophoneModeSettings({ channel, disabled, captured, talk, mac, onChange }: {
  channel: ChannelController; disabled: boolean; captured: boolean; talk: VoiceShortcutBinding | null; mac: boolean;
  onChange: (mode: MicrophoneMode) => void;
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
          onChange={() => onChange(value)} />
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
