import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { REACTION_DURATION_MS, REACTION_IDS, type ReactionId } from "../../../shared/room-interactions";
import { CouchBench } from "../../components/living/CouchBench";
import { RoomQuickReactions } from "../../components/living/RoomQuickReactions";
import { RoomReaction } from "../../components/living/RoomReaction";
import { Tooltip } from "../../components/living/Tooltip";
import type { PawnVoice } from "../../components/living/Pawn";
import type { RoomInteraction } from "../../lib/room-interactions";
import { useElementWidth } from "../../lib/use-element-width";
import { ChannelAction } from "../components/ChannelMedia";
import { DesignAvatar } from "./DesignAvatar";
import { designPeople, type DesignCopy } from "./fixtures";
import "./design-couch.css";

const SEAT_WIDTH = 70;
const SEAT_GUTTER = 24;

/** The room owns interaction events; each view owns its seats and picker. */
export function useDesignReactions(roomId: string, copy: DesignCopy) {
  const [current, setCurrent] = useState<{ roomId: string; event: RoomInteraction & { expiresAt: number } } | null>(null);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent(null), Math.max(0, current.event.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [current]);
  return {
    activity: current?.roomId === roomId ? current.event : null,
    send(reaction: ReactionId, targetPeerId?: string) {
      const occurredAt = Date.now();
      setCurrent({ roomId, event: { type: "room-interaction", id: crypto.randomUUID(), requestId: crypto.randomUUID(), occurredAt,
        sender: { peerId: designPeople[3].id, role: "viewer", displayName: copy("你", "You") },
        payload: { kind: "reaction", reaction, targetPeerId }, expiresAt: occurredAt + REACTION_DURATION_MS } });
    },
  };
}
export type DesignReactionsModel = ReturnType<typeof useDesignReactions>;

/** Room presence owns the couch; watching or sharing does not remount it. */
export function DesignCouch({ people, selfVoice, copy, reactions }: {
  people: number[]; selfVoice: boolean | PawnVoice; copy: DesignCopy; reactions: DesignReactionsModel;
}) {
  const [container, availableWidth] = useElementWidth();
  const guests = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ index: number; trigger: HTMLButtonElement } | null>(null);
  const pickerId = useId();
  const { activity } = reactions;
  const others = people.filter(index => index !== 3);
  const width = Math.min(availableWidth, Math.max(144, people.length * SEAT_WIDTH + 2 * SEAT_GUTTER));
  const guestSeats = Math.max(1, Math.floor((width - 2 * SEAT_GUTTER) / SEAT_WIDTH) - Number(people.includes(3)));
  const guestWidth = Math.min(others.length, guestSeats) * SEAT_WIDTH;
  const overflow = others.length * SEAT_WIDTH > guestWidth;
  const previousLabel = copy("向左查看朋友", "See friends to the left");
  const nextLabel = copy("向右查看朋友", "See friends to the right");
  const selected = target ? designPeople[target.index] : null;
  const recipient = activity?.payload.kind === "reaction" ? activity.payload.targetPeerId : undefined;
  const recipientSeat = others.findIndex(index => designPeople[index].id === recipient);
  const reactionVisible = !recipient || recipient === designPeople[3].id ||
    (recipientSeat >= 0 && recipientSeat * SEAT_WIDTH >= offset - 1 && (recipientSeat + 1) * SEAT_WIDTH <= offset + guestWidth + 1);
  function browse(direction: number) {
    setTarget(null);
    guests.current?.scrollBy({ left: direction * guestWidth });
  }
  function seat(index: number) {
    const person = designPeople[index];
    const name = copy(person.name, person.english);
    const action = index === 3 ? copy("发表情", "Express yourself") : copy(`和${name}互动`, `Interact with ${name}`);
    return <span key={person.id} className="cd-couch-seat" data-room-peer={person.id}>
      <Tooltip kind="hint-reaction-picker" disabled={target?.index === index}
        text={action} overflow={{ text: name, selector: ".lr-pawn-name" }}>
        <button type="button" className={"lr-pawn" + (index === 3 ? " is-you" : "")}
          aria-label={action} aria-expanded={target?.index === index} aria-controls={pickerId}
          onClick={event => setTarget({ index, trigger: event.currentTarget })}>
          <DesignAvatar index={index} voice={index === 3 ? selfVoice : true} />
          <span className="lr-pawn-name">{name}</span>
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
    {activity && reactionVisible && area.current && createPortal(
      <RoomReaction key={activity.id} reaction={activity} area={area} now={Date.now} />,
      area.current.closest(".lr-floating-panel") ?? area.current.ownerDocument.body,
    )}
    {target && selected && <RoomQuickReactions key={selected.id} id={pickerId} trigger={target.trigger} side="below"
      person={{ peerId: selected.id, displayName: copy(selected.name, selected.english) }}
      selfPeerId={designPeople[3].id} hostPeerId={designPeople[0].id} reactionIds={REACTION_IDS} canSend
      onSend={reactions.send} onClose={() => setTarget(null)} />}
  </section>;
}
