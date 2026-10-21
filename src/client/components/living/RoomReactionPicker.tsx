import { isThrow, type ReactionId } from "../../../shared/room-interactions";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import { ReactionIcon } from "./RoomReaction";
import { Tooltip } from "./Tooltip";

export interface InteractionParticipant { peerId: string; displayName: string }

/** The couch shortcut and detached room share the same choices and target semantics. */
export function RoomReactionPicker({ person, selfPeerId, hostPeerId, reactionIds, canSend, onSend }: {
  person: InteractionParticipant | undefined;
  selfPeerId: string | null;
  hostPeerId?: string;
  reactionIds: readonly ReactionId[];
  canSend: boolean;
  onSend: (reaction: ReactionId, targetPeerId?: string) => void;
}) {
  const { t, vis } = useCopy();
  const self = person?.peerId === selfPeerId;
  return <>
    <div className="lr-person-menu-target" role="group"
      aria-label={person ? t("interaction.withPerson", { name: person.displayName }) : t("interaction.express")}>
      <span className="lr-person-menu-name">
        <span className="lr-person-menu-portrait">{person
          ? <PawnSvg color={participantColor(person.peerId)} host={person.peerId === hostPeerId} />
          : <Glyph name="smile" size={22} />}</span>
        <span>{!vis && <small>{t(self ? "interaction.express" : "interaction.toPerson")}</small>}
          <Tooltip overflow={{ text: person?.displayName ?? t("interaction.participant"), selector: "b" }}>
            <b>{person?.displayName ?? t("interaction.participant")}</b>
          </Tooltip></span>
      </span>
    </div>
    <RoomReactionGrid person={person} selfPeerId={selfPeerId} reactionIds={reactionIds} canSend={canSend} onSend={onSend} />
  </>;
}

export function RoomReactionGrid({ person, selfPeerId, reactionIds, canSend, onSend }: {
  person: InteractionParticipant | undefined;
  selfPeerId: string | null;
  reactionIds: readonly ReactionId[];
  canSend: boolean;
  onSend: (reaction: ReactionId, targetPeerId?: string) => void;
}) {
  const { t, vis } = useCopy();
  const self = person?.peerId === selfPeerId;
  return <div className="lr-reaction-grid">
    {reactionIds.filter(reaction => !isThrow(reaction) || (person && !self)).map(reaction => <button key={reaction} type="button"
      className={isThrow(reaction) ? "lr-btn lr-reaction-prop" : "lr-btn is-compact is-quiet lr-reaction-option"}
      aria-label={t(`interaction.reaction.${reaction}`)} aria-disabled={!canSend || !person}
      onClick={() => { if (canSend && person) onSend(reaction, self ? undefined : person.peerId); }}>
      <ReactionIcon reaction={reaction} />
      {isThrow(reaction) && !vis && <span>{t(`interaction.reaction.${reaction}`)}</span>}
    </button>)}
  </div>;
}
