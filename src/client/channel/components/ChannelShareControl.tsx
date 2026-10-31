import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaptureSourcePicker, type NativeSourceList } from "../../components/living/CaptureSourcePicker";
import { Btn } from "../../components/living/primitives";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { activateNativePicker } from "../../native/activation";
import type { ChannelController } from "../types";
import "./channel-share-control.css";

const noPreview = async () => null;

export function ChannelShareControl({ channel, roomId, disabled }: {
  channel: ChannelController; roomId: string; disabled: boolean;
}) {
  const { lang } = useCopy();
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const request = useRef<object | null>(null);
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<NativeSourceList>({ kind: "browser" });
  const { appConnected, nativeSources, startNativeScreen, startScreen } = channel;
  const browserSupported = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const busy = channel.pending.has(`screen:${roomId}`);
  const captureRequest = channel.nativeCaptureRequest(roomId);
  const available = browserSupported || appConnected;
  const label = lang === "zh" ? "分享屏幕" : "Share screen";
  useAnchoredPopover(trigger, panel, { maxHeight: 560, minVisibleHeight: 240 });
  const close = useCallback(() => { panel.current?.hidePopover(); }, []);
  const refresh = useCallback(() => {
    const current = request.current = {};
    if (!appConnected) { setSources({ kind: "browser" }); return; }
    setSources(previous => ({ kind: "loading", appDetected: true,
      sources: previous.kind === "ready" ? previous.sources : undefined }));
    void nativeSources().then(result => {
      if (request.current === current) setSources({ kind: "ready", ...result });
    }, () => {
      if (request.current === current) setSources({ kind: "failed" });
    });
  }, [appConnected, nativeSources]);
  useEffect(() => {
    if (open) refresh();
    return () => { request.current = null; };
  }, [open, refresh]);
  useLayoutEffect(() => { close(); }, [roomId, disabled, close]);
  const start = (operation: () => Promise<void>) => {
    close();
    void operation().catch(() => {}); // The session owns the operation's error.
  };
  return <>
    <span ref={trigger} className="c3-share-control">
      {captureRequest ? <>
        <Btn icon="window" title="native.confirmInApp" cap="native.confirmInApp" size="compact" tone="primary"
          onClick={() => activateNativePicker(captureRequest.activationURL)} />
        <Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" quiet
          onClick={() => { void channel.stopScreen(captureRequest.publicationId).catch(() => {}); }} />
      </> : <Btn icon="cast" title={{ text: label }} cap={{ text: label }} size="compact" tone="primary"
        hint={available ? "hint-share-start" : "hint-no-sources"} hintText={available ? undefined : "host.capture.noSource"}
        disabled={disabled || busy || !available} busy={busy} expanded={appConnected || open ? open : undefined}
        controls={appConnected || open ? id : undefined} popoverTarget={appConnected ? id : undefined}
        onClick={() => { if (!appConnected) start(() => startScreen(roomId)); }} />}
    </span>
    <div ref={panel} id={id} popover="auto" className="lr-anchored-card c3-share-picker"
      onToggle={event => setOpen(event.newState === "open")}>
      {open && <CaptureSourcePicker nativeSources={sources} browserSupported={browserSupported} cameraSupported={false}
        initialTab="window" selectionDisabled={disabled || busy}
        onBrowser={() => start(() => startScreen(roomId))}
        onNative={(target, audio) => start(() => startNativeScreen(roomId, target, audio))}
        onPreview={noPreview} onRefresh={refresh} onCancel={() => {
          close(); trigger.current?.querySelector("button")?.focus({ preventScroll: true });
        }} />}
    </div>
  </>;
}
