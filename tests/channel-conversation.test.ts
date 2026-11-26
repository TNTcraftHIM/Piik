import { afterEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/conversation";
import * as hosting from "../src/client/channel/hosting";
import type { HostedRoom, PeerDelivery } from "../prototype/channel-browser/src/hosting-contract";
import type { ChannelSnapshot, ConversationReply, SignedConversationPacket } from "../src/client/channel/protocol";
import { readFile } from "node:fs/promises";

afterEach(() => vi.restoreAllMocks());

function conversationState(host: string, sender: string, binding: string, domain: string): ChannelSnapshot {
  return { channel: { id: domain, name: "Friends", icon: "couch", ownerId: host, roomCreationPolicy: "ordinary", hostingMode: "lightweight", managedRoomIds: [], historyWindow: 100, userCount: 2,
    rooms: [{
      id: "room", name: "Room", icon: "couch", creatorId: host, access: "public", hidden: false, hasPassword: false,
      voiceBitrate: 64000, relayCapacity: 2, relayOverride: null, authorized: true, canManage: true, available: true,
      reading: true, participantSessionIds: [host, sender], lastMessageSeq: 0, fileActivity: [], capabilities: { attachments: true },
      delivery: { hostSessionId: host, bindingId: binding },
    }] }, sessions: [], users: [], files: [], publications: [], voice: [], subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [], iceServers: [], pairs: [],
  };
}

test("the Browser room host fans out Core-selected reactions and suppresses an acknowledged nonce retry", async () => {
  const state = conversationState("host", "source", "binding", "domain");
  const sent: SignedConversationPacket[] = [];
  const event = { id: "event", occurredAt: 1000, senderUserId: "user", reaction: "heart", target: { type: "message" as const, messageSeq: 1, messageId: "message" } };
  const snapshot = { type: "message" as const, messageId: "message", messageSeq: 1, revision: 1, counts: { heart: 1 } };
  let record: ConversationReply["record"] = { type: "interaction_ready", serverTime: 1000, reactionIds: ["heart"], publicationReactions: [] };
  let broadcast: ConversationReply["record"] | null = null;
  const host = { broadcastRecipients: vi.fn(async () => ["second", "third"]),
    dispatchPeer: vi.fn(async (packet: SignedConversationPacket) => {
      const { command: _command, ...request } = JSON.parse(packet.payload);
      const reply = { ...request, sender: "host", recipient: "source", record };
      return { replies: [reply], broadcast: broadcast && { ...reply, record: broadcast } };
    }),
  } as unknown as HostedRoom;
  const sign = vi.fn((sender: string, payload: string) => JSON.stringify({ sender, payload, signature: [1] }));
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createSessionSigner: async () => ({ signing_key: () => new Uint8Array(32), sign, free: vi.fn() }),
    verify_conversation: (json: string) => JSON.stringify(JSON.parse(JSON.parse(json).payload)),
    encode_control: (json: string) => new TextEncoder().encode(json), decode_control: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
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
    expect(host.broadcastRecipients).not.toHaveBeenCalled();
    sent.length = 0;
    record = broadcast = { type: "reaction", nonce: 1, event, snapshot };
    const click = { type: "react", nonce: 1, target: event.target, reaction: "heart" };
    vi.mocked(host.broadcastRecipients).mockImplementationOnce(async () => {
      expect(sent.map(packet => JSON.parse(packet.payload).recipient)).toEqual(["source"]);
      return ["second", "third"];
    });
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
    expect(host.broadcastRecipients).toHaveBeenCalledExactlyOnceWith("source");

    record = broadcast = { type: "reaction", nonce: 2, event, snapshot };
    sent.length = 0;
    vi.mocked(host.broadcastRecipients).mockRejectedValueOnce(new Error("readers unavailable"));
    await expect(receive({ ...click, nonce: 2 })).rejects.toThrow("readers unavailable");
    expect(sent.map(packet => JSON.parse(packet.payload))).toEqual([
      expect.objectContaining({ recipient: "source", requestId: "original-id", record }),
    ]);
  } finally { conversation.close(); }
});

