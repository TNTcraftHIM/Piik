import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CouchBench } from "../../components/living/CouchBench";
import { PawnSvg, type PawnState } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { RoomQuickReactions } from "../../components/living/RoomQuickReactions";
import { RoomReactionEffects } from "../../components/living/RoomReaction";
import { Tooltip } from "../../components/living/Tooltip";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { useElementWidth } from "../../lib/use-element-width";
import { useCopy } from "../../ui/copy";
import { useSurfaceDocument } from "../../ui/panel-window";
import { ChannelAction } from "./ChannelMedia";
import "./channel-couch.css";

export interface ChannelCouchPerson {
  userId: string;
  name: string;
  owner?: boolean;
  voice?: PawnState["voice"];
  collaboration?: boolean;
}

const SEAT_WIDTH = 70;
const SEAT_GUTTER = 24;
const noSubscription = () => () => {};
const noSnapshot = () => null;

/** Presence supplies people; the existing interaction session owns every effect and send. */
export function ChannelCouch({ people, selfUserId, session, className = "", floating = false }: {
  people: readonly ChannelCouchPerson[]; selfUserId: string | null;
  session: RoomInteractionSession | null; className?: string; floating?: boolean;
}) {
  const { lang, t, vis } = useCopy();
  const copy = (chinese: string, english: string) => lang === "zh" ? chinese : english;
  const state = useSyncExternalStore<ReturnType<RoomInteractionSession["getSnapshot"]> | null>(
    session?.subscribe ?? noSubscription, session?.getSnapshot ?? noSnapshot,
  );
  const surfaceDocument = useSurfaceDocument();
  const [container, availableWidth] = useElementWidth();
  const guests = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ userId: string; trigger: HTMLButtonElement } | null>(null);
  const pickerId = useId();
  const self = people.find(person => person.userId === selfUserId);
  const others = people.filter(person => person.userId !== selfUserId);
  const selected = people.find(person => person.userId === target?.userId);
  const width = Math.min(availableWidth, Math.max(144, people.length * SEAT_WIDTH + 2 * SEAT_GUTTER));
  const guestSeats = Math.max(1, Math.floor((width - 2 * SEAT_GUTTER) / SEAT_WIDTH) - Number(Boolean(self)));
  const guestWidth = Math.min(others.length, guestSeats) * SEAT_WIDTH;
  const overflow = others.length * SEAT_WIDTH > guestWidth;
  const visiblePeople = people.filter(person => {
    if (person.userId === selfUserId) return true;
    const seat = others.indexOf(person);
    return seat * SEAT_WIDTH >= offset - 1 && (seat + 1) * SEAT_WIDTH <= offset + guestWidth + 1;
  }).map(person => ({ peerId: person.userId }));
  useEffect(() => { setTarget(null); }, [session?.key]);
  useLayoutEffect(() => { setTarget(null); }, [floating, surfaceDocument]);
  useEffect(() => {
    if (target && (!selected || !target.trigger.isConnected)) setTarget(null);
  }, [target, selected]);
  function browse(direction: number) {
    setTarget(null);
    guests.current?.scrollBy({ left: direction * guestWidth });
  }
  function seat(person: ChannelCouchPerson) {
    const active = target?.userId === person.userId;
    const action = t(person.userId === selfUserId ? "interaction.express" : "interaction.withPerson", { name: person.name });
    const inner = <>
      <PawnSvg color={participantColor(person.userId)} identity={person.userId} host={person.owner}
        voice={person.voice} collaboration={person.collaboration} />
      <span className="lr-pawn-name">{person.name}</span>
    </>;
    const pawnClass = `lr-pawn${person.userId === selfUserId ? " is-you" : ""}${session ? "" : " is-static"}`;
    const overflow = { text: person.name, selector: ".lr-pawn-name" };
    const hint = session ? { kind: "hint-reaction-picker" as const, text: vis ? undefined : action, overflow } : { overflow };
    return <span key={person.userId} className="c3-couch-seat" data-room-peer={person.userId}>
      <Tooltip {...hint} disabled={active}>
        {session ? <button type="button" className={pawnClass} aria-label={action}
          aria-expanded={active} aria-controls={pickerId}
          onClick={event => setTarget({ userId: person.userId, trigger: event.currentTarget })}>{inner}</button>
          : <span className={pawnClass}>{inner}</span>}
      </Tooltip>
    </span>;
  }
  return <section className={`c3-couch ${className}`} aria-label={copy("房间里的朋友", "Friends in this room")}
    style={{ "--c3-couch-seat": `${SEAT_WIDTH}px`, "--c3-couch-gutter": `${SEAT_GUTTER}px` } as CSSProperties}>
    <div ref={container} className="c3-couch-width">
      <div ref={area} className="c3-couch-scene" style={{ width }}>
        <div className="c3-couch-bench"><CouchBench width={width / 0.75} /></div>
        <div className="c3-couch-people">
          <div ref={guests} className="c3-couch-guests" style={{ width: guestWidth }} onScroll={event => {
            setOffset(event.currentTarget.scrollLeft);
            if (target && target.userId !== selfUserId) {
              const viewport = event.currentTarget.getBoundingClientRect();
              const anchor = target.trigger.getBoundingClientRect();
              if (anchor.right <= viewport.left || anchor.left >= viewport.right) setTarget(null);
            }
          }}>{others.map(seat)}</div>
          {self && seat(self)}
        </div>
        {overflow && <>
          <span className="c3-couch-browse is-previous">
            <ChannelAction icon="arrowLeft" iconOnly label={copy("向左查看朋友", "See friends to the left")} hint="hint-reaction-picker"
              disabled={offset < 1} onClick={() => browse(-1)} />
          </span>
          <span className="c3-couch-browse is-next">
            <ChannelAction icon="arrowRight" iconOnly label={copy("向右查看朋友", "See friends to the right")} hint="hint-reaction-picker"
              disabled={offset >= others.length * SEAT_WIDTH - guestWidth - 1} onClick={() => browse(1)} />
          </span>
        </>}
      </div>
    </div>
    {area.current && state && session && createPortal(
      <RoomReactionEffects reactions={state.reactions} participants={visiblePeople} area={area} now={session.now} />,
      area.current.closest(".lr-floating-panel") ?? surfaceDocument?.body ?? area.current.ownerDocument.body,
    )}
    {target && selected && state && session && <RoomQuickReactions key={selected.userId} id={pickerId} trigger={target.trigger} side="below"
      person={{ peerId: selected.userId, displayName: selected.name }} selfPeerId={selfUserId}
      hostPeerId={people.find(person => person.owner)?.userId} reactionIds={state.reactionIds}
      canSend={state.ready && !state.pending && !state.coolingDown}
      onSend={(reaction, targetUserId) => session.send({ kind: "reaction", reaction, ...(targetUserId ? { targetPeerId: targetUserId } : {}) })}
      onClose={() => setTarget(null)} />}
  </section>;
}
