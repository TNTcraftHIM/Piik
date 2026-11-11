import { afterEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/conversation";
import * as hosting from "../src/client/channel/hosting";
import type { ChannelSnapshot, ConversationReply, SignedConversationPacket } from "../src/client/channel/protocol";
import { readFile } from "node:fs/promises";

afterEach(() => vi.restoreAllMocks());

test("the Browser room host fans out Core-selected reactions and suppresses an acknowledged nonce retry", async () => {
  const state = { channel: { rooms: [{ id: "room", delivery: { bindingId: "binding", hostSessionId: "host" } }] } } as ChannelSnapshot;
  const sent: SignedConversationPacket[] = [];
  const event = { id: "event", occurredAt: 1000, senderUserId: "user", reaction: "heart", target: { type: "message" as const, messageSeq: 1 } };
  const snapshot = { type: "message" as const, messageId: "message", messageSeq: 1, revision: 1, counts: { heart: 1 } };
  let record: ConversationReply["record"] = { type: "interaction_ready", serverTime: 1000, reactionIds: ["heart"], publicationReactions: [] };
  let broadcast: ConversationReply["record"] | null = null;
  const host = { currentReaders: vi.fn(() => ["source", "second", "third"]),
    dispatchPeer: vi.fn(async (packet: SignedConversationPacket) => {
      const { command: _command, ...request } = JSON.parse(packet.payload);
      return [{ ...request, sender: "host", recipient: "source", record }];
    }),
  } as unknown as hosting.HostedRoom;
  const sign = vi.fn((sender: string, payload: string) => JSON.stringify({ sender, payload, signature: [1] }));
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createSessionSigner: async () => ({ signing_key: () => new Uint8Array(32), sign, free: vi.fn() }),
    verify_conversation: (json: string) => JSON.stringify(JSON.parse(JSON.parse(json).payload)),
    encode_control: (json: string) => new TextEncoder().encode(json), decode_control: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
    conversation_broadcast: () => JSON.stringify(broadcast),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const conversation = new ChannelConversation({ context: () => ({ sessionId: "host", state, connected: true }), host: () => host,
    send: packet => { sent.push(packet); }, file: vi.fn(), reply: vi.fn() });
  await conversation.initialize();
  const receive = async (command: object) => conversation.receive({ sender: "source", signature: [1], payload: JSON.stringify({
    roomId: "room", bindingId: "binding", sender: "source", recipient: "host", requestId: "original-id", command,
  }) });
  try {
    await receive({ type: "interaction_ready" });
    expect(sent.map(packet => JSON.parse(packet.payload).recipient)).toEqual(["source"]);
    expect(host.currentReaders).not.toHaveBeenCalled();
    sent.length = 0;
    record = broadcast = { type: "reaction", nonce: 1, event, snapshot };
    const click = { type: "react", nonce: 1, target: event.target, reaction: "heart" };
    await receive(click);
    const replies = sent.map(packet => JSON.parse(packet.payload) as ConversationReply);
    expect(replies.map(reply => reply.recipient).sort()).toEqual(["second", "source", "third"]);
    for (const reply of replies) expect(reply).toMatchObject({ requestId: "original-id", sender: "host", record });
    expect(sent.every(packet => packet.sender === "host")).toBe(true);
    expect(sign).toHaveBeenCalledTimes(4);
    sent.length = 0;
    // Core owns replay suppression; the carrier forwards only its current reply.
    record = { type: "reaction", nonce: 1, event: null, snapshot: null };
    broadcast = null;
    await receive(click);
    expect(sent.map(packet => JSON.parse(packet.payload).record)).toEqual([record]);
    expect(host.currentReaders).toHaveBeenCalledTimes(1);
  } finally { conversation.close(); }
});

test("signed conversation uses Domain delivery without peers and still fences signatures, recipients and bindings", async () => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust,
    createSessionSigner: async (seed: Uint8Array) => new rust.SessionSigner(seed),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const [host, sender, binding, domain] = [1, 2, 3, 4].map(value => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`);
  let state = { channel: { id: domain, name: "Friends", icon: "couch", ownerId: host, historyWindow: 100,
    rooms: [{
      id: "room", name: "Room", icon: "couch", creatorId: host, access: "public", hidden: false, hasPassword: false,
      voiceBitrate: 64000, relayCapacity: 2, relayOverride: null, authorized: true, canManage: true, available: true,
      reading: true, participantSessionIds: [host, sender], realtimeSessionIds: [], capabilities: { attachments: true },
      delivery: { hostSessionId: host, bindingId: binding, nextHops: {} },
    }] }, sessions: [], users: [], files: [], publications: [], voice: [], subscriptions: [], failedSubscriptions: [], iceServers: [], pairs: [],
  } as ChannelSnapshot;
  const requests: SignedConversationPacket[] = [], replies: SignedConversationPacket[] = [], received = vi.fn();
  const dispatchPeer = vi.fn(async (packet: SignedConversationPacket) => {
    const { command: _command, ...address } = JSON.parse(packet.payload);
    return [{ ...address, sender: host, recipient: sender, record: { type: "history_end", count: 0, hasMore: false, oldestSeq: null, before: null } }];
  });
  const reader = new ChannelConversation({ context: () => ({ sessionId: sender, state, connected: true }),
    host: () => undefined, file: vi.fn(), reply: received, send: packet => { requests.push(packet); } });
  const owner = new ChannelConversation({ context: () => ({ sessionId: host, state, connected: true }),
    host: () => ({ dispatchPeer } as unknown as hosting.HostedRoom), file: vi.fn(), reply: vi.fn(), send: packet => { replies.push(packet); } });
  state.sessions = [{ id: host, userId: host, online: true, signingKey: await owner.initialize() },
    { id: sender, userId: sender, online: true, signingKey: await reader.initialize() }];
  try {
    await reader.send({ type: "history", roomId: "room" }, "request");
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("remainingHops");
    await owner.receive(requests[0]);
    expect(dispatchPeer).toHaveBeenCalledOnce();
    await reader.receive(replies[0]);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room", bindingId: binding, sender: host,
      recipient: sender, requestId: "request", record: { type: "history_end", count: 0, hasMore: false, oldestSeq: null, before: null } }));
    await expect(reader.receive(requests[0])).rejects.toBe("invalid_conversation_scope");
    await expect(owner.receive({ ...requests[0], signature: Array(64).fill(0) })).rejects.toBe("invalid_conversation_signature");
    state = { ...state, channel: { ...state.channel, rooms: state.channel.rooms.map(room => ({ ...room,
      delivery: { ...room.delivery!, bindingId: domain },
    })) } };
    await expect(owner.receive(requests[0])).rejects.toBe("invalid_conversation_scope");
    expect(dispatchPeer).toHaveBeenCalledOnce();
    expect(state.pairs).toEqual([]);
  } finally { owner.close(); reader.close(); }
});
