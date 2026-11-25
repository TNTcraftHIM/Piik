import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import { useSurfaceDocument } from "../../ui/panel-window";
import { isComposingOrAltGraph } from "../../ui/shortcut-key";
import type { useVoiceShortcuts } from "../use-voice-shortcuts";
import {
  matchesVoiceShortcut, voiceShortcutActions, voiceShortcutFromEvent, voiceShortcutLabel,
  type VoiceShortcutAction,
} from "../voice-shortcut-binding";

const modifiers = new Set(["Control", "Alt", "Shift", "Meta"]);

export function ChannelVoiceShortcutSettings({ open, pushToTalk, bindings, mac, save, reset, recording, setRecording, background }:
  { open: boolean; pushToTalk: boolean } & ReturnType<typeof useVoiceShortcuts>) {
  const { t } = useCopy();
  const surface = useSurfaceDocument();
  const id = useId();
  const [feedback, setFeedback] = useState<{ duplicate: VoiceShortcutAction } | "unsupported" | null>(null);
  const actionName = (action: VoiceShortcutAction) =>
    t(action === "microphone" ? "host.device.microphone" : action === "listening" ? "voice.listening" : "voice.mode.push");
  const finish = () => { setRecording(null); setFeedback(null); };
  useEffect(() => {
    if (!open) finish();
    const view = surface?.defaultView;
    view?.addEventListener("blur", finish);
    return () => view?.removeEventListener("blur", finish);
  }, [open, surface]);

  const record = (event: KeyboardEvent<HTMLSpanElement>, action: VoiceShortcutAction) => {
    if (!open || recording !== action || event.key === "Tab" || isComposingOrAltGraph(event.nativeEvent)) return;
    event.preventDefault();
    if (event.repeat || modifiers.has(event.key)) return;
    if (event.key === "Escape") { finish(); return; }
    if (!background.recordReady) return;
    const binding = voiceShortcutFromEvent(event.nativeEvent);
    if (!binding) { setFeedback("unsupported"); return; }
    // A hidden talk binding still owns its chord, so the message names it.
    const duplicate = voiceShortcutActions.find(other => other !== action && matchesVoiceShortcut(bindings[other], binding));
    if (duplicate) { setFeedback({ duplicate }); return; }
    save({ [action]: binding });
    finish();
  };

  return <section className="c3-voice-shortcuts" aria-labelledby={id}>
    <header>
      <strong id={id}>{t("voice.shortcuts.title")}</strong>
      <Btn icon="refresh" title="voice.shortcuts.reset" textTooltip quiet size="compact" onClick={reset} />
    </header>
    {background.available ? <>
      <SwitchItem checked={background.enabled} onChange={background.enable} label={t("voice.shortcuts.background")} />
      <p role="status">{t(background.error === "in_use" ? "voice.shortcuts.backgroundInUse"
        : background.error ? "voice.shortcuts.backgroundFailed" : background.pending && !recording ? "voice.shortcuts.backgroundPending"
          : background.report && (background.report.microphone === "registered" || background.report.listening === "registered")
            ? "voice.shortcuts.backgroundEnabled" : "voice.shortcuts.scope")}</p>
    </> : <p>{t("voice.shortcuts.scope")}</p>}
    {voiceShortcutActions.filter(action => action !== "talk" || pushToTalk).map(action => {
      const name = actionName(action);
      const binding = bindings[action];
      const native = action === "talk" ? undefined : background.report?.[action];
      const editing = open && recording === action;
      const current = binding ? voiceShortcutLabel(binding, mac) : t("voice.shortcuts.unbound");
      const editLabel = t("voice.shortcuts.edit", { action: name, shortcut: current });
      const buttonId = `${id}-${action}`;
      return <div className="lr-capture-device c3-voice-shortcut-row" key={action}>
        <span>{name}</span>
        <div className="lr-capture-device-controls">
          {binding ? <kbd>{current}</kbd> : <small>{current}</small>}
          <span onKeyDown={event => record(event, action)} onBlur={finish} data-voice-shortcut-recording={editing || undefined}>
            <Tooltip text={editLabel} disabled={editing}>
              <Btn id={buttonId} icon="keyboard" title={{ text: editLabel }} quiet size="compact"
                pressed={editing} onClick={() => {
                  surface?.getElementById(buttonId)?.focus(); setFeedback(null); setRecording(action);
                }} />
            </Tooltip>
          </span>
          <Btn icon="x" title={{ text: t("voice.shortcuts.clear", { action: name }) }} textTooltip quiet size="compact"
            disabled={!binding} onClick={() => save({ [action]: null })} />
        </div>
        <p role="status">{editing ? !background.recordReady
          ? t(background.error ? "voice.shortcuts.backgroundPauseFailed" : "voice.shortcuts.backgroundPausing")
          : feedback === "unsupported" ? t("voice.shortcuts.unsupported")
            : feedback ? t("voice.shortcuts.duplicate", { action: actionName(feedback.duplicate) }) : t("voice.shortcuts.record")
          : recording ? ""
            : native === "unavailable" ? t("voice.shortcuts.backgroundBindingUnavailable")
              : native === "registered" ? t("voice.shortcuts.backgroundBindingRegistered")
                // The App registers toggles only; holding to talk stays with the focused page.
                : action === "talk" && background.enabled ? t("voice.shortcuts.scope") : ""}</p>
      </div>;
    })}
  </section>;
}
