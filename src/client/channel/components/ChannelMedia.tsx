import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

/** Literal prototype copy, shared production geometry and guidance. */
export function ChannelAction({ icon, label, onClick, disabled, busy, pressed, danger, primary, hint, type = "button" }: {
  icon: GlyphName; label: string; onClick?: () => void; disabled?: boolean;
  busy?: boolean; pressed?: boolean; danger?: boolean; primary?: boolean;
  hint?: ComponentProps<typeof Tooltip>["kind"]; type?: "button" | "submit";
}) {
  const { vis } = useCopy();
  const button = <button type={type} onClick={event => { onClick?.(); if (event.detail !== 0) event.currentTarget.blur(); }} disabled={disabled || busy}
    aria-label={label} aria-pressed={pressed} aria-busy={busy || undefined}
    className={`lr-btn is-compact${danger ? " is-danger" : primary ? " is-primary" : pressed ? " is-on" : ""}`}>
    <Glyph name={busy ? "loader" : icon} size={19} className={busy ? "lr-spin" : undefined} />
    {!vis && <span className="lr-cap">{label}</span>}
  </button>;
  return hint ? <Tooltip kind={hint} text={vis ? undefined : label}>{button}</Tooltip> : button;
}

export function ChannelVideo({ stream, local, label }: { stream: MediaStream; local: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const { lang } = useCopy();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    let current = true;
    setBlocked(false);
    setReady(false);
    void element.play().catch(() => { if (current) setBlocked(true); });
    return () => { current = false; element.srcObject = null; };
  }, [stream]);
  return <div className="c3-video">
    <video ref={ref} autoPlay playsInline muted={local} controls={!local} aria-label={label}
      onLoadedData={() => setReady(true)} />
    {!ready && !blocked && <div className="c3-play-required" role="status">
      <span className="c3-frame-wait"><Glyph name="loader" className="lr-spin" size={22} />
        {lang === "zh" ? "等待画面" : "Waiting for picture"}</span>
    </div>}
    {blocked && <div className="c3-play-required"><ChannelAction icon="play"
      label={lang === "zh" ? "播放画面" : "Play screen"}
      onClick={() => { void ref.current?.play().then(() => setBlocked(false)).catch(() => {}); }} /></div>}
  </div>;
}

export function ChannelAudio({ stream, muted, label }: { stream: MediaStream; muted: boolean; label: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const { lang } = useCopy();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    let current = true;
    setBlocked(false);
    void element.play().catch(() => { if (current) setBlocked(true); });
    return () => { current = false; element.srcObject = null; };
  }, [stream]);
  return <><audio ref={ref} autoPlay muted={muted} aria-label={label} />
    {blocked && <ChannelAction icon="speaker" label={lang === "zh" ? `播放 ${label}` : `Play ${label}`}
      onClick={() => { void ref.current?.play().then(() => setBlocked(false)).catch(() => {}); }} />}</>;
}
