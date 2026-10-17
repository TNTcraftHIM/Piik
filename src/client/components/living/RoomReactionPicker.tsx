import { REACTION_IDS, isThrow, type ReactionId } from "../../../shared/room-interactions";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import { ReactionIcon } from "./RoomReaction";

export interface InteractionParticipant { peerId: string; displayName: string }

/** The couch shortcut and detached room share the same choices and target semantics. */
export function RoomReactionPicker({ person, selfPeerId, hostPeerId, canSend, onSend }: {
  person: InteractionParticipant | undefined;
  selfPeerId: string | null;
  hostPeerId?: string;
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
          <b>{person?.displayName ?? t("interaction.participant")}</b></span>
      </span>
    </div>
    {[false, true].filter(throws => !throws || (person && !self)).map(throws =>
      <div key={String(throws)} className={throws ? "lr-reaction-props" : "lr-reaction-grid"}>
        {REACTION_IDS.filter(reaction => isThrow(reaction) === throws).map(reaction => <button key={reaction} type="button"
          aria-label={t(`interaction.reaction.${reaction}`)} aria-disabled={!canSend || !person}
          onClick={() => { if (canSend && person) onSend(reaction, self ? undefined : person.peerId); }}>
          <ReactionIcon reaction={reaction} />
          {throws && !vis && <span>{t(reaction === "tomato" ? "interaction.prop.tomato" : "interaction.prop.poop")}</span>}
        </button>)}
      </div>)}
  </>;
}
