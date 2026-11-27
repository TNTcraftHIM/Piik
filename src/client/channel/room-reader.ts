import { RoomInteractionSession, type Rejection, type RoomInteraction } from "../lib/room-interactions";
import type { ChannelCommand, ConversationReply } from "./protocol";

type InteractionCommand = Extract<ChannelCommand, { type: "interaction_ready" | "react" }>;
type InteractionReady = Extract<ConversationReply["record"], { type: "interaction_ready" }>;

interface RoomReaderOptions {
  send(command: InteractionCommand, requestId: string): Promise<void>;
  nextReactionNonce(): number;
  interactionChanged(): void;
  feedback(event: RoomInteraction): void;
}

/** One reader per room binding, re-admitted on each connection. */
export class RoomReader {
  private interactionSession?: RoomInteractionSession;
  private admission?: { userId: string; readyRequestId?: string };

  constructor(readonly roomId: string, readonly bindingId: string, private readonly options: RoomReaderOptions) {}

  get interaction(): RoomInteractionSession | undefined { return this.interactionSession; }

  admit(userId: string): void {
    if (this.admission) return;
    this.admission = { userId };
    if (!this.interactionSession) {
      this.interactionSession = new RoomInteractionSession(this.send, Date.now, undefined, this.options.feedback);
      this.options.interactionChanged();
    }
    this.interactionSession?.authenticated(userId);
  }

  private send: ConstructorParameters<typeof RoomInteractionSession>[0] = message => {
    const admission = this.admission;
    if (!admission) return false;
    const roomId = this.roomId;
    let command: InteractionCommand, requestId: string;
    let nonce: number | undefined;
    if (message.type === "subscribe-room-interactions") {
      requestId = crypto.randomUUID();
      admission.readyRequestId = requestId;
      command = { type: "interaction_ready", roomId };
    } else {
      const { payload, contentTarget: target } = message;
      if (payload.kind !== "reaction") return false;
      requestId = message.requestId;
      nonce = message.nonce ?? this.options.nextReactionNonce();
      command = { type: "react", roomId, reaction: payload.reaction, nonce,
        target: target ? "messageSeq" in target
          ? { type: "message", messageSeq: target.messageSeq, messageId: target.messageId }
          : { type: "publication", publicationId: target.publicationId }
          : { type: "person", userId: payload.targetPeerId ?? admission.userId },
      };
    }
    void this.options.send(command, requestId).catch(() => {
      if (this.admission === admission) this.settle(requestId);
    });
    return nonce === undefined ? true : { nonce };
  };

  hasPendingInteraction(requestId: string): boolean {
    return this.admission?.readyRequestId === requestId || this.interactionSession?.getSnapshot().pending?.requestId === requestId;
  }

  subscribed(requestId: string, record: InteractionReady): boolean {
    const admission = this.admission, interaction = this.interactionSession;
    if (admission?.readyRequestId !== requestId || !interaction) return false;
    delete admission.readyRequestId;
    interaction.setSupportedReactions(record.reactionIds);
    interaction.receive({ type: "room-interactions-ready", serverTime: record.serverTime });
    return true;
  }

  /** An undelivered reply leaves the reaction eligible for a retry with its original nonce. */
  settle(requestId: string, rejection?: Rejection): void {
    if (this.admission?.readyRequestId === requestId) this.close();
    else if (rejection) this.interactionSession?.receive({ type: "room-interaction-rejected", requestId, reason: rejection });
    else this.interactionSession?.undelivered(requestId);
  }

  disconnect(): void {
    this.admission = undefined;
    this.interactionSession?.disconnected();
  }

  close(): void {
    this.admission = undefined;
    const interaction = this.interactionSession;
    if (!interaction) return;
    this.interactionSession = undefined;
    interaction.close();
    this.options.interactionChanged();
  }
}
