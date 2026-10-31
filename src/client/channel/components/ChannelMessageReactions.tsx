import { useId, useRef } from "react";
import { REACTION_IDS, isThrow, type ReactionId } from "../../../shared/room-interactions";
import { ReactionIcon } from "../../components/living/RoomReaction";
import { RoomReactionGrid } from "../../components/living/RoomReactionPicker";
import { Tooltip } from "../../components/living/Tooltip";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { MessageReactions } from "../protocol";
import "./channel-message-reactions.css";

const messageReactionIds = REACTION_IDS.filter(id => !isThrow(id));

/** Saved choices supply counts; the conversation owner confirms every change. */
export function ChannelMessageReactions({ reactions, selfUserId, pending, disabled = false, onSet }: {
  reactions?: MessageReactions;
  selfUserId: string | null;
  pending: boolean;
  disabled?: boolean;
  onSet: (reaction: ReactionId, active: boolean) => void;
}) {
  const { lang, t } = useCopy();
  const label = lang === "zh" ? "回应这条消息" : "React to this message";
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useAnchoredPopover(trigger, menu, { side: "above", align: "center" });
  const choices = Object.values(reactions?.choices ?? {});
  const selected = selfUserId ? reactions?.choices[selfUserId] ?? [] : [];
  const canSet = selfUserId !== null && !disabled && !pending;
  function set(reaction: ReactionId) {
    if (canSet) onSet(reaction, !selected.includes(reaction));
  }
  return <div className="c3-message-reactions">
    {messageReactionIds.map(reaction => {
      const count = choices.filter(choice => choice.includes(reaction)).length;
      return count > 0 && <button key={reaction} className="c3-message-reaction" type="button"
        aria-label={`${t(`interaction.reaction.${reaction}`)} · ${count}`}
        aria-pressed={selected.includes(reaction)} disabled={!canSet} onClick={() => set(reaction)}>
        <ReactionIcon reaction={reaction} /><span>{count}</span>
      </button>;
    })}
    <Tooltip kind="hint-reaction-picker" className="c3-message-action" text={label}>
      <button ref={trigger} popoverTarget={id} className="c3-add-reaction" type="button" aria-label={label} disabled={disabled || !selfUserId}>
        <Glyph name="smile" size={16} /><Glyph name="plus" size={10} />
      </button>
    </Tooltip>
    <div ref={menu} id={id} popover="auto" className="lr-floating-surface c3-message-reaction-menu"
      aria-label={lang === "zh" ? "消息表情" : "Message reactions"}>
      <strong>{label}</strong>
      <RoomReactionGrid person={selfUserId ? { peerId: selfUserId, displayName: "" } : undefined} selfPeerId={selfUserId}
        reactionIds={messageReactionIds} canSend={canSet}
        onSend={reaction => { set(reaction); menu.current?.hidePopover(); }} />
    </div>
  </div>;
}
