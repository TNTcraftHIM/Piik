import { afterEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/conversation";
import * as hosting from "../src/client/channel/hosting";
import type { ChannelSnapshot, ConversationReply, SignedConversationPacket } from "../src/client/channel/protocol";
import { readFile } from "node:fs/promises";

afterEach(() => vi.restoreAllMocks());

test("the Browser room host fans out Core-selected records, preserving signed request scope and excluding the requester", async () => {
  const state = { channel: { rooms: [{ id: "room", delivery: { bindingId: "binding", hostSessionId: "host" } }] } } as ChannelSnapshot;
  const sent: SignedConversationPacket[] = [];
  let changed = true;
  let broadcast: ConversationReply["record"] | null = null;
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
    conversation_broadcast: () => JSON.stringify(broadcast),
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
    broadcast = { type: "interaction", id: "event", occurredAt: 1000, senderUserId: "user", reaction: "wave", targetUserId: "friend" };
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
    broadcast = null;
    await receive("set_reaction");
    expect(sent.map(packet => JSON.parse(packet.payload).record.type)).toEqual(["reaction_confirmed"]);
    expect(host.currentReaders).toHaveBeenCalledTimes(1);
    sent.length = 0;
    changed = true;
    broadcast = { type: "message_reactions", snapshot: { messageId: "message", messageSeq: 1, revision: 1, choices: { user: ["heart"] } } };
    await receive("set_reaction");
    const reactions = sent.map(packet => JSON.parse(packet.payload) as ConversationReply);
    expect(reactions.find(reply => reply.recipient === "source")?.record.type).toBe("reaction_confirmed");
    expect(reactions.filter(reply => reply.record.type === "message_reactions").map(reply => reply.recipient).sort()).toEqual(["second", "third"]);
    for (const reply of reactions) expect(reply).toMatchObject({ requestId: "original-id", record: {
      snapshot: { messageId: "message", messageSeq: 1, revision: 1, choices: { user: ["heart"] } },
    } });
  } finally { conversation.close(); }
});

test("signed packets wait for the adjacent participant's selected snapshot without replaying or outliving their binding", async () => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust,
    createSessionSigner: async (seed: Uint8Array) => new rust.SessionSigner(seed),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const [host, sender, relay, binding, domain] = [1, 2, 3, 4, 5].map(value => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`);
  const signer = new rust.SessionSigner(new Uint8Array(32).fill(1));
  let state = {
    channel: { id: domain, name: "Friends", icon: "couch", ownerId: host, historyWindow: 100, rooms: [{
      id: "room", name: "Room", icon: "couch", creatorId: host, access: "public", hidden: false, hasPassword: false,
      voiceBitrate: 64000, relayCapacity: 1, relayOverride: 2, authorized: true, canManage: false, available: true,
      reading: true, participantSessionIds: [host, sender, relay], capabilities: { attachments: true },
      delivery: { hostSessionId: host, bindingId: binding, nextHops: { [host]: sender } },
    }] },
    sessions: [host, sender, relay].map(id => ({ id, userId: id, online: true, signingKey: Array.from(signer.signing_key()) })),
    users: [], files: [], publications: [], voice: [], subscriptions: [], failedSubscriptions: [], iceServers: [],
    pairs: [sender, host].map(peerId => ({ id: peerId, peerId, canReceiveVideoLayers: false, rooms: ["room"], incoming: [], outgoing: [] })),
  } as ChannelSnapshot;
  const sent: SignedConversationPacket[] = [];
  const conversation = new ChannelConversation({ context: () => ({ sessionId: relay, state, connected: true }),
    host: () => undefined, file: vi.fn(), reply: vi.fn(),
    send: async (peer, frame, allowed) => { expect(peer).toBe(host); expect(allowed()).toBe(true); sent.push(JSON.parse(frame).body); },
  });
  const receive = (requestId: string) => conversation.receive(sender, new TextDecoder().decode(rust.encode_control(JSON.stringify({
    kind: "conversation", body: JSON.parse(signer.sign(sender, JSON.stringify({ roomId: "room", bindingId: binding,
      sender, recipient: host, requestId, command: { type: "history", before: null } }))),
  }))));
  const select = (next: string, nextBinding = binding) => {
    state = { ...state, channel: { ...state.channel, rooms: state.channel.rooms.map(room => ({ ...room,
      delivery: { ...room.delivery!, bindingId: nextBinding, nextHops: { [host]: next } },
    })) } };
    conversation.update();
  };
  await conversation.initialize();
  try {
    const first = receive("history"), second = receive("chat");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
    select(host);
    await Promise.all([first, second]);
    expect(sent.map(packet => JSON.parse(packet.payload).requestId)).toEqual(["history", "chat"]);
    expect(sent.every(packet => packet.remainingHops === 19)).toBe(true);
    conversation.update();
    expect(sent).toHaveLength(2);
    select(sender);
    const revoked = receive("revoked");
    const rejected = expect(revoked).rejects.toBe("invalid_conversation_scope");
    await new Promise(resolve => setTimeout(resolve, 0));
    select(host, domain);
    await rejected;
    expect(sent).toHaveLength(2);
  } finally { conversation.close(); signer.free(); }
});
