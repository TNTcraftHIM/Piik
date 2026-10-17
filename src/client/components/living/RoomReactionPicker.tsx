import { REACTION_IDS, isThrow, type ReactionId } from "../../../shared/room-interactions";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import { ReactionIcon } from "./RoomReaction";
import { Btn } from "./primitives";
import { Tooltip } from "./Tooltip";

export interface InteractionParticipant { peerId: string; displayName: string }

/** The couch shortcut and detached room share the same choices and target semantics. */
export function RoomReactionPicker({ person, selfPeerId, hostPeerId, canSend, onSend, onBack }: {
  person: InteractionParticipant | undefined;
  selfPeerId: string | null;
  hostPeerId?: string;
  canSend: boolean;
  onSend: (reaction: ReactionId, targetPeerId?: string) => void;
  onBack?: () => void;
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
      {onBack && <Btn icon="chat" title="interaction.back" cap="interaction.back" hint="hint-chat-open" onClick={onBack} />}
    </div>
    <div className="lr-reaction-grid">
      {REACTION_IDS.filter(reaction => !isThrow(reaction) || (person && !self)).map(reaction => <button key={reaction} type="button"
        className={isThrow(reaction) ? "is-prop" : undefined}
        aria-label={t(`interaction.reaction.${reaction}`)} aria-disabled={!canSend || !person}
        onClick={() => { if (canSend && person) onSend(reaction, self ? undefined : person.peerId); }}>
        <ReactionIcon reaction={reaction} />
      </button>)}
    </div>
  </>;
}
