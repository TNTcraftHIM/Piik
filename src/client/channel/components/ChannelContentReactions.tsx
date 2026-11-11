import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { REACTION_IDS } from "../../../shared/room-interactions";
import { ReactionBurst, ReactionIcon } from "../../components/living/RoomReaction";
import { RoomReactionGrid } from "../../components/living/RoomReactionPicker";
import { Tooltip } from "../../components/living/Tooltip";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { ContentReactionTarget, RoomInteractionSession } from "../../lib/room-interactions";
import type { MessageReactions } from "../protocol";
import "./channel-message-reactions.css";

const noSubscription = () => () => {};
const noSnapshot = () => null;

/** Counts come from committed snapshots; live events alone play one shared effect. */
export function ChannelContentReactions({ reactions, session, target, disabled = false, effectAnchor, effectsEnabled = true }: {
  reactions?: MessageReactions; session: RoomInteractionSession | null; target: ContentReactionTarget;
  disabled?: boolean;
  effectAnchor?: () => Element | null; effectsEnabled?: boolean;
}) {
  const { lang, t } = useCopy(), zh = lang === "zh";
  const state = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? noSnapshot, noSnapshot);
  const label = "messageSeq" in target ? (zh ? "回应这条消息" : "React to this message") : (zh ? "回应此画面" : "React to this screen");
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const [open, setOpen] = useState(false);
  const targetId = "messageSeq" in target ? target.messageSeq : target.publicationId;
  // Mounting history or returning to a view must not replay already received events.
  const existingEvents = useMemo(() => new Set(state?.reactions.map(event => event.id)), [session, targetId, effectsEnabled]);
  useLayoutEffect(() => {
    if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
  }, [session, targetId]);
  useAnchoredPopover(trigger, menu, { side: "above", align: "center", enabled: open });
  const canSend = !!state?.ready && !disabled && !state.pending && !state.coolingDown;
  const send = (reaction: typeof REACTION_IDS[number]) => { if (canSend) session?.send({ kind: "reaction", reaction }, target); };
  const counts = REACTION_IDS.filter(reaction => (reactions?.counts[reaction] ?? 0) > 0).map(reaction => {
    const count = reactions!.counts[reaction]!;
    return <button key={reaction} className="lr-chip c3-message-reaction" type="button"
      aria-label={`${t(`interaction.reaction.${reaction}`)} ${count}`} disabled={!canSend} onClick={() => send(reaction)}>
      <ReactionIcon reaction={reaction} /><span>{count}</span>
    </button>;
  });
  const effects = effectsEnabled && state?.reactions.filter(event => !existingEvents.has(event.id) && event.contentTarget && ("messageSeq" in target
    ? "messageSeq" in event.contentTarget && event.contentTarget.messageSeq === target.messageSeq
    : "publicationId" in event.contentTarget && event.contentTarget.publicationId === target.publicationId));
  return <div className="c3-message-reactions" data-has-counts={counts.length > 0 || undefined}>
    <span className="c3-message-reaction-counts">{counts}</span>
    <Tooltip kind="hint-reaction-picker" className="c3-message-action" disabled={open} text={label}>
      <button ref={trigger} popoverTarget={id} className="lr-btn is-dense is-quiet c3-add-reaction" type="button" aria-label={label}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={id} disabled={disabled || !session}>
        <Glyph name="smile" size={16} /><Glyph name="plus" size={10} />
      </button>
    </Tooltip>
    <div ref={menu} id={id} popover="auto" role="dialog" className="lr-floating-surface c3-message-reaction-menu"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }} aria-label={label}>
      {open && <><strong>{label}</strong>
        <RoomReactionGrid reactionIds={state?.reactionIds ?? REACTION_IDS} canSend={canSend} onSend={send} />
      </>}
    </div>
    {session && effects && effects.map(event => event.payload.kind === "reaction" && <ReactionBurst key={event.id}
      reaction={event.payload.reaction} id={event.id} expiresAt={event.expiresAt} now={session.now} anchor={effectAnchor} />)}
  </div>;
}
