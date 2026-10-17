import { useRef } from "react";
import type { RoomInteraction } from "../../lib/room-interactions";
import { Glyph } from "../../ui/icons";
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import { RoomReaction } from "./RoomReaction";
import type { InteractionParticipant } from "./RoomReactionPicker";

/** The compact window shows the latest live action without adding chat history or a timer. */
export function RoomReactionActivity({ reaction, participants, hostPeerId, now }: {
  reaction: RoomInteraction & { expiresAt: number };
  participants: InteractionParticipant[];
  hostPeerId?: string;
  now: () => number;
}) {
  const area = useRef<HTMLDivElement>(null);
  if (reaction.payload.kind !== "reaction") return null;
  const { targetPeerId } = reaction.payload;
  const sender = participants.find(person => person.peerId === reaction.sender.peerId);
  const recipient = participants.find(person => person.peerId === targetPeerId);
  if (!sender || (targetPeerId && !recipient)) return null;
  return <div className="lr-interaction-activity" ref={area} aria-hidden="true">
    <div className="lr-interaction-activity-people">
      {[sender, ...(recipient ? [recipient] : [])].map((person, index) => <span key={person.peerId}>
        {index > 0 && <Glyph name="arrowRight" size={14} />}
        <span className="lr-interaction-activity-person" data-room-peer={person.peerId}>
          <PawnSvg color={participantColor(person.peerId)} identity={person.peerId} host={person.peerId === hostPeerId} />
          <span>{person.displayName}</span>
        </span>
      </span>)}
    </div>
    <RoomReaction reaction={reaction} area={area} now={now} />
  </div>;
}
