import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { REACTION_COOLDOWN_MS, reactionKinds, type ReactionMessage as PropEvent } from "../../../shared/protocol";
import type { SignalingClient } from "../../lib/signaling";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import "./reactions.css";

const art = {
    tomato: <>
      <path d="M24 12C5 4 2 33 16 40c5 3 11 3 16 0C47 33 44 4 24 12" fill="#ed6554" />
      <path d="m24 15-9-6 8 1 3-6 2 7 8 1-10 5" fill="#46956c" />
      <path d="M14 19q-4 3-3 8" stroke="#ffc4a4" strokeWidth="3" strokeLinecap="round" fill="none" />
    </>, poop: <>
      <path d="M25 5q10 10 4 15c10 0 10 8 7 10 11 2 11 12 2 13H10c-11-1-9-12 1-13-5-6 0-11 8-12 7-2 8-8 6-13" fill="#927162" />
      <path d="M14 31h20M20 22h7" stroke="#715448" strokeWidth="2" strokeLinecap="round" />
      <circle cx="20" cy="32" r="1.6" fill="#fff" /><circle cx="29" cy="32" r="1.6" fill="#fff" />
    </>, heart: <path d="M24 40 7 24C-3 11 14 1 24 14 34 1 51 11 41 24Z" fill="#e86f91" />,
} satisfies Record<PropEvent["prop"], ReactNode>;
export function PropArt({ kind }: { kind: PropEvent["prop"] }) {
  return <svg viewBox="0 0 48 48" width="32" height="32" aria-hidden="true">{art[kind]}</svg>;
}

type Flight = { event: PropEvent; from: { x: number; y: number }; to: { x: number; y: number } };
function FlyingProp({ flight, finish }: { flight: Flight; finish: (id: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const { event, from, to } = flight;
    const pose = (x: number, y: number, scale: number, angle = 0) => `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${angle}deg) scale(${scale})`;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const angle = event.id.charCodeAt(0) % 2 ? 18 : -18;
    const heart = event.prop === "heart";
    const animation = ref.current!.animate(still ? [
      { transform: pose(to.x, to.y, 1), opacity: 1 }, { transform: pose(to.x, to.y, 1), opacity: 0 },
    ] : [
      { transform: pose(from.x, from.y, .6), opacity: 0, offset: 0 },
      { transform: pose(from.x, from.y - 10, 1), opacity: 1, offset: .08 },
      { transform: pose((from.x + to.x) / 2, Math.min(from.y, to.y) - 85, 1.12, angle * 4), offset: .4 },
      { transform: pose(to.x, to.y, 1, angle * 12), offset: .7 },
      { transform: pose(to.x, to.y - (heart ? 12 : 5), heart ? 1.18 : .85), opacity: 1, offset: .8 },
      { transform: pose(to.x, to.y + (heart ? -32 : 7), heart ? 1 : .5), opacity: 0, offset: 1 },
    ], { duration: still ? 450 : 1_200, easing: "ease-in-out", fill: "forwards" });
    animation.onfinish = () => finish(event.id);
    return () => animation.cancel();
  }, [flight, finish]);
  return <span ref={ref} className="lr-flying-reaction"><PropArt kind={flight.event.prop} /></span>;
}