test("signed conversation uses Domain delivery without peers and still fences signatures, recipients and bindings", async () => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust,
    createSessionSigner: async (seed: Uint8Array) => new rust.SessionSigner(seed),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const [host, sender, binding, domain] = [1, 2, 3, 4].map(value => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`);
  let state = conversationState(host, sender, binding, domain);
  const requests: SignedConversationPacket[] = [], replies: SignedConversationPacket[] = [], received = vi.fn();
  const dispatchPeer = vi.fn(async (packet: SignedConversationPacket) => {
    const { command: _command, ...address } = JSON.parse(packet.payload);
    return { replies: [{ ...address, sender: host, recipient: sender, record: { type: "history_page", messages: [], hasMore: false, oldestSeq: null, before: null } }], broadcast: null };
  });
  const roomHost = { dispatchPeer } as unknown as HostedRoom;
  const reader = new ChannelConversation({ context: () => ({ sessionId: sender, state, connected: true }),
    host: () => undefined, file: vi.fn(), reply: received, send: packet => { requests.push(packet); } });
  const owner = new ChannelConversation({ context: () => ({ sessionId: host, state, connected: true }),
    host: () => roomHost, file: vi.fn(), reply: vi.fn(), send: packet => { replies.push(packet); } });
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
      recipient: sender, requestId: "request", record: { type: "history_page", messages: [], hasMore: false, oldestSeq: null, before: null } }));
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

test("signed Web sends distinguish access, reachability and a cancelled reader", async () => {
  const state = conversationState("host", "reader", "binding", "domain");
  const [room] = state.channel.rooms;
  const sign = vi.fn(), send = vi.fn(), pending = vi.fn(() => true);
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createSessionSigner: async () => ({ signing_key: () => new Uint8Array(32), sign, free: vi.fn() }),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const conversation = new ChannelConversation({ context: () => ({ sessionId: "reader", state, connected: true }),
    host: () => undefined, pending, send, file: vi.fn(), reply: vi.fn() });
  const history = { type: "history", roomId: room.id } as const;

  try {
    await conversation.initialize();

    state.channel.rooms = [{ ...room, reading: false }];
    pending.mockReturnValueOnce(false);
    await expect(conversation.send(history, "left-room", room.delivery!.bindingId)).rejects.toMatchObject({ name: "AbortError" });

    state.channel.rooms = [{ ...room, access: "private", authorized: false, delivery: undefined }];
    await expect(conversation.send(history, "revoked")).rejects.toThrow(/^room_access_required$/);

    state.channel.rooms = [{ ...room, available: false }];
    await expect(conversation.send(history, "offline")).rejects.toThrow(/^room_host_offline$/);

    state.channel.rooms = [room];
    await expect(conversation.send(history, "rebound", "previous-binding")).rejects.toThrow(/^room_unavailable$/);

    state.channel.rooms = [{ ...room, delivery: undefined }];
    await expect(conversation.send(history, "no-delivery")).rejects.toThrow(/^room_unavailable$/);

    state.channel.rooms = [];
    await expect(conversation.send(history, "hidden")).rejects.toThrow(/^room_unavailable$/);
    await expect(conversation.send({ ...history, roomId: "unknown" }, "unknown")).rejects.toThrow(/^room_unavailable$/);

    expect(sign).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } finally { conversation.close(); }
});

test("retiring a room during a conversation commit does not read or broadcast from its released host", async () => {
  const state = conversationState("host", "source", "binding", "domain");
  const record: ConversationReply["record"] = { type: "reaction", nonce: 1,
    event: { id: "event", occurredAt: 1000, senderUserId: "user", reaction: "heart", target: { type: "message", messageSeq: 1, messageId: "message" } }, snapshot: null };
  let finish!: (delivery: PeerDelivery) => void;
  const committed = new Promise<PeerDelivery>(resolve => { finish = resolve; });
  let began!: () => void;
  const committing = new Promise<void>(resolve => { began = resolve; });
  const broadcastRecipients = vi.fn(() => { throw new Error("released room"); });
  const host = { dispatchPeer: vi.fn(() => { began(); return committed; }), broadcastRecipients } as unknown as HostedRoom;
  let hosted: HostedRoom | undefined = host;
  const send = vi.fn();
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createSessionSigner: async () => ({ signing_key: () => new Uint8Array(32), sign: vi.fn(), free: vi.fn() }),
    verify_conversation: (json: string) => JSON.stringify(JSON.parse(JSON.parse(json).payload)),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const conversation = new ChannelConversation({ context: () => ({ sessionId: "host", state, connected: true }),
    host: () => hosted, send, file: vi.fn(), reply: vi.fn() });
  const address = { roomId: "room", bindingId: "binding", sender: "source", recipient: "host", requestId: "request" };
  try {
    await conversation.initialize();
    const received = conversation.receive({ sender: "source", signature: [1], payload: JSON.stringify({ ...address,
      command: { type: "react", nonce: 1, target: record.event!.target, reaction: "heart" } }) });
    await committing;
    hosted = undefined;
    const reply = { ...address, sender: "host", recipient: "source", record };
    finish({ replies: [reply], broadcast: reply });
    await expect(received).resolves.toBeUndefined();
    expect(broadcastRecipients).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } finally { conversation.close(); }
});

test('typed room controls dispatch watch ranges independently of attachment controls', async () => {
  vi.spyOn(hosting, 'loadRoomHosting').mockResolvedValue({
    createSessionSigner: async () => ({ signing_key: () => new Uint8Array(32), free: vi.fn() }),
    decode_control: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const file = vi.fn(), watch = vi.fn();
  const conversation = new ChannelConversation({ context: () => ({ sessionId: 'local', state: null, connected: true }),
    host: () => undefined, send: vi.fn(), reply: vi.fn(), file, watch });
  try {
    await conversation.initialize();
    const body = { type: 'pull', requestId: 'request', key: { roomId: 'room', activityId: 'activity', resourceId: 'resource' }, offset: 0, length: 64 };
    await conversation.receiveControl('peer', JSON.stringify({ kind: 'watch', body }));
    expect(watch).toHaveBeenCalledWith('peer', JSON.stringify(body));
    expect(file).not.toHaveBeenCalled();
    await conversation.receiveControl('peer', JSON.stringify({ kind: 'file', body }));
    expect(file).toHaveBeenCalledTimes(1);
  } finally { conversation.close(); }
});
