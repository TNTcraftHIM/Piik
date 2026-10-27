import { PawnSvg, type PawnVoice } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import { designPeople } from "./fixtures";

export type DesignPersonAction = (index: number, trigger: HTMLElement) => void;

export function DesignAvatar({ index, voice = false, onInteract }: {
  index: number; voice?: boolean | PawnVoice; onInteract?: DesignPersonAction;
}) {
  const person = designPeople[index];
  const { lang, t } = useCopy();
  const label = t("interaction.withPerson", { name: lang === "zh" ? person.name : person.english });
  const pawn = <PawnSvg color={participantColor(person.id)} identity={person.id} host={index === 0}
    voice={typeof voice === "object" ? voice : voice ? { microphone: person.status !== "muted", deafened: person.status === "away" } : undefined} />;
  return onInteract ? <Tooltip kind="hint-reaction-picker" text={label} className="cd-avatar-action">
    <button type="button" className="cd-avatar cd-avatar-button" aria-label={label} onClick={event => onInteract(index, event.currentTarget)}>{pawn}</button>
  </Tooltip> : <span className="cd-avatar">{pawn}</span>;
}
