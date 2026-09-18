import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PropEvent } from "./protocol";
import type { InteractionSession } from "./session";

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
    const angle = parseInt(event.id.slice(0, 2), 16) % 2 ? 18 : -18;
    const animation = ref.current!.animate(still ? [
      { transform: pose(to.x, to.y, 1), opacity: 1 }, { transform: pose(to.x, to.y, 1), opacity: 0 },
    ] : [
      { transform: pose(from.x, from.y, .6), opacity: 0, offset: 0 },
      { transform: pose(from.x, from.y - 10, 1), opacity: 1, offset: .08 },
      { transform: pose((from.x + to.x) / 2, Math.min(from.y, to.y) - 85, 1.12, angle * 4), offset: .4 },
      { transform: pose(to.x, to.y, 1, angle * 12), offset: .7 },
      { transform: pose(to.x, to.y - 12, 1.18, angle * 12), opacity: 1, offset: .8 },
      { transform: pose(to.x, to.y + 7, .5, angle * 13), opacity: 0, offset: 1 },
    ], { duration: still ? 450 : 1_200, easing: "ease-in-out", fill: "forwards" });
    animation.onfinish = () => finish(event.id);
    return () => animation.cancel();
  }, [flight, finish]);
  return <span ref={ref} className="ip-flying-prop"><PropArt kind={flight.event.prop} /></span>;
}

// One bounded effect list; no frame-by-frame wire traffic or per-seat timers.
export function PropEffects({ session, area, enabled }: {
  session: InteractionSession; area: RefObject<HTMLDivElement | null>; enabled: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const finish = useCallback((id: string) => setFlights((current) => current.filter((flight) => flight.event.id !== id)), []);
  useEffect(() => {
    setFlights([]);
    if (!enabled) return;
    const unsubscribe = session.onEffect((event) => {
      if (!area.current || !layer.current) return;
      const seat = (id: string) => {
        const index = session.snapshot().members.findIndex((member) => member.id === id);
        return index < 0 ? null : area.current!.querySelectorAll(".lr-pawn")[index];
      };
      const source = seat(event.from)?.getBoundingClientRect();
      const target = seat(event.target)?.getBoundingClientRect();
      if (!source || !target) return;
      const bounds = layer.current.getBoundingClientRect();
      const from = { x: source.x + source.width / 2 - bounds.x, y: source.y - bounds.y + 18 };
      const to = { x: target.x + target.width / 2 - bounds.x, y: target.y - bounds.y + 18 };
      setFlights((current) => [...current, { event, from, to }].slice(-8));
    });
    const unsubscribeRoster = session.subscribe(() => {
      const ids = new Set(session.snapshot().members.map((member) => member.id));
      setFlights((current) => current.filter((flight) => ids.has(flight.event.from) && ids.has(flight.event.target)));
    });
    return () => { unsubscribe(); unsubscribeRoster(); };
  }, [session, area, enabled]);
  return <div className="ip-effects" ref={layer} aria-hidden="true">{enabled ? flights.map((flight) =>
    <FlyingProp key={flight.event.id} flight={flight} finish={finish} />) : null}</div>;
}
