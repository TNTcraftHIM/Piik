import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NativeVoiceShortcutsReport } from "../native/wire";
import type { BackgroundVoiceShortcuts } from "./app-link";
import type { VoiceToggleAction, VoiceToggleShortcuts } from "./voice-shortcut-binding";

const unbound: VoiceToggleShortcuts = { microphone: null, listening: null };

export function useBackgroundVoiceShortcuts(port: BackgroundVoiceShortcuts | undefined, bindings: VoiceToggleShortcuts,
  roomId: string | undefined, recording: boolean, onShortcut: (action: VoiceToggleAction) => void) {
  const [claim, setClaim] = useState<BackgroundVoiceShortcuts>();
  const [lifecycle, setLifecycle] = useState({ frozen: false });
  const awaitingResume = useRef(false);
  const enabled = Boolean(port && claim === port);
  // A new Dock target waits for an ordered App reply before accepting actions.
  const request = useMemo(() => ({ port, enabled, bindings: recording ? unbound : bindings, lifecycle, roomId }),
    [port, enabled, bindings, recording, lifecycle, roomId]);
  const [response, setResponse] = useState<{ request: typeof request; report?: NativeVoiceShortcutsReport; error?: "in_use" | "failed" }>();
  const current = enabled && response?.request === request ? response : undefined;
  const report = current?.report;
  const onNativeShortcut = useEffectEvent((action: VoiceToggleAction) => {
    if (!awaitingResume.current && !recording && report?.[action] === "registered") onShortcut(action);
  });

  useEffect(() => {
    if (claim && claim !== port) setClaim(undefined);
  }, [claim, port]);

  useLayoutEffect(() => {
    if (!port || !enabled) return;
    const suspend = () => {
      awaitingResume.current = true;
      setLifecycle({ frozen: true });
      void port.configure(null).catch(() => {});
    };
    const resume = () => setLifecycle({ frozen: false });
    const unsubscribe = port.subscribe(action => onNativeShortcut(action));
    document.addEventListener("freeze", suspend);
    document.addEventListener("resume", resume);
    return () => {
      unsubscribe();
      document.removeEventListener("freeze", suspend);
      document.removeEventListener("resume", resume);
      void port.configure(null).catch(() => {});
    };
  }, [port, enabled]);

  useLayoutEffect(() => {
    if (!request.port || !request.enabled || request.lifecycle.frozen) return;
    let live = true;
    void request.port.configure(request.bindings).then(result => {
      if (!live) return;
      awaitingResume.current = false;
      setResponse({ request, report: result });
    }, error => {
      if (!live) return;
      setResponse({ request, error: error instanceof Error && error.message === "voice_shortcuts_in_use" ? "in_use" : "failed" });
    });
    return () => { live = false; };
  }, [request]);

  const enable = (value: boolean) => {
    if (value) setLifecycle({ frozen: false });
    setClaim(value ? port : undefined);
  };
  return { available: Boolean(port), enabled, enable,
    report, error: current?.error, pending: enabled && !current, recordReady: !enabled || Boolean(report) || current?.error === "in_use" };
}
