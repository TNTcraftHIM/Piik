import { loadRoomHosting } from "./hosting";
import type { HostedRoom } from "../../../prototype/channel-browser/src/hosting-contract";
import type { SessionSigner } from "../../../prototype/channel-browser/pkg/piik_channel_browser";
import { requireConversationDelivery, type ChannelCommand, type ChannelSnapshot, type ConversationAddress, type ConversationReply, type SignedConversationPacket } from "./protocol";

type Runtime = Awaited<ReturnType<typeof loadRoomHosting>>;

interface Context { sessionId: string | null; state: ChannelSnapshot | null; connected: boolean }
interface ConversationOptions {
  context(): Context;
  host(roomId: string): HostedRoom | undefined;
  pending?(requestId: string, bindingId: string): boolean;
  send(packet: SignedConversationPacket, requestId: string): void;
  file(peer: string, control: string): void;
  watch?(peer: string, control: string): void;
  reply(reply: ConversationReply): void;
  projection?(roomId: string, output: unknown): void;
}

/** Browser I/O for the shared Rust conversation protocol. Callers own requests. */
export class ChannelConversation {
  private identity: Promise<{ runtime: Runtime; signer: SessionSigner }> | undefined;
  private runtime: Runtime | undefined;
  constructor(private options: ConversationOptions) {}

  private async ready() {
    const identity = this.identity;
    if (!identity) throw new Error("disconnected");
    const value = await identity;
    if (this.identity !== identity) throw new Error("disconnected");
    return value;
  }

  async initialize(): Promise<number[]> {
    this.identity ??= (async () => {
      const runtime = await loadRoomHosting();
      const signer = await runtime.createSessionSigner(crypto.getRandomValues(new Uint8Array(32)));
      return { runtime, signer };
    })();
    const { runtime, signer } = await this.ready();
    this.runtime = runtime;
    return Array.from(signer.signing_key());
  }

  fileAvailabilityLimit() { return this.runtime?.file_availability_limit() ?? 0; }

  forwardingBudget() { return this.runtime && new this.runtime.ForwardingBudget(); }

  async fileFrame(control: string): Promise<string> {
    const { runtime } = await this.ready();
    return new TextDecoder().decode(runtime.encode_control(JSON.stringify({ kind: "file", body: JSON.parse(control) })));
  }

  async send(command: Extract<ChannelCommand, { type: "chat" | "history" | "history_seek" | "delete_message" | "clear_history" | "react" | "interaction_ready" }>, requestId: string, bindingId?: string): Promise<void> {
    const { signer } = await this.ready();
    if (bindingId && !this.options.pending?.(requestId, bindingId)) throw new DOMException("Request cancelled", "AbortError");
    const { state, sessionId, connected } = this.options.context();
    if (!connected || !sessionId) throw new Error("disconnected");
    const delivery = requireConversationDelivery(state?.channel.rooms.find(room => room.id === command.roomId));
    if (bindingId && delivery.bindingId !== bindingId) throw new Error("room_unavailable");
    const { roomId, ...body } = command;
    const packet: SignedConversationPacket = JSON.parse(signer.sign(sessionId, JSON.stringify({
      roomId, bindingId: delivery.bindingId, sender: sessionId, recipient: delivery.hostSessionId, requestId, command: body,
    })));
    this.options.send(packet, requestId);
  }

  async receiveControl(peer: string, frame: string): Promise<void> {
    const { runtime } = await this.ready();
    const control = JSON.parse(runtime.decode_control(new TextEncoder().encode(frame))) as { kind: "file" | "watch"; body: unknown };
    if (control.kind === "file") this.options.file(peer, JSON.stringify(control.body));
    else if (control.kind === "watch") this.options.watch?.(peer, JSON.stringify(control.body));
  }

  async receive(packet: SignedConversationPacket): Promise<void> {
    const { runtime } = await this.ready();
    const { state, sessionId, connected } = this.options.context();
    if (!connected || !state || !sessionId) throw new Error("disconnected");
    const rooms = state.channel.rooms.map(({ id, authorized, available, delivery }) => ({ id, authorized, available, delivery }));
    const sessions = state.sessions.map(({ id, signingKey }) => ({ id, signingKey }));
    const view = { channel: { rooms }, sessions };
    const address = JSON.parse(runtime.verify_conversation(JSON.stringify(packet), sessionId, JSON.stringify(view))) as ConversationAddress | ConversationReply;
    if ("record" in address) {
      this.options.reply(address);
      return;
    }
    const host = this.options.host(address.roomId);
    if (!host) throw new Error("room_host_offline");
    const replies = await host.dispatchPeer(packet, Date.now(), undefined, output => {
      const current = this.options.context();
      if (current.connected && current.sessionId === sessionId && this.options.host(address.roomId) === host
        && current.state?.channel.rooms.find(room => room.id === address.roomId)?.delivery?.bindingId === address.bindingId) {
        this.options.projection?.(address.roomId, output);
      }
    });
    const { signer } = await this.ready();
    const isCurrent = (reply: ConversationReply) => {
      const current = this.options.context();
      return this.options.host(reply.roomId) === host && current.connected && current.sessionId === sessionId
        && current.state?.channel.rooms.find(room => room.id === reply.roomId)?.delivery?.bindingId === reply.bindingId;
    };
    const send = async (reply: ConversationReply) => {
      if (!isCurrent(reply)) return;
      this.options.send(JSON.parse(signer.sign(sessionId, JSON.stringify(reply))), reply.requestId);
    };
    await Promise.allSettled(replies.map(send));
    const broadcasts: ConversationReply[] = [];
    for (const reply of replies) {
      const record = JSON.parse(runtime.conversation_broadcast(JSON.stringify(reply.record))) as ConversationReply["record"] | null;
      if (record && isCurrent(reply)) for (const recipient of await host.currentReaders()) if (recipient !== reply.recipient) {
        broadcasts.push({ ...reply, recipient, record });
      }
    }
    await Promise.allSettled(broadcasts.map(send));
  }

  close(): void {
    const identity = this.identity;
    this.identity = undefined;
    this.runtime = undefined;
    void identity?.then(({ signer }) => signer.free()).catch(() => {});
  }
}
