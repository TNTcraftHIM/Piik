import { afterEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/conversation";
import * as hosting from "../src/client/channel/hosting";
import type { ChannelSnapshot, ConversationReply, SignedConversationPacket } from "../src/client/channel/protocol";

afterEach(() => vi.restoreAllMocks());

test("the Browser room host fans out transient interactions and changed message reactions, keeping readiness and unchanged results source-only", async () => {
  const state = { channel: { rooms: [{ id: "room", delivery: { bindingId: "binding", hostSessionId: "host" } }] } } as ChannelSnapshot;
  const sent: SignedConversationPacket[] = [];
  let changed = true;
  const host = {
    currentReaders: vi.fn(() => ["source", "second", "third"]),
    dispatchPeer: vi.fn(async (packet: SignedConversationPacket) => {
      const { command, ...request } = JSON.parse(packet.payload);
      const record: ConversationReply["record"] = command.type === "set_reaction"
        ? { type: "reaction_confirmed", changed, snapshot: { messageId: "message", messageSeq: 1, revision: 1, choices: { user: ["heart"] } } }
        : command.type === "interaction_ready"
        ? { type: "interaction_ready", serverTime: 1000, reactionIds: ["wave"] }
        : { type: "interaction", id: "event", occurredAt: 1000, senderUserId: "user", reaction: "wave", targetUserId: "friend" };
      return [{ ...request, sender: "host", recipient: "source", record }];
    }),
  } as unknown as hosting.HostedRoom;
  const sign = vi.fn((sender: string, payload: string) => JSON.stringify({ sender, payload, signature: [1], remainingHops: 20 }));
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createSessionSigner: async () => ({ signing_key: () => new Uint8Array(32), sign, free: vi.fn() }),
    route_conversation: (json: string) => {
      const packet = JSON.parse(json), address = JSON.parse(packet.payload);
      return JSON.stringify({ packet, route: { address, nextHop: address.recipient === "host" ? null : address.recipient } });
    },
    encode_control: (json: string) => new TextEncoder().encode(json), decode_control: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const conversation = new ChannelConversation({ context: () => ({ sessionId: "host", state, connected: true }), host: () => host,
    send: async (_peer, frame, allowed) => { expect(allowed()).toBe(true); sent.push(JSON.parse(frame).body); }, file: vi.fn(), reply: vi.fn() });
  await conversation.initialize();
  const receive = async (type: "interaction_ready" | "interaction" | "set_reaction") => conversation.receive("source", JSON.stringify({ kind: "conversation", body: {
    sender: "source", signature: [1], remainingHops: 20, payload: JSON.stringify({
      roomId: "room", bindingId: "binding", sender: "source", recipient: "host", requestId: "original-id", command: { type },
    }),
  } }));
  try {
    await receive("interaction_ready");
    expect(sent.map(packet => JSON.parse(packet.payload).recipient)).toEqual(["source"]);
    expect(host.currentReaders).not.toHaveBeenCalled();
    sent.length = 0;
    await receive("interaction");
    const replies = sent.map(packet => JSON.parse(packet.payload) as ConversationReply);
    expect(replies.map(reply => reply.recipient).sort()).toEqual(["second", "source", "third"]);
    for (const reply of replies) expect(reply).toMatchObject({ requestId: "original-id", sender: "host", record: {
      type: "interaction", id: "event", senderUserId: "user", reaction: "wave", targetUserId: "friend",
    } });
    expect(sent.every(packet => packet.sender === "host")).toBe(true);
    expect(sign).toHaveBeenCalledTimes(4);
    sent.length = 0;
    changed = false;
    await receive("set_reaction");
    expect(sent.map(packet => JSON.parse(packet.payload).record.type)).toEqual(["reaction_confirmed"]);
    expect(host.currentReaders).toHaveBeenCalledTimes(1);
    sent.length = 0;
    changed = true;
    await receive("set_reaction");
    const reactions = sent.map(packet => JSON.parse(packet.payload) as ConversationReply);
    expect(reactions.find(reply => reply.recipient === "source")?.record.type).toBe("reaction_confirmed");
    expect(reactions.filter(reply => reply.record.type === "message_reactions").map(reply => reply.recipient).sort()).toEqual(["second", "third"]);
    for (const reply of reactions) expect(reply).toMatchObject({ requestId: "original-id", record: {
      snapshot: { messageId: "message", messageSeq: 1, revision: 1, choices: { user: ["heart"] } },
    } });
  } finally { conversation.close(); }
});
