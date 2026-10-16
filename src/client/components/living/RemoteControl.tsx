import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { RemoteControlRequest } from "../../native/wire";
import { Btn } from "./primitives";
import "./remote-control.css";

const stateSchema = z.object({
  state: z.enum(["ready", "unavailable", "pending", "active", "failed"]),
  grant: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

// The video keeps its existing media owner. This temporary surface handles
// input only while its exact direct connection holds a local App grant.
export function RemoteControl({ channel, videoRef, available }: {
  channel: RTCDataChannel | null; videoRef: RefObject<HTMLVideoElement | null>;
  available: boolean;
}) {
  const { t } = useCopy();
  const [state, setState] = useState<z.infer<typeof stateSchema> | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const grant = useRef<string | undefined>(undefined);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const active = state?.state === "active" && available && channel?.readyState === "open";
  const send = (event: object) => {
    if (channel?.readyState !== "open") return;
    // Never build up stale pointer input behind a stalled SCTP connection.
    if (channel.bufferedAmount > 8192) { channel.close(); return; }
    channel.send(JSON.stringify(event));
  };
  const input = (event: object) => send({ ...event, grant: grant.current });
  const clearPointer = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; pointer.current = null;
  };
  const release = () => { clearPointer(); send({ type: "release" }); grant.current = undefined; };

  useEffect(() => {
    setState(null); grant.current = undefined;
    if (!channel) return;
    const message = (event: MessageEvent) => {
      if (typeof event.data !== "string" || event.data.length > 1024) return;
      let decoded: unknown;
      try { decoded = JSON.parse(event.data); } catch { return; }
      const parsed = stateSchema.safeParse(decoded);
      if (!parsed.success) return;
      if (parsed.data.state === "active" && videoRef.current?.paused) {
        release();
        return;
      }
      clearPointer();
      grant.current = parsed.data.grant;
      setState(parsed.data);
    };
    const closed = () => { grant.current = undefined; setState(null); clearPointer(); };
    channel.addEventListener("message", message);
    channel.addEventListener("close", closed);
    send({ type: "sync" });
    return () => {
      if (channel.readyState === "open") channel.send(JSON.stringify({ type: "release" }));
      channel.removeEventListener("message", message); channel.removeEventListener("close", closed);
      clearPointer(); grant.current = undefined;
    };
  }, [channel]);
  useEffect(() => {
    if (!available && channel?.readyState === "open") release();
  }, [available, channel]);
  useEffect(() => {
    const video = videoRef.current;
    video?.addEventListener("pause", release);
    return () => video?.removeEventListener("pause", release);
  }, [channel, videoRef]);
  useEffect(() => {
    if (!active) return;
    surface.current?.focus({ preventScroll: true });
    const wheel = (event: WheelEvent) => { event.preventDefault(); input({ type: "wheel", delta: -Math.sign(event.deltaY) * 120 }); };
    const element = surface.current;
    element?.addEventListener("wheel", wheel, { passive: false });
    const blur = () => { clearPointer(); input({ type: "reset" }); };
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", hidden);
    return () => { element?.removeEventListener("wheel", wheel); window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", hidden); };
  }, [active, channel]);

  if (!channel || channel.readyState !== "open" || !state) return null;
  const point = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    return { x: Math.max(0, Math.min(1, (clientX - rect.left - (rect.width - width) / 2) / width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top - (rect.height - height) / 2) / height)) };
  };
  const buttonTitle = active ? "remote.stop" : state?.state === "pending" ? "remote.cancel" : "remote.request";
  const parent = videoRef.current?.parentElement;
  return <>
    <Btn icon="mouse" title={state?.state === "unavailable" ? "remote.needsDisplay" : buttonTitle}
      pressed={active} disabled={!available || state?.state === "unavailable"}
      onClick={() => active || state?.state === "pending" ? release() : send({ type: "request" })} />
    {parent && (active || state?.state === "pending" || state?.state === "failed") && createPortal(<>
      {active && <div ref={surface} className="lr-remote-input-surface" tabIndex={0}
        aria-label={t("remote.surface")} role="application"
        onContextMenu={event => event.preventDefault()}
        onPointerMove={event => {
          pointer.current = point(event.clientX, event.clientY);
          if (frame.current !== null) return;
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (pointer.current) input({ type: "move", ...pointer.current });
            pointer.current = null;
          });
        }}
        onPointerDown={event => {
          if (event.button > 2) return;
          event.preventDefault(); surface.current?.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          clearPointer(); const position = point(event.clientX, event.clientY);
          if (position) { input({ type: "move", ...position }); input({ type: "button", button: event.button, down: true }); }
        }}
        onPointerUp={event => { input({ type: "button", button: event.button, down: false }); }}
        onPointerCancel={() => input({ type: "reset" })}
        onBlur={() => { clearPointer(); input({ type: "reset" }); }}
        onKeyDown={event => {
          event.preventDefault(); event.stopPropagation();
          if (event.code === "Escape") { release(); return; }
          if (!event.nativeEvent.isComposing) input({ type: "key", code: event.code, down: true });
        }}
        onKeyUp={event => { event.preventDefault(); event.stopPropagation(); input({ type: "key", code: event.code, down: false }); }} />}
      <div className="lr-remote-input-status" role="status">
        <span>{t(active ? "remote.active" : state?.state === "failed" ? "remote.failed" : "remote.pending")}</span>
        {active && <kbd>Esc</kbd>}
      </div>
    </>, parent)}
  </>;
}

export function RemoteControlApproval({ requests, onDecide }: {
  requests: (RemoteControlRequest & { name: string })[];
  onDecide: (id: string, allow: boolean) => Promise<void>;
}) {
  const { t } = useCopy();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const decide = async (id: string, allow: boolean) => {
    setBusy(true);
    try {
      await onDecide(id, allow);
      setFailed(false);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <section className="lr-remote-approval" aria-label={t("remote.title")}>
    <h2><Glyph name="mouse" size={18} />{t("remote.title")}</h2>
    {requests.map(request => <div className="lr-remote-request" key={request.id}>
      <div><strong>{request.name}</strong>
        <p>{t(request.active ? "remote.active" : "remote.waiting")}</p></div>
      <div className="lr-remote-request-actions">
        <Btn icon="x" title={request.active ? "remote.stop" : "remote.decline"} cap={request.active ? "remote.stop" : "remote.decline"}
          disabled={busy} onClick={() => void decide(request.id, false)} />
        {!request.active && <Btn icon="check" tone="primary" title="remote.allow" cap="remote.allow" disabled={busy} onClick={() => void decide(request.id, true)} />}
      </div>
    </div>)}
    {requests.some(request => !request.active) && <p className="lr-remote-note">{t("remote.consent")}</p>}
    {failed && <p role="alert">{t("remote.failed")}</p>}
    {requests.some(request => request.active) && <p className="lr-remote-note">{t("remote.shortcut")} <kbd>Ctrl + Alt + F10</kbd></p>}
  </section>;
}
