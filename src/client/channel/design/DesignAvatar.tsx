import { PawnSvg, type PawnVoice } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { designPeople } from "./fixtures";

export function DesignAvatar({ index, voice = false }: {
  index: number; voice?: boolean | PawnVoice;
}) {
  const person = designPeople[index];
  return <span className="cd-avatar"><PawnSvg color={participantColor(person.id)} identity={person.id} host={index === 0}
    voice={typeof voice === "object" ? voice : voice ? { microphone: person.status !== "muted", deafened: person.status === "away" } : undefined} /></span>;
}
