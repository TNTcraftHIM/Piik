import { useEffect, useId, useRef } from "react";
import { Btn } from "./primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

export function HostMicrophone({ enabled, pending, disabled, nativeCapture, volume, onVolume, onToggle }: {
  enabled: boolean; pending?: boolean; disabled?: boolean;
  volume: number; onVolume: (volume: number) => void;
  nativeCapture?: boolean; onToggle: () => void;
}) {
  const { t, vis } = useCopy();
  const actionsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const percent = Math.round(volume * 100);
  useEffect(() => {
    const panel = panelRef.current;
    const trigger = actionsRef.current?.querySelector<HTMLButtonElement>("[popovertarget]");
    if (!panel || !trigger) return;
    const place = () => {
      if (!panel.matches(":popover-open")) return;
      const rect = trigger.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) { panel.hidePopover(); return; }
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const openAbove = below < panel.offsetHeight && above > below;
      panel.classList.toggle("is-above", openAbove);
      panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.max(8, openAbove ? rect.top - panel.offsetHeight - 8 : rect.bottom + 8)}px`;
    };
    const opened = () => {
      if (!panel.matches(":popover-open")) return;
      place();
      panel.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    };
    panel.addEventListener("toggle", opened);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      panel.removeEventListener("toggle", opened);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, []);
  return <div className="lr-host-microphone">
    <div className="lr-host-microphone-actions" ref={actionsRef}>
    <Btn icon={enabled ? "microphone" : "microphoneOff"}
      cap="host.microphone.label"
      title={nativeCapture ? "host.microphone.browserOnly" : pending ? "host.microphone.pending"
        : enabled ? "host.microphone.mute" : "host.microphone.enable"}
      hint={enabled ? "hint-microphone-off" : "hint-microphone-on"}
      pressed={enabled} busy={pending} tone={enabled ? "on" : undefined}
      disabled={nativeCapture || pending || disabled} onClick={onToggle} />
    <Btn icon="chevron" title="host.microphone.settings" popoverTarget={id} disabled={nativeCapture} />
    </div>
    <div id={id} ref={panelRef} popover="auto" role="group" aria-label={t("host.microphone.volume")}
      className="lr-host-microphone-volume"
      onBlur={event => {
        if (event.relatedTarget !== actionsRef.current?.querySelector("[popovertarget]") &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.hidePopover();
      }}>
      <label htmlFor={`${id}-level`}>
        <span>{vis ? <Glyph name="microphone" size={18} /> : t("host.microphone.volume")}</span>
        <output htmlFor={`${id}-level`}>{percent}%</output>
      </label>
      <input id={`${id}-level`} type="range" min={0} max={200} step={1} value={percent}
        aria-label={t("host.microphone.volume")} aria-valuetext={`${percent}%`}
        onChange={event => onVolume(Number(event.target.value) / 100)} />
    </div>
  </div>;
}
