import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { REACTION_IDS, type ReactionId } from "../../../shared/room-interactions";
import type { PawnVoice } from "../../components/living/Pawn";
import { RoomInteractionSession } from "../../lib/room-interactions";
import { ChannelCouch } from "../components/ChannelCouch";
import { DesignNames } from "./DesignNames";
import { designPeople, type DesignCopy } from "./fixtures";
import "./design-couch.css";

/** Only transport is simulated; the real session owns cooldown, acknowledgement and expiry. */
export function useDesignReactions(roomId: string, name: string) {
  const senderName = useRef(name);
  senderName.current = name;
  const session = useMemo(() => {
    const session = new RoomInteractionSession(message => {
      if (message.type === "subscribe-room-interactions") {
        queueMicrotask(() => session.receive({ type: "room-interactions-ready", serverTime: Date.now() }));
        return true;
      }
      if (message.type === "send-room-interaction") {
        queueMicrotask(() => session.receive({ type: "room-interaction", id: crypto.randomUUID(),
          requestId: message.requestId, occurredAt: Date.now(), payload: message.payload,
          sender: { peerId: designPeople[3].id, role: "viewer", displayName: senderName.current } }));
        return true;
      }
      return false;
    }, Date.now, REACTION_IDS);
    return session;
  }, [roomId]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    session.authenticated(designPeople[3].id);
    return () => session.disconnected();
  }, [session]);
  return {
    session, state, now: session.now,
    canSend: state.ready && !state.pending && !state.coolingDown,
    send(reaction: ReactionId, targetPeerId?: string) {
      session.send({ kind: "reaction", reaction, ...(targetPeerId ? { targetPeerId } : {}) });
    },
  };
}
export type DesignReactionsModel = ReturnType<typeof useDesignReactions>;

/** The catalogue supplies sample people and a loopback transport, not another couch. */
export function DesignCouch({ people, selfVoice, reactions, voiceEnabled = true }: {
  people: number[]; selfVoice: boolean | PawnVoice; copy: DesignCopy; reactions: DesignReactionsModel; voiceEnabled?: boolean;
}) {
  const name = useContext(DesignNames);
  return <ChannelCouch className="cd-lounge" selfUserId={designPeople[3].id} session={reactions.session}
    people={people.map(index => {
      const person = designPeople[index];
      const voice = index === 3 ? selfVoice : voiceEnabled;
      return { userId: person.id, name: name(index), owner: index === 0,
        voice: typeof voice === "object" ? voice : voice ? { microphone: person.status !== "muted", deafened: person.status === "away" } : undefined };
    })} />;
}
