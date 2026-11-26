import { isDocumentActive, onDocumentInactive } from "../ui/document-active";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { readRoomPreferences, saveRoomPreferences } from "../lib/room-preferences";
import { panelWindowAPI, useSurfaceDocument } from "../ui/panel-window";
import { isComposingOrAltGraph } from "../ui/shortcut-key";
import type { BackgroundVoiceShortcuts } from "./app-link";
import { useBackgroundVoiceShortcuts } from "./use-background-voice-shortcuts";
import {
  matchesVoiceShortcut, releasesVoiceShortcut, voiceShortcutDefaults, voiceShortcutFromEvent, voiceShortcutsWithDefaults,
  voiceToggleActions, type VoiceShortcutAction, type VoiceShortcutBinding, type VoiceShortcuts, type VoiceToggleAction,
} from "./voice-shortcut-binding";

function ownsKeyboard(target: EventTarget): boolean {
  // The tool window has its own DOM realm.
  const element = target as HTMLElement;
  return element.nodeType === 1 && (element.isContentEditable
    || Boolean(element.closest("input, textarea, select, .lr-remote-input-surface, .lr-remote-keyboard, [data-voice-shortcut-recording]")));
}

function focusedInputOwnsKeyboard() {
  return [document, panelWindowAPI(window)?.window?.document].some(owner =>
    owner && isDocumentActive(owner) && owner.activeElement && ownsKeyboard(owner.activeElement));
}

// RegisterHotKey intercepts the chord before the focused editor or remote picture sees it.
function observeInputFocus(changed: () => void) {
  const api = panelWindowAPI(window);
  let panel: Window | null = null;
  const observe = (view: Window) => {
    view.addEventListener("piik-window-activity", changed);
    view.addEventListener("focus", changed, true);
    view.addEventListener("blur", changed, true);
  };
  const forget = (view: Window) => {
    view.removeEventListener("piik-window-activity", changed);
    view.removeEventListener("focus", changed, true);
    view.removeEventListener("blur", changed, true);
  };
  const close = () => {
    if (panel) { forget(panel); panel.removeEventListener("pagehide", close); panel = null; }
    changed();
  };
  const attach = () => {
    close();
    panel = api?.window ?? null;
    if (panel) { observe(panel); panel.addEventListener("pagehide", close); }
    changed();
  };
  observe(window);
  api?.addEventListener("enter", attach);
  attach();
  return () => { forget(window); api?.removeEventListener("enter", attach); close(); };
}

const idle = () => () => {};

/**
 * Page shortcuts for the voice dock. `talk` is given only in push-to-talk mode: the talk chord then
 * holds it while down, and any key-up of the chord, lost focus, a hidden or frozen page releases it.
 */
export function useVoiceShortcuts(roomId: string | undefined, toggle: (action: VoiceToggleAction) => boolean,
  native?: BackgroundVoiceShortcuts, talk?: (pressed: boolean) => void) {
  const surface = useSurfaceDocument();
  const mac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
  const [bindings, setBindings] = useState<VoiceShortcuts>(() => voiceShortcutsWithDefaults(mac, readRoomPreferences().voiceShortcuts));
  const [recording, setRecording] = useState<VoiceShortcutAction | null>(null);
  const [talking, setTalking] = useState(false);
  const held = useRef<{ binding: VoiceShortcutBinding; talk: (pressed: boolean) => void } | null>(null);
  const pushToTalk = Boolean(talk);
  const owned = useSyncExternalStore(native && roomId ? observeInputFocus : idle, focusedInputOwnsKeyboard, () => false);
  // The App registers only the toggles, so a talk change does not re-register them.
  const toggles = useMemo(() => ({ microphone: bindings.microphone, listening: bindings.listening }), [bindings.microphone, bindings.listening]);
  const background = useBackgroundVoiceShortcuts(roomId ? native : undefined, toggles, roomId, Boolean(recording) || owned, action => {
    if (!focusedInputOwnsKeyboard()) toggle(action);
  });
  const save = (next: Partial<VoiceShortcuts>) => {
    const updated = { ...bindings, ...next };
    saveRoomPreferences({ voiceShortcuts: updated });
    setBindings(updated);
  };
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (recording || event.defaultPrevented || event.repeat || isComposingOrAltGraph(event)) return;
    if (event.composedPath().some(ownsKeyboard)) return;
    const binding = voiceShortcutFromEvent(event);
    if (!binding) return;
    if (talk && matchesVoiceShortcut(bindings.talk, binding)) {
      event.preventDefault();
      if (!held.current) {
        held.current = { binding, talk };
        setTalking(true);
        talk(true);
      }
      return;
    }
    const action = voiceToggleActions.find(action => matchesVoiceShortcut(bindings[action], binding));
    if (!action || !roomId) return;
    // Windows can start delivering this chord before its registration reply reaches the page.
    if (background.pending || background.report?.[action] === "registered" || toggle(action)) event.preventDefault();
  });
  // Key-ups count wherever focus moved, editors included: nothing may keep the microphone open.
  const onRelease = useEffectEvent((event?: KeyboardEvent) => {
    const press = held.current;
    if (!press || event && !releasesVoiceShortcut(press.binding, event)) return;
    held.current = null;
    setTalking(false);
    press.talk(false);
  });
  useEffect(() => {
    if ((!roomId && !pushToTalk) || !surface) return;
    const owners = new Set([document, surface]);
    const keydown = (event: KeyboardEvent) => onShortcut(event);
    owners.forEach(owner => owner.addEventListener("keydown", keydown));
    return () => owners.forEach(owner => owner.removeEventListener("keydown", keydown));
  }, [roomId, surface, pushToTalk]);
  useEffect(() => {
    if (!surface || !talk) return;
    const owners = [...new Set([document, surface])];
    const keyup = (event: KeyboardEvent) => onRelease(event);
    const release = () => onRelease();
    const inactive = owners.map(owner => onDocumentInactive(owner, release));
    owners.forEach(owner => { owner.addEventListener("keyup", keyup, true); owner.addEventListener("freeze", release); });
    return () => {
      owners.forEach(owner => { owner.removeEventListener("keyup", keyup, true); owner.removeEventListener("freeze", release); });
      inactive.forEach(stop => stop());
      release();
    };
  }, [surface, talk]);
  return { bindings, mac, save, reset: () => save(voiceShortcutDefaults(mac)), recording, setRecording, background,
    talking: pushToTalk && talking };
}
