import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactionId } from "../../../shared/room-interactions";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";
import { RoomReactionGrid, RoomReactionTarget, type InteractionParticipant } from "./RoomReactionPicker";
import { useAnchoredPopover } from "./use-anchored-popover";

const QUICK_REACTIONS: readonly ReactionId[] = ["thumbsup", "thumbsdown", "tomato", "poop"];
const SELF_QUICK_REACTIONS: readonly ReactionId[] = ["thumbsup", "thumbsdown", "laugh", "heart"];

/** Brief person actions leave the conversation and composer available. */
export function RoomQuickReactions({ id, trigger, person, selfPeerId, hostPeerId, reactionIds, canSend, onSend, onClose }: {
  id: string; trigger: HTMLElement; person: InteractionParticipant; selfPeerId: string | null; hostPeerId?: string;
  reactionIds: readonly ReactionId[]; canSend: boolean;
  onSend: (reaction: ReactionId, targetPeerId?: string) => void; onClose: () => void;
}) {
  const { t } = useCopy();
  const [expanded, setExpanded] = useState(false);
  const anchor = useMemo(() => ({ current: trigger }), [trigger]);
  const panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(anchor, panel, { side: "above", align: "center" });
  useLayoutEffect(() => {
    const menu = panel.current!;
    if (menu.matches(":popover-open")) menu.hidePopover();
    menu.showPopover({ source: trigger });
  }, [trigger]);
  const quick = person.peerId === selfPeerId ? SELF_QUICK_REACTIONS : QUICK_REACTIONS;
  const choices = expanded ? reactionIds : quick.filter(id => reactionIds.includes(id));
  return <div id={id} ref={panel} popover="auto" role="dialog"
    aria-label={t("interaction.withPerson", { name: person.displayName })}
    className={`lr-floating-surface lr-quick-reactions${expanded ? " is-expanded" : ""}`}
    onToggle={event => {
      if (event.target === event.currentTarget && !event.currentTarget.matches(":popover-open")) onClose();
    }}>
    <div className="lr-quick-reactions-heading">
      <Btn icon={expanded ? "arrowLeft" : "smile"} title={expanded ? "interaction.fewerReactions" : "interaction.moreReactions"}
        cap={expanded ? "common.back" : undefined} size="dense" quiet hint="hint-reaction-picker"
        expanded={expanded} onClick={() => setExpanded(value => !value)} />
      <RoomReactionTarget person={person} selfPeerId={selfPeerId} hostPeerId={hostPeerId} />
    </div>
    <RoomReactionGrid person={person} selfPeerId={selfPeerId} reactionIds={choices} canSend={canSend}
      onSend={onSend} compact={!expanded} />
  </div>;
}
