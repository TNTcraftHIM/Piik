import { loadRoomHosting, type HostedRoom, type SessionSigner } from "./hosting";
import type { ChannelCommand, ChannelSnapshot, ConversationAddress, ConversationReply, SignedConversationPacket } from "./protocol";

type Runtime = Awaited<ReturnType<typeof loadRoomHosting>>;

interface Context { sessionId: string | null; state: ChannelSnapshot | null; connected: boolean }
interface ConversationOptions {
  context(): Context;
  host(roomId: string): HostedRoom | undefined;
  send(peer: string, frame: string, allowed: () => boolean): Promise<void>;
  file(peer: string, control: string): void;
  reply(reply: ConversationReply): void;
}

/** Browser I/O for the shared Rust conversation protocol. Callers own requests. */
export class ChannelConversation {
  private identity: Promise<{ runtime: Runtime; signer: SessionSigner }> | undefined;
  private waiting = new Set<(error?: Error) => void>();
  constructor(private options: ConversationOptions) {}

  update(): void { for (const resume of [...this.waiting]) resume(); }

  private waitForState(deadline: number): Promise<void> {
    if (this.waiting.size >= 128) return Promise.reject(new Error("room_control_busy"));
    return new Promise((resolve, reject) => {
      const resume = (error?: Error) => {
        clearTimeout(timer);
        this.waiting.delete(resume);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => resume(new Error("room_path_unavailable")), Math.max(0, deadline - performance.now()));
      this.waiting.add(resume);
    });
  }

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
    const { runtime, signer } = await this.ready();
    const { state, sessionId, connected } = this.options.context();
    if (!connected || !sessionId) throw new Error("disconnected");
    const delivery = state?.channel.rooms.find(room => room.id === command.roomId)?.delivery;
    if (!delivery) throw new Error("room_host_offline");
    const { roomId, ...body } = command;
    const packet: SignedConversationPacket = JSON.parse(signer.sign(sessionId, JSON.stringify({
      roomId, bindingId: delivery.bindingId, sender: sessionId, recipient: delivery.hostSessionId, requestId, command: body,
    })));
    await this.deliver(packet, runtime);
  }

  async receive(peer: string, frame: string): Promise<void> {
    const { runtime } = await this.ready();
    const control = JSON.parse(runtime.decode_control(new TextEncoder().encode(frame))) as
      { kind: "file"; body: unknown } | { kind: "conversation"; body: SignedConversationPacket };
    if (control.kind === "file") this.options.file(peer, JSON.stringify(control.body));
    else await this.deliver(control.body, runtime, peer);
  }

  private async route(packet: SignedConversationPacket, runtime: Runtime, from?: string) {
    const identity = this.identity;
    const deadline = performance.now() + 5000;
    for (;;) {
      const { state, sessionId, connected } = this.options.context();
      if (!connected || !state || !sessionId) throw new Error("disconnected");
      try {
        const routed = JSON.parse(runtime.route_conversation(JSON.stringify(packet), sessionId, JSON.stringify(state), from)) as {
          packet: SignedConversationPacket; route: { address: ConversationAddress; nextHop: string | null };
        };
        return { routed, state, sessionId };
      } catch (error) {
        if ((error instanceof Error ? error.message : String(error)) !== "room_path_unavailable") throw error;
        if (performance.now() >= deadline) throw error;
        await this.waitForState(deadline);
        if (this.identity !== identity) throw new Error("disconnected");
      }
    }
  }

  private async deliver(packet: SignedConversationPacket, runtime: Runtime, from?: string): Promise<void> {
    const { routed, state, sessionId } = await this.route(packet, runtime, from);
    if (routed.route.nextHop) {
      const peer = routed.route.nextHop;
      const frame = runtime.encode_control(JSON.stringify({ kind: "conversation", body: routed.packet }));
      await this.options.send(peer, new TextDecoder().decode(frame), () => {
        const current = this.options.context();
        if (!current.connected || current.sessionId !== sessionId || !current.state) return false;
        try {
          const route = JSON.parse(runtime.route_conversation(JSON.stringify(packet), sessionId, JSON.stringify(current.state), from));
          return route.route.nextHop === peer;
        } catch { return false; }
      });
      return;
    }
    const address = routed.route.address;
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
      await this.deliver(JSON.parse(signer.sign(sessionId, JSON.stringify(reply))), runtime);
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
    for (const resume of [...this.waiting]) resume(new Error("disconnected"));
    void identity?.then(({ signer }) => signer.free()).catch(() => {});
  }
}
