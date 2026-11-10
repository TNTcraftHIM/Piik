import { isThrow, type ReactionId } from "../../../shared/room-interactions";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import { ReactionIcon } from "./RoomReaction";
import { Tooltip } from "./Tooltip";
import "./room-interactions.css";

export interface InteractionParticipant { peerId: string; displayName: string }

export function personReactionIds(reactionIds: readonly ReactionId[], person: InteractionParticipant | undefined, selfPeerId: string | null) {
  return reactionIds.filter(reaction => !isThrow(reaction) || (person && person.peerId !== selfPeerId));
}

/** The couch shortcut and detached room share the same choices and target semantics. */
export function RoomReactionPicker({ person, selfPeerId, hostPeerId, reactionIds, canSend, onSend }: {
  person: InteractionParticipant | undefined;
  selfPeerId: string | null;
  hostPeerId?: string;
  reactionIds: readonly ReactionId[];
  canSend: boolean;
  onSend: (reaction: ReactionId, targetPeerId?: string) => void;
}) {
  return <>
    <RoomReactionTarget person={person} selfPeerId={selfPeerId} hostPeerId={hostPeerId} />
    <RoomReactionGrid reactionIds={personReactionIds(reactionIds, person, selfPeerId)} canSend={canSend && !!person}
      onSend={reaction => { if (person) onSend(reaction, person.peerId === selfPeerId ? undefined : person.peerId); }} />
  </>;
}

export function RoomReactionTarget({ person, selfPeerId, hostPeerId }: {
  person: InteractionParticipant | undefined; selfPeerId: string | null; hostPeerId?: string;
}) {
  const { t, vis } = useCopy();
  const self = person?.peerId === selfPeerId;
  return <div className="lr-person-menu-target" role="group"
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
  </div>;
}

export function RoomReactionGrid({ reactionIds, canSend, onSend, compact = false }: {
  reactionIds: readonly ReactionId[];
  canSend: boolean;
  onSend: (reaction: ReactionId) => void;
  compact?: boolean;
}) {
  const { t } = useCopy();
  return <div className={`lr-reaction-grid${compact ? " is-compact" : ""}`}>
    {reactionIds.map(reaction => <Tooltip key={reaction} kind="hint-reaction-picker" text={t(`interaction.reaction.${reaction}`)}><button type="button"
      className={`lr-btn is-compact is-quiet lr-reaction-option${isThrow(reaction) ? " is-prop" : ""}`}
      aria-label={t(`interaction.reaction.${reaction}`)} aria-disabled={!canSend}
      onClick={() => { if (canSend) onSend(reaction); }}>
      <ReactionIcon reaction={reaction} />
    </button></Tooltip>)}
  </div>;
}
