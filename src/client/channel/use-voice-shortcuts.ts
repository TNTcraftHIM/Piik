import { useEffect, useEffectEvent, useState } from "react";
import { readRoomPreferences, saveRoomPreferences } from "../lib/room-preferences";
import { useSurfaceDocument } from "../ui/panel-window";
import type { BackgroundVoiceShortcuts } from "./app-link";
import { useBackgroundVoiceShortcuts } from "./use-background-voice-shortcuts";
import {
  ignoresVoiceShortcutKey, matchesVoiceShortcut, voiceShortcutActions, voiceShortcutDefaults,
  voiceShortcutFromEvent, type VoiceShortcutAction, type VoiceShortcuts,
} from "./voice-shortcut-binding";

function ownsKeyboard(target: EventTarget): boolean {
  // The tool window has its own DOM realm.
  const element = target as HTMLElement;
  return element.nodeType === 1 && (element.isContentEditable
    || Boolean(element.closest("input, textarea, select, .lr-remote-input-surface, .lr-remote-keyboard, [data-voice-shortcut-recording]")));
}

export function useVoiceShortcuts(roomId: string | undefined, toggle: (action: VoiceShortcutAction) => boolean, native?: BackgroundVoiceShortcuts) {
  const surface = useSurfaceDocument();
  const mac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
  const [bindings, setBindings] = useState<VoiceShortcuts>(() => ({
    ...voiceShortcutDefaults(mac), ...readRoomPreferences().voiceShortcuts,
  }));
  const [recording, setRecording] = useState<VoiceShortcutAction | null>(null);
  const background = useBackgroundVoiceShortcuts(roomId ? native : undefined, bindings, roomId, Boolean(recording), action => {
    const focused = surface?.hasFocus() ? surface : document.hasFocus() ? document : null;
    if (!focused?.activeElement || !ownsKeyboard(focused.activeElement)) toggle(action);
  });
  const save = (next: Partial<VoiceShortcuts>) => {
    const updated = { ...bindings, ...next };
    saveRoomPreferences({ voiceShortcuts: updated });
    setBindings(updated);
  };
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (recording || event.defaultPrevented || event.repeat || ignoresVoiceShortcutKey(event)) return;
    if (event.composedPath().some(ownsKeyboard)) return;
    const binding = voiceShortcutFromEvent(event);
    if (!binding) return;
    const action = voiceShortcutActions.find(action => matchesVoiceShortcut(bindings[action], binding));
    if (action && background.report?.[action] !== "registered" && toggle(action)) event.preventDefault();
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
