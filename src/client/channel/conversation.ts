import { loadRoomHosting, type HostedRoom, type SessionSigner } from "./hosting";
import type { ChannelCommand, ChannelSnapshot, ConversationAddress, ConversationReply, SignedConversationPacket } from "./protocol";

type Runtime = Awaited<ReturnType<typeof loadRoomHosting>>;

interface Context { sessionId: string | null; state: ChannelSnapshot | null; connected: boolean }
interface ConversationOptions {
  context(): Context;
  host(roomId: string): HostedRoom | undefined;
  send(packet: SignedConversationPacket, requestId: string): void;
  file(peer: string, control: string): void;
  reply(reply: ConversationReply): void;
}

/** Browser I/O for the shared Rust conversation protocol. Callers own requests. */
export class ChannelConversation {
  private identity: Promise<{ runtime: Runtime; signer: SessionSigner }> | undefined;
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
    return Array.from((await this.ready()).signer.signing_key());
  }

  async fileFrame(control: string): Promise<string> {
    const { runtime } = await this.ready();
    return new TextDecoder().decode(runtime.encode_control(JSON.stringify({ kind: "file", body: JSON.parse(control) })));
  }

  async send(command: Extract<ChannelCommand, { type: "chat" | "history" | "set_reaction" | "interaction_ready" | "interaction" }>, requestId: string): Promise<void> {
    const { signer } = await this.ready();
    const { state, sessionId, connected } = this.options.context();
    if (!connected || !sessionId) throw new Error("disconnected");
    const delivery = state?.channel.rooms.find(room => room.id === command.roomId)?.delivery;
    if (!delivery) throw new Error("room_host_offline");
    const { roomId, ...body } = command;
    const packet: SignedConversationPacket = JSON.parse(signer.sign(sessionId, JSON.stringify({
      roomId, bindingId: delivery.bindingId, sender: sessionId, recipient: delivery.hostSessionId, requestId, command: body,
    })));
    this.options.send(packet, requestId);
  }

  async receiveFile(peer: string, frame: string): Promise<void> {
    const { runtime } = await this.ready();
    const control = JSON.parse(runtime.decode_control(new TextEncoder().encode(frame))) as { kind: "file"; body: unknown };
    if (control.kind === "file") this.options.file(peer, JSON.stringify(control.body));
  }

  async receive(packet: SignedConversationPacket): Promise<void> {
    const { runtime } = await this.ready();
    const { state, sessionId, connected } = this.options.context();
    if (!connected || !state || !sessionId) throw new Error("disconnected");
    const address = JSON.parse(runtime.verify_conversation(JSON.stringify(packet), sessionId, JSON.stringify(state))) as ConversationAddress;
    if ("record" in JSON.parse(packet.payload)) {
      const hostSessionId = state.channel.rooms.find(room => room.id === address.roomId)?.delivery?.hostSessionId;
      if (address.sender !== hostSessionId) throw new Error("invalid_conversation_sender");
      const key = state.sessions.find(session => session.id === packet.sender)!.signingKey;
      this.options.reply(JSON.parse(runtime.verify_reply(JSON.stringify(packet), Uint8Array.from(key))));
      return;
    }
    const host = this.options.host(address.roomId);
    if (!host) throw new Error("room_host_offline");
    const replies = await host.dispatchPeer(packet, Date.now());
    const { signer } = await this.ready();
    const send = async (reply: ConversationReply) => {
      const current = this.options.context();
      if (!current.connected || current.sessionId !== sessionId
        || current.state?.channel.rooms.find(room => room.id === reply.roomId)?.delivery?.bindingId !== reply.bindingId) return;
      this.options.send(JSON.parse(signer.sign(sessionId, JSON.stringify(reply))), reply.requestId);
    };
    const broadcasts: ConversationReply[] = [];
    for (const reply of replies) {
      const record = JSON.parse(runtime.conversation_broadcast(JSON.stringify(reply.record))) as ConversationReply["record"] | null;
      if (record) for (const recipient of await host.currentReaders()) if (recipient !== reply.recipient) {
        broadcasts.push({ ...reply, recipient, record });
      }
    }
    await Promise.allSettled([
      (async () => { for (const reply of replies) await send(reply); })(),
      ...broadcasts.map(send),
    ]);
  }

  close(): void {
    const identity = this.identity;
    this.identity = undefined;
    void identity?.then(({ signer }) => signer.free()).catch(() => {});
  }
}
