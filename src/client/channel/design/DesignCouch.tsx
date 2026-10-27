import { useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { REACTION_IDS, type ReactionId } from "../../../shared/room-interactions";
import { CouchBench } from "../../components/living/CouchBench";
import { RoomQuickReactions } from "../../components/living/RoomQuickReactions";
import { RoomReactionEffects } from "../../components/living/RoomReaction";
import { Tooltip } from "../../components/living/Tooltip";
import type { PawnVoice } from "../../components/living/Pawn";
import { RoomInteractionSession } from "../../lib/room-interactions";
import { useElementWidth } from "../../lib/use-element-width";
import { ChannelAction } from "../components/ChannelMedia";
import { DesignAvatar } from "./DesignAvatar";
import { DesignNames } from "./DesignNames";
import { designPeople, type DesignCopy } from "./fixtures";
import "./design-couch.css";

const SEAT_WIDTH = 70;
const SEAT_GUTTER = 24;

/** Only transport is simulated; the real session owns cooldown, acknowledgement and expiry. */
export function useDesignReactions(roomId: string, name: string) {
  const senderName = useRef(name);
  senderName.current = name;
  const session = useMemo(() => {
    const session = new RoomInteractionSession(message => {
      if (message.type === "subscribe-room-interactions") {
        queueMicrotask(() => session.receive({ type: "room-interactions-ready", serverTime: Date.now() }));
        return true;
      }
      if (message.type === "send-room-interaction") {
        queueMicrotask(() => session.receive({ type: "room-interaction", id: crypto.randomUUID(),
          requestId: message.requestId, occurredAt: Date.now(), payload: message.payload,
          sender: { peerId: designPeople[3].id, role: "viewer", displayName: senderName.current } }));
        return true;
      }
      return false;
    }, Date.now, REACTION_IDS);
    return session;
  }, [roomId]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    session.authenticated(designPeople[3].id);
    return () => session.disconnected();
  }, [session]);
  return {
    state, now: session.now,
    canSend: state.ready && !state.pending && !state.coolingDown,
    send(reaction: ReactionId, targetPeerId?: string) {
      session.send({ kind: "reaction", reaction, ...(targetPeerId ? { targetPeerId } : {}) });
    },
  };
}
export type DesignReactionsModel = ReturnType<typeof useDesignReactions>;

/** Room presence owns the couch; watching or sharing does not remount it. */
export function DesignCouch({ people, selfVoice, copy, reactions }: {
  people: number[]; selfVoice: boolean | PawnVoice; copy: DesignCopy; reactions: DesignReactionsModel;
}) {
  const name = useContext(DesignNames);
  const [container, availableWidth] = useElementWidth();
  const guests = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ index: number; trigger: HTMLButtonElement } | null>(null);
  const pickerId = useId();
  const others = people.filter(index => index !== 3);
  const width = Math.min(availableWidth, Math.max(144, people.length * SEAT_WIDTH + 2 * SEAT_GUTTER));
  const guestSeats = Math.max(1, Math.floor((width - 2 * SEAT_GUTTER) / SEAT_WIDTH) - Number(people.includes(3)));
  const guestWidth = Math.min(others.length, guestSeats) * SEAT_WIDTH;
  const overflow = others.length * SEAT_WIDTH > guestWidth;
  const previousLabel = copy("向左查看朋友", "See friends to the left");
  const nextLabel = copy("向右查看朋友", "See friends to the right");
  const selected = target ? designPeople[target.index] : null;
  const visiblePeople = people.filter(index => {
    if (index === 3) return true;
    const seat = others.indexOf(index);
    return seat * SEAT_WIDTH >= offset - 1 && (seat + 1) * SEAT_WIDTH <= offset + guestWidth + 1;
  }).map(index => ({ peerId: designPeople[index].id }));
  function browse(direction: number) {
    setTarget(null);
    guests.current?.scrollBy({ left: direction * guestWidth });
  }
  function seat(index: number) {
    const person = designPeople[index];
    const displayName = name(index);
    const action = index === 3 ? copy("发表情", "Express yourself") : copy(`和${displayName}互动`, `Interact with ${displayName}`);
    return <span key={person.id} className="cd-couch-seat" data-room-peer={person.id}>
      <Tooltip kind="hint-reaction-picker" disabled={target?.index === index}
        text={action} overflow={{ text: displayName, selector: ".lr-pawn-name" }}>
        <button type="button" className={"lr-pawn" + (index === 3 ? " is-you" : "")}
          aria-label={action} aria-expanded={target?.index === index} aria-controls={pickerId}
          onClick={event => setTarget({ index, trigger: event.currentTarget })}>
          <DesignAvatar index={index} voice={index === 3 ? selfVoice : true} />
          <span className="lr-pawn-name">{displayName}</span>
        </button>
      </Tooltip>
    </span>;
  }
  return <section className="cd-lounge" aria-label={copy("房间里的朋友", "Friends in this room")}
    style={{ "--cd-seat-width": `${SEAT_WIDTH}px`, "--cd-seat-gutter": `${SEAT_GUTTER}px` } as CSSProperties}>
    <div ref={container} className="cd-lounge-width">
      <div ref={area} className="cd-couch-scene" style={{ width }}>
        <div className="cd-couch-bench"><CouchBench width={width / 0.75} /></div>
        <div className="cd-couch-people">
          <div ref={guests} className="cd-couch-guests" style={{ width: guestWidth }} onScroll={event => {
            setOffset(event.currentTarget.scrollLeft);
            if (target && target.index !== 3) {
              const viewport = event.currentTarget.getBoundingClientRect();
              const anchor = target.trigger.getBoundingClientRect();
              if (anchor.right <= viewport.left || anchor.left >= viewport.right) setTarget(null);
            }
          }}>{others.map(seat)}</div>
          {people.includes(3) && seat(3)}
        </div>
        {overflow && <>
          <span className="cd-couch-browse is-previous">
            <ChannelAction icon="arrowLeft" iconOnly label={previousLabel} hint="hint-reaction-picker"
              disabled={offset < 1} onClick={() => browse(-1)} />
          </span>
          <span className="cd-couch-browse is-next">
            <ChannelAction icon="arrowRight" iconOnly label={nextLabel} hint="hint-reaction-picker"
              disabled={offset >= others.length * SEAT_WIDTH - guestWidth - 1} onClick={() => browse(1)} />
          </span>
        </>}
      </div>
    </div>
    {/* Keep motion in the panel's top layer when this couch is in a floating view. */}
    {area.current && createPortal(
      <RoomReactionEffects reactions={reactions.state.reactions} participants={visiblePeople} area={area} now={reactions.now} />,
      area.current.closest(".lr-floating-panel") ?? area.current.ownerDocument.body,
    )}
    {target && selected && <RoomQuickReactions key={selected.id} id={pickerId} trigger={target.trigger} side="below"
      person={{ peerId: selected.id, displayName: name(target.index) }}
      selfPeerId={designPeople[3].id} hostPeerId={designPeople[0].id} reactionIds={reactions.state.reactionIds} canSend={reactions.canSend}
      onSend={reactions.send} onClose={() => setTarget(null)} />}
  </section>;
}
