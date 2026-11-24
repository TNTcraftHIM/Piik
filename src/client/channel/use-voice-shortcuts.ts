import { isDocumentActive } from "../ui/document-active";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { readRoomPreferences, saveRoomPreferences } from "../lib/room-preferences";
import { panelWindowAPI, useSurfaceDocument } from "../ui/panel-window";
import { isComposingOrAltGraph } from "../ui/shortcut-key";
import type { BackgroundVoiceShortcuts } from "./app-link";
import { useBackgroundVoiceShortcuts } from "./use-background-voice-shortcuts";
import {
  matchesVoiceShortcut, voiceShortcutActions, voiceShortcutDefaults,
  voiceShortcutFromEvent, type VoiceShortcutAction, type VoiceShortcuts,
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

export function useVoiceShortcuts(roomId: string | undefined, toggle: (action: VoiceShortcutAction) => boolean, native?: BackgroundVoiceShortcuts) {
  const surface = useSurfaceDocument();
  const mac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
  const [bindings, setBindings] = useState<VoiceShortcuts>(() => ({
    ...voiceShortcutDefaults(mac), ...readRoomPreferences().voiceShortcuts,
  }));
  const [recording, setRecording] = useState<VoiceShortcutAction | null>(null);
  const owned = useSyncExternalStore(native && roomId ? observeInputFocus : idle, focusedInputOwnsKeyboard, () => false);
  const background = useBackgroundVoiceShortcuts(roomId ? native : undefined, bindings, roomId, Boolean(recording) || owned, action => {
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
    const action = voiceShortcutActions.find(action => matchesVoiceShortcut(bindings[action], binding));
    if (!action) return;
    // Windows can start delivering this chord before its registration reply reaches the page.
    if (background.pending || background.report?.[action] === "registered" || toggle(action)) event.preventDefault();
  });
  useEffect(() => {
    if (!roomId || !surface) return;
    const owners = new Set([document, surface]);
    const keydown = (event: KeyboardEvent) => onShortcut(event);
    owners.forEach(owner => owner.addEventListener("keydown", keydown));
    return () => owners.forEach(owner => owner.removeEventListener("keydown", keydown));
  }, [roomId, surface]);
  return { bindings, mac, save, reset: () => save(voiceShortcutDefaults(mac)), recording, setRecording, background };
}