// One bounded effect list; no frame-by-frame wire traffic or per-seat timers.
export function Reactions({ signal, active, participants, selfPeerId }: {
  signal: SignalingClient | null; active: boolean;
  participants: readonly { key: string; name: string }[]; selfPeerId: string | null;
}) {
  const { t, vis } = useCopy();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const lastSent = useRef(-Infinity);
  const [available, setAvailable] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [target, setTarget] = useState("");
  const [flights, setFlights] = useState<Flight[]>([]);
  const finish = useCallback((id: string) => setFlights((current) => current.filter((flight) => flight.event.id !== id)), []);
  useEffect(() => {
    setFlights([]);
    setAvailable(false);
    if (!signal || !active) return;
    return signal.subscribeReactions((event) => {
      const area = root.current?.closest(".lr-scene");
      if (!area || !layer.current || document.hidden || hidden) return;
      const seat = (id: string) => area.querySelector(`[data-participant-key="${CSS.escape(id)}"] .lr-pawn`);
      const source = seat(event.fromPeerId)?.getBoundingClientRect();
      const target = seat(event.targetPeerId)?.getBoundingClientRect();
      if (!source || !target) return;
      const bounds = layer.current.getBoundingClientRect();
      const from = { x: source.x + source.width / 2 - bounds.x, y: source.y - bounds.y + 18 };
      const to = { x: target.x + target.width / 2 - bounds.x, y: target.y - bounds.y + 18 };
      setFlights((current) => [...current, { event, from, to }].slice(-8));
    }, setAvailable);
  }, [signal, active, hidden]);
  useEffect(() => {
    if (!cooling) return;
    const timer = window.setTimeout(() => setCooling(false), REACTION_COOLDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [cooling]);
  useEffect(() => {
    const menu = panel.current;
    const button = trigger.current;
    if (!menu || !button) return;
    // As with the language menu, the native popover owns dismissal and focus.
    const place = () => {
      if (!menu.matches(":popover-open")) return;
      const rect = button.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight) { menu.hidePopover(); return; }
      menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 8)}px`;
    };
    menu.addEventListener("toggle", place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      menu.removeEventListener("toggle", place);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [available, active]);
  if (!available || !active) return null;
  const selected = participants.find((entry) => entry.key === target)?.key
    ?? participants.find((entry) => entry.key !== selfPeerId)?.key ?? selfPeerId ?? "";
  const present = new Set(participants.map((entry) => entry.key));
  return <div className={`lr-reactions${cooling ? " is-cooling" : ""}`} ref={root}
    style={{ "--reaction-cooldown": `${REACTION_COOLDOWN_MS}ms` } as CSSProperties}>
    <button ref={trigger} type="button" className="lr-btn lr-reaction-trigger" aria-label={t("reactions.title")}
      popoverTarget={panelId} aria-controls={panelId}>
      <Glyph name="heart" size={18} /><Glyph name="chevron" size={10} />
    </button>
    <div className="lr-reaction-panel" id={panelId} ref={panel} popover="auto"
      role="group" aria-label={t("reactions.title")}
      onBlur={(event) => {
        if (event.relatedTarget && event.relatedTarget !== trigger.current &&
          !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.hidePopover();
      }}>
      <label className="lr-reaction-target">
        {!vis && <span>{t("reactions.target")}</span>}
        <select aria-label={t("reactions.target")} value={selected} onChange={(event) => setTarget(event.target.value)}>
          {participants.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}
        </select>
      </label>
      <div className="lr-reaction-actions">
        {reactionKinds.map((prop) => <button key={prop} type="button" className="lr-btn"
          aria-label={t(`reactions.${prop}`)} disabled={!selected || cooling}
          onClick={() => {
            const now = performance.now();
            if (now - lastSent.current < REACTION_COOLDOWN_MS) return;
            if (signal?.sendReaction(selected, prop)) {
              lastSent.current = now;
              setCooling(true);
              panel.current?.hidePopover();
            }
          }}><PropArt kind={prop} /></button>)}
      </div>
      <label className="lr-reaction-hide"><input type="checkbox" checked={hidden} aria-label={t("reactions.hide")}
        onChange={(event) => setHidden(event.target.checked)} />{vis ? <Glyph name="eyeOff" size={16} /> : t("reactions.hide")}</label>
    </div>
    <div className="lr-reaction-effects" ref={layer} aria-hidden="true">
      {!hidden && flights.filter(({ event }) => present.has(event.fromPeerId) && present.has(event.targetPeerId)).map((flight) =>
        <FlyingProp key={flight.event.id} flight={flight} finish={finish} />)}
    </div>
  </div>;
}
