import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
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
export function ChannelContentReactions({ reactions, session, target, disabled = false, effectAnchor, effectsEnabled = true, actions, toolbarAnchor, toolbarOwner }: {
  reactions?: MessageReactions; session: RoomInteractionSession | null; target: ContentReactionTarget;
  disabled?: boolean;
  effectAnchor?: () => Element | null; effectsEnabled?: boolean;
  actions?: ReactNode;
  toolbarAnchor?: RefObject<HTMLElement | null>; toolbarOwner?: RefObject<HTMLElement | null>;
}) {
  const { lang, t } = useCopy(), zh = lang === "zh";
  const state = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? noSnapshot, noSnapshot);
  const label = "messageSeq" in target ? (zh ? "回应这条消息" : "React to this message") : (zh ? "回应此画面" : "React to this screen");
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const [open, setOpen] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const targetId = "messageSeq" in target ? target.messageSeq : target.publicationId;
  // Mounting history or returning to a view must not replay already received events.
  const existingEvents = useMemo(() => new Set(state?.reactions.map(event => event.id)), [session, targetId, effectsEnabled]);
  useLayoutEffect(() => {
    if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
  }, [session, targetId]);
  useAnchoredPopover(trigger, menu, { side: "above", align: "center", enabled: open });
  useAnchoredPopover(toolbarAnchor ?? trigger, toolbar, { side: "above", enabled: toolbarOpen });
  useEffect(() => {
    const owner = toolbarOwner?.current, panel = toolbar.current, picker = menu.current;
    if (!owner || !panel || !toolbarAnchor) return;
    const show = () => {
      // A reaction selection retains its native popover stack while the pointer crosses other messages.
      if (owner.closest(".c3-conversation")?.querySelector(".c3-message-reaction-menu:popover-open")) return;
      panel.showPopover();
    };
    const hide = () => {
      if (!owner.matches(":hover, :focus-within") && !picker?.matches(":popover-open")) panel.hidePopover();
    };
    const focus = (event: FocusEvent) => {
      if (!owner.contains(event.relatedTarget as Node | null)) show();
    };
    const blur = (event: FocusEvent) => {
      if (!owner.contains(event.relatedTarget as Node | null) && !owner.matches(":hover") && !picker?.matches(":popover-open")) panel.hidePopover();
    };
    owner.addEventListener("pointerenter", show);
    owner.addEventListener("pointerleave", hide);
    owner.addEventListener("focusin", focus);
    owner.addEventListener("focusout", blur);
    owner.addEventListener("click", show);
    picker?.addEventListener("toggle", hide);
    return () => {
      owner.removeEventListener("pointerenter", show);
      owner.removeEventListener("pointerleave", hide);
      owner.removeEventListener("focusin", focus);
      owner.removeEventListener("focusout", blur);
      owner.removeEventListener("click", show);
      picker?.removeEventListener("toggle", hide);
    };
  }, [toolbarAnchor, toolbarOwner]);
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
    <span className="c3-message-reaction-counts lr-embedded-actions">{counts}</span>
    <div ref={toolbar} popover={toolbarAnchor ? "auto" : undefined} className="c3-content-actions lr-embedded-actions"
      onToggle={event => { if (event.target === event.currentTarget) setToolbarOpen(event.newState === "open"); }}><Tooltip kind="hint-reaction-picker" className="c3-message-action" disabled={open} text={label}>
      <button ref={trigger} popoverTarget={id} className="lr-btn is-dense is-quiet c3-add-reaction" type="button" aria-label={label}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={id} disabled={disabled || !session}>
        <Glyph name="smile" size={16} /><Glyph name="plus" size={10} />
      </button>
    </Tooltip>{actions}
    <div ref={menu} id={id} popover="auto" role="dialog" className="lr-floating-surface c3-message-reaction-menu"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }} aria-label={label}>
      {open && <RoomReactionGrid reactionIds={state?.reactionIds ?? REACTION_IDS} canSend={canSend} onSend={send} />}
    </div>
    </div>
    {session && effects && effects.map(event => event.payload.kind === "reaction" && <ReactionBurst key={event.id}
      reaction={event.payload.reaction} id={event.id} expiresAt={event.expiresAt} now={session.now} anchor={effectAnchor} />)}
  </div>;
}
