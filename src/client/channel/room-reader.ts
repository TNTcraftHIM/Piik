import { memberName } from "./member-name";
import { RoomInteractionSession, type Rejection, type RoomInteraction } from "../lib/room-interactions";
import { MAX_CHAT_CODE_POINTS, type ReactionId } from "../../shared/room-interactions";
import type { ChannelCommand, ChannelMessage, ConversationReply, PublicationReactionSnapshot } from "./protocol";

type InteractionCommand = Extract<ChannelCommand, { type: "interaction_ready" | "react" }>;
type InteractionReply = Extract<ConversationReply["record"], { type: "interaction_ready" | "reaction" | "error" }>;

interface RoomReaderOptions {
  send(command: InteractionCommand, requestId: string): Promise<void>;
  nextReactionNonce(): number;
  interactionChanged(): void;
  feedback(event: RoomInteraction): void;
  userName(userId: string): string | undefined;
  publicationReactions(snapshot: PublicationReactionSnapshot): void;
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
      if (this.admission === admission) this.undelivered(requestId);
    });
    return nonce === undefined ? true : { nonce };
  };

  hasPendingInteraction(requestId: string): boolean {
    return this.admission?.readyRequestId === requestId || this.interactionSession?.getSnapshot().pending?.requestId === requestId;
  }

  receiveInteraction(requestId: string | undefined, record: InteractionReply): boolean {
    const interaction = this.interactionSession;
    if (!interaction) return false;
    switch (record.type) {
      case "interaction_ready": {
        const admission = this.admission;
        if (!requestId || admission?.readyRequestId !== requestId) return true;
        delete admission.readyRequestId;
        interaction.setSupportedReactions(record.reactionIds);
        interaction.receive({ type: "room-interactions-ready", serverTime: record.serverTime });
        for (const snapshot of record.publicationReactions) this.options.publicationReactions(snapshot);
        return true;
      }
      case "reaction": {
        if (record.snapshot?.type === "publication") this.options.publicationReactions(record.snapshot);
        const event = record.event;
        if (!event) {
          if (requestId) interaction.confirm(requestId, record.nonce);
          return true;
        }
        const { senderUserId, target } = event;
        interaction.receive({ type: "room-interaction", id: event.id, requestId, occurredAt: event.occurredAt,
          sender: { peerId: senderUserId, displayName: memberName(senderUserId, this.options.userName(senderUserId)), role: "viewer" },
          payload: { kind: "reaction", reaction: event.reaction as ReactionId,
            ...(target.type === "person" ? { targetPeerId: target.userId } : {}) },
          ...(target.type === "message" ? { contentTarget: { messageSeq: target.messageSeq, messageId: target.messageId } }
            : target.type === "publication" ? { contentTarget: { publicationId: target.publicationId } } : {}) });
        return true;
      }
      case "error":
        if (requestId) this.settle(requestId, record.code === "rate_limited" ? "rate-limited"
          : record.code === "target_unavailable" ? "target-unavailable" : "busy");
        return true;
    }
  }

  /** An undelivered reply leaves the reaction eligible for a retry with its original nonce. */
  undelivered(requestId: string): void {
    this.settle(requestId);
  }

  private settle(requestId: string, rejection?: Rejection): void {
    if (this.admission?.readyRequestId === requestId) this.clearInteraction();
    else if (rejection) this.interactionSession?.receive({ type: "room-interaction-rejected", requestId, reason: rejection });
    else this.interactionSession?.undelivered(requestId);
  }

  receiveLiveMessage(message: ChannelMessage): void {
    const interaction = this.interactionSession;
    if (!interaction) return;
    const displayName = memberName(message.userId, message.archivedAuthorName ?? this.options.userName(message.userId));
    const points = Array.from(message.text.replace(/\s+/gu, " ").normalize("NFC").trim());
    const text = points.length > MAX_CHAT_CODE_POINTS ? `${points.slice(0, MAX_CHAT_CODE_POINTS - 1).join("")}…` : points.join("");
    interaction.receiveConfirmedChat({
      type: "room-interaction", id: message.id, occurredAt: message.time, messageSeq: message.seq,
      sender: { peerId: message.userId, displayName, role: "viewer" }, payload: { kind: "chat", text },
    });
  }

  removeMessages(removed: (seq: number) => boolean): void {
    this.interactionSession?.removeChatMessages(removed);
  }

  disconnect(): void {
    this.admission = undefined;
    this.interactionSession?.disconnected();
  }

  clearInteraction(): void {
    this.admission = undefined;
    const interaction = this.interactionSession;
    if (!interaction) return;
    this.interactionSession = undefined;
    interaction.close();
    this.options.interactionChanged();
  }
}
