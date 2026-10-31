import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/conversation";
import { ChannelSession } from "../src/client/channel/session";
import * as hosting from "../src/client/channel/hosting";
import * as appLink from "../src/client/channel/app-link";
import * as nativeActivation from "../src/client/native/activation";
import * as launchSession from "../src/client/lib/session";
import * as cameraPreviews from "../src/client/media/camera-previews";
import { ChannelMedia } from "../src/client/channel/media";
import { ChannelTransport } from "../src/client/channel/transport";
import { ChannelAttachments } from "../src/client/channel/attachments";
import { identityIconSchema, messageSchema, snapshotSchema, signalSchema, type ChannelCommand, type ChannelMessage, type ChannelSignal, type ConversationReply } from "../src/client/channel/protocol";
import type { ChannelScreenInput } from "../src/client/channel/types";
import { ChannelInput } from "../src/client/channel/input";
import { RemoteInputSession } from "../src/client/remote-control/input-session";
import type { InputTransport } from "../src/client/remote-control/input-route";

class ChannelSocket {
  static OPEN = 1;
  static current: ChannelSocket;
  readyState = ChannelSocket.OPEN;
  onopen: (() => void | Promise<void>) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  constructor(_url: URL) { ChannelSocket.current = this; }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  receive(event: object): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const testSigningKey = Array.from(Buffer.from("8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c", "hex"));
beforeEach(() => {
  vi.spyOn(launchSession, "isClientActivated").mockReturnValue(false);
  vi.spyOn(ChannelConversation.prototype, "initialize").mockResolvedValue(testSigningKey);
  vi.stubGlobal("MediaStream", RoomMediaStream);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(window = 1000, read = true, hash = "", readyInteractions = true) {
  vi.stubGlobal("location", new URL(`https://channel.test/__channel-preview${hash ? `#${hash}` : ""}`));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("WebSocket", ChannelSocket);
  const session = new ChannelSession();
  type PeerRequest = Extract<ChannelCommand, { type: "chat" | "history" | "set_reaction" }> & { requestId: string };
  type InteractionRequest = Extract<ChannelCommand, { type: "interaction_ready" | "interaction" }> & { requestId: string };
  const sent: PeerRequest[] = [], pending: PeerRequest[] = [];
  const interactions: InteractionRequest[] = [];
  vi.spyOn(ChannelConversation.prototype, "send").mockImplementation(async (command, requestId) => {
    if (command.type === "interaction_ready" || command.type === "interaction") {
      const request = { ...command, requestId };
      interactions.push(request);
      if (readyInteractions && command.type === "interaction_ready") queueMicrotask(() => peer.reply(request,
        { type: "interaction_ready", serverTime: Date.now(), reactionIds: ["wave", "heart", "future-decoration"] }));
      return;
    }
    const request = { ...command, requestId };
    sent.push(request); pending.push(request);
  });
  const deliver = (reply: ConversationReply) => (session as unknown as { receiveConversation(value: ConversationReply): void }).receiveConversation(reply);
  const peer = {
    sent, interactions,
    async next() { await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0)); return pending.shift()!; },
    reply(request: PeerRequest | InteractionRequest, record: ConversationReply["record"]) {
      const reply = { roomId: request.roomId, bindingId: "binding", sender: "host", recipient: "endpoint", requestId: request.requestId };
      deliver({ ...reply, record: "message" in record ? { ...record, message: messageSchema.parse(record.message) } : record });
      if (record.type === "confirmed") deliver({ ...reply, record: { type: "message_reactions", snapshot: {
        messageId: record.message.id, messageSeq: record.message.seq, ...(record.message.reactions ?? { revision: 0, choices: {} }),
      } } });
    },
    page(request: PeerRequest, messages: ChannelMessage[], hasMore = false, oldestSeq: number | null = 1) {
      for (const message of messages) {
        peer.reply(request, { type: "history_message", message });
        peer.reply(request, { type: "message_reactions", snapshot: {
          messageId: message.id, messageSeq: message.seq, ...(message.reactions ?? { revision: 0, choices: {} }),
        } });
      }
      peer.reply(request, { type: "history_end", count: messages.length, hasMore, oldestSeq, before: "before" in request ? request.before ?? null : null });
    },
    live(message: ChannelMessage, roomId = "first") {
      deliver({ roomId, bindingId: "binding", sender: "host", recipient: "endpoint", requestId: "live", record: { type: "live_message", message: messageSchema.parse(message) } });
    },
    async history(messages: ChannelMessage[], hasMore = false, older = false) {
      const loading = older ? session.loadHistory("first") : session.loadLatestHistory("first");
      peer.page(await peer.next(), messages, hasMore);
      await loading;
    },
  };
  session.start();
  const socket = ChannelSocket.current;
  await socket.onopen?.();
  socket.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state: {
    channel: { id: "domain", name: "Friends", icon: "future-domain_7", ownerId: "self", historyWindow: window,
      rooms: ["first", "second"].map(id => ({ id, name: id, icon: "couch", creatorId: "self", access: "public",
        hidden: false, hasPassword: false, authorized: true, canManage: true,
        participantSessionIds: id === "first" ? ["endpoint"] : [],
        available: true, reading: id === "first", capabilities: { attachments: true },
        delivery: { hostSessionId: "host", bindingId: "binding", nextHops: { host: "host" } } })), roles: [] },
    users: [{ id: "self", name: "Me", roles: [] }], sessions: [{ id: "endpoint", userId: "self", online: true, signingKey: testSigningKey }],
    publications: [], voice: [], subscriptions: [], files: [], pairs: [], iceServers: [],
  } });
  if (read) {
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    peer.page(await peer.next(), [], false, null);
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:first")).toBe(false));
    peer.sent.length = 0;
  }
  return { session, socket, peer };
}

const message = (seq: number) => ({ id: `message-${seq}`, seq, userId: "self", text: `Hello ${seq}`, time: seq, attachments: [],
  reactions: { revision: 0, choices: {} } });
const reactionSnapshot = (seq: number, revision: number, choices: Record<string, string[]> = {}) =>
  ({ messageId: `message-${seq}`, messageSeq: seq, revision, choices });

test("message reaction confirmation applies canonical snapshots and survives later body confirmation", async () => {
  const { session, peer } = await setup();
  try {
    await peer.history([message(1)]);
    const setting = session.setMessageReaction("first", 1, "heart", true), request = await peer.next();
    expect(request).toMatchObject({ type: "set_reaction", roomId: "first", messageSeq: 1, reaction: "heart", active: true });
    expect(request).not.toHaveProperty("userId");
    expect(session.getSnapshot().pending.has("reaction:first:1")).toBe(true);
    expect(session.getSnapshot().messagesByRoom.first[0].reactions).toEqual({ revision: 0, choices: {} });
    const snapshot = reactionSnapshot(1, 2, { self: ["heart"], friend: ["clap"] });
    peer.reply(request, { type: "reaction_confirmed", changed: false, snapshot });
    await setting;
    expect(session.getSnapshot().messagesByRoom.first[0].reactions).toEqual({ revision: 2, choices: snapshot.choices });
    expect(session.getSnapshot().pending.has("reaction:first:1")).toBe(false);
    const sending = session.sendMessage("first", message(1).text), chat = await peer.next();
    peer.reply(chat, { type: "confirmed", message: message(1), inserted: false });
    await sending;
    expect(session.getSnapshot().messagesByRoom.first[0].reactions?.revision).toBe(2);
    // The chat request is settled before its separately carried snapshot arrives.
    peer.reply(chat, { type: "message_reactions", snapshot: reactionSnapshot(1, 3, { friend: ["clap"] }) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([{ ...message(1), reactions: { revision: 3, choices: { friend: ["clap"] } } }]);
    const removing = session.setMessageReaction("first", 1, "heart", false), removal = await peer.next();
    peer.reply(removal, { type: "reaction_confirmed", changed: false, snapshot: reactionSnapshot(1, 3, { friend: ["clap"] }) });
    await removing;
    expect(session.getSnapshot().messagesByRoom.first[0].reactions?.revision).toBe(3);
  } finally { session.close(); }
});

test("history assembles early live reaction snapshots and preserves the newer projection in a historical window", async () => {
  const { session, peer } = await setup(2);
  try {
    await peer.history([message(3), message(4)], true);
    const older = session.loadHistory("first"), request = await peer.next();
    peer.reply({ ...request, requestId: "live-reaction" }, { type: "message_reactions", snapshot: reactionSnapshot(1, 3, { self: ["heart"] }) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(3), message(4)]);
    peer.reply(request, { type: "history_message", message: message(1) });
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(1, 1, { self: ["wave"] }) });
    peer.reply(request, { type: "history_message", message: message(2) });
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(2, 0) });
    peer.reply(request, { type: "history_end", count: 2, hasMore: false, oldestSeq: 1, before: 3 });
    await older;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([{ ...message(1), reactions: { revision: 3, choices: { self: ["heart"] } } }, message(2)]);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(false);
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(2, 4, { friend: ["clap"] }) });
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(5, 2, { self: ["wave"] }) });
    peer.live(message(5));
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.seq)).toEqual([1, 2]);
    expect(session.getSnapshot().messagesByRoom.first[1].reactions).toEqual({ revision: 4, choices: { friend: ["clap"] } });
    const latest = session.loadLatestHistory("first");
    peer.page(await peer.next(), [message(1), message(2)], false, 1);
    await latest;
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.reactions?.revision)).toEqual([3, 4]);
    const refreshing = session.loadLatestHistory("first"), refresh = await peer.next();
    peer.reply({ ...refresh, requestId: "new-live-reaction" }, { type: "message_reactions", snapshot: reactionSnapshot(3, 5, { self: ["wave"] }) });
    peer.live(message(3));
    peer.page(refresh, [message(1), message(2)], false, 1);
    await refreshing;
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.seq)).toEqual([2, 3]);
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.reactions?.revision)).toEqual([4, 5]);
  } finally { session.close(); }
});

test("room interactions reuse their original acknowledgement and user identity without chat or media permission", async () => {
  vi.useFakeTimers();
  const { session, socket, peer } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.ownerId = "friend-user-1234";
    state.users.push({ id: "friend-user-1234", name: "Friend", roles: [] });
    socket.receive({ type: "state", state });
    await vi.waitFor(() => expect(session.getSnapshot().interactionsByRoom.get("first")?.getSnapshot().ready).toBe(true));
    const interaction = session.getSnapshot().interactionsByRoom.get("first")!;
    expect(interaction.getSnapshot()).toMatchObject({ peerId: "self", reactionIds: ["wave", "heart"] });
    expect(interaction.send({ kind: "reaction", reaction: "heart", targetPeerId: "friend-user-1234" })).toBe(true);
    const request = peer.interactions.at(-1)!;
    expect(request).toEqual({ type: "interaction", roomId: "first", reaction: "heart", targetUserId: "friend-user-1234", requestId: interaction.getSnapshot().pending!.requestId });
    expect(session.getSnapshot().pending.size).toBe(0);
    expect(socket.sent.some(command => command.type === "interaction")).toBe(false);
    peer.reply(request, { type: "interaction", id: "future", occurredAt: Date.now(), senderUserId: "self", reaction: "future-decoration" });
    expect(interaction.getSnapshot().pending?.requestId).toBe(request.requestId);
    expect(interaction.getSnapshot().reactions).toEqual([]);
    peer.reply(request, { type: "interaction", id: "confirmed", occurredAt: Date.now(), senderUserId: "self", reaction: "heart", targetUserId: "friend-user-1234" });
    expect(interaction.getSnapshot()).toMatchObject({ pending: null, confirmed: {
      sender: { peerId: "self", displayName: "Me" }, payload: { kind: "reaction", reaction: "heart", targetPeerId: "friend-user-1234" },
    } });
    expect(interaction.send({ kind: "reaction", reaction: "wave" })).toBe(false);
    vi.advanceTimersByTime(800);
    expect(interaction.send({ kind: "reaction", reaction: "wave" })).toBe(true);
    peer.reply(peer.interactions.at(-1)!, { type: "error", code: "rate_limited" });
    expect(interaction.getSnapshot()).toMatchObject({ pending: null, error: "rate-limited" });
    expect(session.getSnapshot().error).toBeNull();
    vi.advanceTimersByTime(2400);
    expect(interaction.getSnapshot().reactions).toEqual([]);
    expect(session.getSnapshot().messagesByRoom.first).toEqual([]);
    expect(interaction.send({ kind: "reaction", reaction: "wave" })).toBe(true);
    socket.close();
    expect(session.getSnapshot().interactionsByRoom.get("first")).toBe(interaction);
    expect(interaction.getSnapshot()).toMatchObject({ ready: false, pending: null, error: "unconfirmed", reactions: [] });
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state });
    const browse = resumed.sent.findLast(command => command.type === "browse" && command.active)!;
    resumed.receive({ type: "ack", requestId: browse.requestId });
    peer.page(await peer.next(), [], false, null);
    await vi.waitFor(() => expect(interaction.getSnapshot().ready).toBe(true));
    expect(session.getSnapshot().interactionsByRoom.get("first")).toBe(interaction);
    expect(interaction.send({ kind: "reaction", reaction: "wave" })).toBe(true);
    expect(peer.interactions.at(-1)?.requestId).toBe(interaction.getSnapshot().pending?.requestId);
    session.browse("second");
    expect(session.getSnapshot().interactionsByRoom.size).toBe(0);
    expect(interaction.getSnapshot()).toMatchObject({ ready: false, pending: null, peerId: null });
  } finally { session.close(); }
});

test("interaction readiness follows read admission and existing peer readiness, then clears with room availability", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const { session, socket, peer } = await setup(1000, false, "", false);
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].delivery!.nextHops = {};
    socket.receive({ type: "state", state });
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    await Promise.resolve(); await Promise.resolve();
    expect(peer.interactions).toEqual([]);
    expect(session.getSnapshot().interactionsByRoom.size).toBe(0);
    const send = vi.mocked(ChannelConversation.prototype.send), original = send.getMockImplementation()!;
    let attempts = 0;
    send.mockImplementation(async (command, requestId) => {
      if (command.type === "interaction_ready") attempts++;
      return original(command, requestId);
    });
    state.channel.rooms[0].delivery!.nextHops = { host: "host" };
    state.pairs = [{ id: "room-base", peerId: "host", rooms: ["first"], outgoing: [], incoming: [] }];
    socket.receive({ type: "state", state });
    await vi.waitFor(() => expect(attempts).toBe(1));
    const pending = session.getSnapshot().interactionsByRoom.get("first")!;
    expect(pending.getSnapshot().ready).toBe(false);
    RoomPeerConnection.instances[0].connected();
    await vi.waitFor(() => expect(attempts).toBe(2));
    const request = peer.interactions.at(-1)!;
    expect(request.type).toBe("interaction_ready");
    peer.reply(request, { type: "interaction_ready", serverTime: Date.now(), reactionIds: ["wave", "future-decoration"] });
    const interaction = session.getSnapshot().interactionsByRoom.get("first")!;
    expect(interaction).toBe(pending);
    expect(interaction.getSnapshot()).toMatchObject({ ready: true, reactionIds: ["wave"] });
    state.channel.rooms[0].available = false;
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().interactionsByRoom.size).toBe(0);
    peer.reply(request, { type: "interaction", id: "late", occurredAt: Date.now(), senderUserId: "self", reaction: "wave" });
    expect(interaction.getSnapshot().reactions).toEqual([]);
    expect(interaction.getSnapshot().ready).toBe(false);
  } finally { session.close(); }
});

test("domain and room invitations use the current Welcome origin without local bootstrap data", async () => {
  const { session, peer } = await setup();
  const state = session.getSnapshot().state!;
  vi.stubGlobal("location", new URL("https://channel.test/__channel-preview?piik-client-port=39721#owner=local-owner&piik-client=1&piik-client-port=39721"));
  try {
    for (const invitationOrigin of ["https://friends.example", undefined]) {
      session.reconnect();
      const socket = ChannelSocket.current;
      await socket.onopen?.();
      socket.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state,
        inviteKey: "domain-invite", ...(invitationOrigin ? { invitationOrigin } : {}) });
      const origin = invitationOrigin ?? "https://channel.test";
      expect(session.getSnapshot().inviteURL).toBe(`${origin}/__channel-preview#invite=domain-invite`);
      const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
      socket.receive({ type: "ack", requestId: browse.requestId });
      peer.page(await peer.next(), [], false, null);
      const creating = session.createRoomInvite("first");
      const request = socket.sent.findLast(command => command.type === "room_invite")!;
      socket.receive({ type: "room_invite", roomId: "first", key: "room-invite", requestId: request.requestId });
      socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId, result: { type: "done" } });
      await expect(creating).resolves.toBe(`${origin}/__channel-preview#room=first&invite=room-invite`);
    }
  } finally { session.close(); }
});

test("App hosting uses its own participant while Browser rooms retain their page lifetime", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: 1, port: 8793, token: "approved" });
  const localRoom = { id: "saved-browser-room", name: "Browser room", icon: "couch", creatorId: "self", access: "public" as const, hidden: false, hasPassword: false };
  const host = {
    roomId: localRoom.id, summary: () => localRoom,
    bind: vi.fn(async (_binding: string) => {}),
    dispatch: vi.fn(async (_input: unknown) => ({})),
    close: vi.fn(async () => {}),
  };
  vi.stubGlobal("indexedDB", {});
  const storedPolicies = vi.fn(async () => [JSON.stringify(localRoom)]);
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createRoomPolicy: async (input: unknown) => JSON.stringify(input),
    BrowserRoomHost: { open: async () => host, storedPolicies },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    expect(app).not.toBe(socket);
    await app.onopen?.();
    const hello = app.sent.at(-1)!;
    expect(hello).toMatchObject({ type: "hello", channelId: "domain", userId: "self", credential: "credential", name: "Me" });
    app.receive({ id: hello.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "host_register" && (command.room as { id: string }).id === localRoom.id)).toBe(true));
    const register = socket.sent.find(command => command.type === "host_register")!;
    socket.receive({ type: "host_bound", roomId: localRoom.id, bindingId: "browser-binding" });
    socket.receive({ type: "ack", requestId: register.requestId });
    expect(storedPolicies).toHaveBeenCalledOnce();

    const creating = session.createRoom({ name: "App room", icon: "couch", access: "private", hidden: true, password: "private-room" });
    await vi.waitFor(() => expect(app.sent.some(command => command.type === "open")).toBe(true));
    const opening = app.sent.find(command => command.type === "open")!;
    const policy = JSON.parse(opening.policy as string) as { id: string; name: string; icon: string; creatorId: string; access: string; hidden: boolean; password: string };
    expect(policy).toMatchObject({ name: "App room", icon: "couch", creatorId: "self", access: "private", hidden: true, password: "private-room" });
    app.receive({ id: opening.id, result: { id: policy.id, name: policy.name, icon: policy.icon, creatorId: "self", access: "private", hidden: true, hasPassword: true } });
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "browse" && command.roomId === policy.id)).toBe(true));
    const browse = socket.sent.findLast(command => command.type === "browse" && command.roomId === policy.id)!;
    socket.receive({ type: "room_reply", roomId: policy.id, requestId: browse.requestId, result: { type: "done" } });
    await expect(creating).resolves.toBe(policy.id);
    expect(socket.sent.filter(command => command.type === "host_register")).toEqual([register]);
    socket.receive({ type: "host_bound", roomId: policy.id, bindingId: "native-binding" });
    socket.receive({ type: "host_input", roomId: policy.id, input: { bindingId: "native-binding", revision: 1, endpoints: {}, action: { type: "sync" } } });
    expect(host.dispatch).not.toHaveBeenCalled();

    app.close();
    expect(session.getSnapshot()).toMatchObject({ appConnected: false, error: null });
    expect(host.close).not.toHaveBeenCalled();
    expect(socket.sent.some(command => command.type === "host_stop")).toBe(false);
    session.close();
    await vi.waitFor(() => expect(host.close).toHaveBeenCalledOnce());
    expect(socket.sent.filter(command => command.type === "host_stop")).toEqual([
      { type: "host_stop", roomId: localRoom.id, bindingId: "browser-binding" },
    ]);
    expect(app.sent.map(command => command.type)).toEqual(["hello", "open"]);
  } finally { session.close(); }
});

test("personal voice playback follows user identity without sending room commands", async () => {
  const { session, socket } = await setup();
  try {
    const initial = session.getSnapshot().state!;
    const friend = { id: "friend", name: "Friend", roles: [] };
    const state = { ...initial, users: [...initial.users, friend],
      sessions: [...initial.sessions, { id: "friend-first", userId: friend.id, online: true, signingKey: testSigningKey }] };
    socket.receive({ type: "state", state });
    const sent = socket.sent.length;
    session.setVoiceVolume(friend.id, 1.7);
    session.setVoiceMuted(friend.id, true);
    expect(session.getSnapshot().voicePlaybackByUser.get(friend.id)).toEqual({ volume: 1.7, muted: true });
    expect(socket.sent).toHaveLength(sent);
    socket.receive({ type: "state", state: { ...state,
      sessions: [...initial.sessions, { id: "friend-reconnected", userId: friend.id, online: true, signingKey: testSigningKey }] } });
    expect(session.getSnapshot().voicePlaybackByUser.get(friend.id)).toEqual({ volume: 1.7, muted: true });
    session.setVoiceMuted(friend.id, false);
    expect(session.getSnapshot().voicePlaybackByUser.get(friend.id)).toEqual({ volume: 1.7, muted: false });
    session.setVoiceVolume(friend.id, 1);
    expect(session.getSnapshot().voicePlaybackByUser.size).toBe(0);
    session.setVoiceVolume(friend.id, 5);
    expect(session.getSnapshot().voicePlaybackByUser.get(friend.id)?.volume).toBe(2);
    socket.receive({ type: "state", state: initial });
    expect(session.getSnapshot().voicePlaybackByUser.size).toBe(0);
  } finally { session.close(); }
});

function microphoneMixer(clones: MediaStream[]) {
  class Context {
    currentTime = 0;
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
    gain = { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() };
    createGain = vi.fn(() => this.gain);
    createAnalyser = () => ({ fftSize: 256, getFloatTimeDomainData: vi.fn() });
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createMediaStreamDestination = vi.fn(() => {
      const track = remoteTrack("audio");
      vi.mocked(track.stop).mockImplementation(() => { Object.defineProperty(track, "readyState", { value: "ended" }); });
      const stream = Object.assign(remoteStream("processed", [track]), { clone: () => clones.shift()! });
      Object.defineProperty(stream, "active", { get: () => track.readyState === "live" });
      return { stream };
    });
  }
  const contexts: Context[] = [];
  vi.stubGlobal("AudioContext", class extends Context { constructor() { super(); contexts.push(this); } });
  return contexts;
}

test("voice rooms share one microphone gain graph and release it after the last consumer", async () => {
  const preferences = new Map<string, string>();
  preferences.set("piik:room-preferences:v1", JSON.stringify({ voiceInput: { deviceId: "saved-device", volume: .7, voiceProcessing: false }, voiceListeningVolume: 1.2 }));
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => preferences.set(key, value) } });
  const { session, socket } = await setup();
  const clones = [remoteStream("first", [remoteTrack("audio")]), remoteStream("second", [remoteTrack("audio")])];
  const contexts = microphoneMixer([...clones]);
  const raw = remoteTrack("audio");
  let grant!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  try {
    expect(session.getSnapshot()).toMatchObject({ voiceInput: { volume: .7 }, listeningVolume: 1.2 });
    const joining = [session.joinVoice("first"), session.joinVoice("second")];
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: "saved-device" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }) }));
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalledOnce();
    session.setInputVolume(.4);
    grant(remoteStream("source", [raw]));
    for (const roomId of ["first", "second"]) {
      await vi.waitFor(() => expect(socket.sent.some(command => command.type === "voice" && command.roomId === roomId)).toBe(true));
      const join = socket.sent.findLast(command => command.type === "voice" && command.roomId === roomId)!;
      socket.receive({ type: "room_reply", roomId, requestId: join.requestId, result: { type: "done" } });
      await vi.waitFor(() => expect(socket.sent.some(command => command.type === "publish" && (command.publication as { roomId: string }).roomId === roomId)).toBe(true));
      const publish = socket.sent.findLast(command => command.type === "publish" && (command.publication as { roomId: string }).roomId === roomId)!;
      socket.receive({ type: "room_reply", roomId, requestId: publish.requestId, result: { type: "done" } });
    }
    await Promise.all(joining);
    expect(contexts[0].createMediaStreamSource).toHaveBeenCalledOnce();
    expect(contexts[0].gain.gain.value).toBe(.4);
    session.setInputVolume(1.6); session.setListeningVolume(1.8);
    expect(contexts[0].gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1.6, 0, .01);
    expect(session.getSnapshot()).toMatchObject({ voiceInput: { volume: 1.6 }, listeningVolume: 1.8 });
    expect(JSON.parse(preferences.get("piik:room-preferences:v1")!)).toMatchObject({
      voiceInput: { deviceId: "saved-device", volume: 1.6, voiceProcessing: false }, voiceListeningVolume: 1.8,
    });
    const commands = socket.sent.length;
    const replacement = remoteTrack("audio");
    getUserMedia.mockResolvedValueOnce(remoteStream("replacement", [replacement]));
    await session.configureVoiceInput({ deviceId: "next-device", voiceProcessing: true });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].createMediaStreamDestination).toHaveBeenCalledOnce();
    expect(contexts[0].createMediaStreamSource).toHaveBeenCalledTimes(2);
    expect(contexts[0].createMediaStreamSource.mock.results[0].value.disconnect).toHaveBeenCalledOnce();
    expect(raw.onended).toBeNull();
    expect(raw.stop).toHaveBeenCalledOnce();
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(commands); // No replacement publication, join or route command.
    expect(session.getSnapshot().voiceInput).toEqual({ deviceId: "next-device", volume: 1.6, voiceProcessing: true });
    expect(JSON.parse(preferences.get("piik:room-preferences:v1")!).voiceInput).toEqual(session.getSnapshot().voiceInput);
    getUserMedia.mockRejectedValueOnce(new DOMException("Cannot open device", "NotReadableError"));
    await expect(session.configureVoiceInput({ deviceId: "failed-device" })).rejects.toThrow("Cannot open device");
    expect(session.getSnapshot().voiceInput.deviceId).toBe("next-device");
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(contexts[0].close).not.toHaveBeenCalled();
    let grantReplacement!: (stream: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>(resolve => { grantReplacement = resolve; }));
    const lateConfiguration = session.configureVoiceInput({ deviceId: "late-device" });
    const rejected = expect(lateConfiguration).rejects.toThrow("closed");
    for (const roomId of ["first", "second"]) {
      const leaving = session.leaveVoice(roomId);
      const request = socket.sent.at(-1)!;
      socket.receive({ type: "room_reply", roomId, requestId: request.requestId, result: { type: "done" } });
      await leaving;
      expect(contexts[0].close).toHaveBeenCalledTimes(roomId === "first" ? 0 : 1);
      expect(replacement.stop).toHaveBeenCalledTimes(roomId === "first" ? 0 : 1);
    }
    const late = remoteTrack("audio");
    grantReplacement(remoteStream("late-device", [late]));
    await rejected;
    expect(late.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().voiceInput.deviceId).toBe("next-device");
    for (const clone of clones) expect(clone.getAudioTracks()[0].stop).toHaveBeenCalledOnce();
  } finally { session.close(); }
  expect(contexts[0].close).toHaveBeenCalledOnce();
});

test("closing during microphone permission releases the pending context and late capture", async () => {
  const { session } = await setup();
  const contexts = microphoneMixer([]), raw = remoteTrack("audio");
  let grant!: (stream: MediaStream) => void;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve; }) } });
  const joining = session.joinVoice("first");
  const rejected = expect(joining).rejects.toThrow("closed");
  session.close();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  grant(remoteStream("late-source", [raw]));
  await rejected;
  expect(contexts[0].createMediaStreamSource).not.toHaveBeenCalled();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(raw.stop).toHaveBeenCalledOnce();
});

test("a source ending while voice join awaits authority cannot publish a live orphan clone", async () => {
  const { session, socket } = await setup();
  const track = remoteTrack("audio"), clone = remoteStream("pending-voice", [track]);
  const contexts = microphoneMixer([clone]), raw = remoteTrack("audio");
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => remoteStream("source", [raw]) } });
  try {
    const joining = session.joinVoice("first");
    const rejected = expect(joining).rejects.toThrow("microphone_unavailable");
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "voice", joined: true }));
    const join = socket.sent.at(-1)!;
    Object.defineProperty(raw, "readyState", { value: "ended" });
    raw.onended?.call(raw, new Event("ended"));
    expect(track.readyState).toBe("live");
    expect(contexts[0].close).toHaveBeenCalledOnce();
    socket.receive({ type: "room_reply", roomId: "first", requestId: join.requestId, result: { type: "done" } });
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "voice", joined: false }));
    expect(socket.sent.some(command => command.type === "publish")).toBe(false);
    const leave = socket.sent.at(-1)!;
    socket.receive({ type: "room_reply", roomId: "first", requestId: leave.requestId, result: { type: "done" } });
    await rejected;
    expect(track.stop).toHaveBeenCalled();
    expect(session.getSnapshot().pending.has("voice:first")).toBe(false);
    expect(session.getSnapshot().state?.voice).toEqual([]);
  } finally { session.close(); }
});

test("ending a Browser microphone retires its publication while room listening remains joined", async () => {
  const { session, socket } = await setup();
  const microphone = remoteTrack("audio"), stream = remoteStream("microphone", [microphone]);
  const contexts = microphoneMixer([stream]);
  const baseTrack = remoteTrack("audio"), base = Object.assign(remoteStream("microphone-source", [baseTrack]), { active: true, clone: () => stream });
  const getUserMedia = vi.fn(async () => base);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  try {
    const joining = session.joinVoice("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("voice"));
    const join = socket.sent.at(-1)!;
    expect(join).toMatchObject({ type: "voice", joined: true, muted: false });
    const state = { ...session.getSnapshot().state!, voice: [{ sessionId: "endpoint", roomId: "first", muted: false, deafened: true }] };
    socket.receive({ type: "state", state });
    socket.receive({ type: "room_reply", roomId: "first", requestId: join.requestId, result: { type: "done" } });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const publish = socket.sent.at(-1)!, publication = publish.publication as { id: string; roomId: string; kind: "voice"; muted: boolean };
    state.publications = [{ ...publication, sessionId: "endpoint", userId: "self" }];
    socket.receive({ type: "state", state });
    socket.receive({ type: "room_reply", roomId: "first", requestId: publish.requestId, result: { type: "done" } });
    await joining;

    state.channel.rooms[0].available = false;
    socket.receive({ type: "state", state });
    Object.defineProperty(baseTrack, "readyState", { value: "ended" });
    baseTrack.onended?.call(baseTrack, new Event("ended"));
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "unpublish" && command.publicationId === publication.id)).toBe(true));
    expect(socket.sent.at(-1)).toMatchObject({ type: "voice", roomId: "first", joined: true, muted: true, deafened: true });
    socket.receive({ type: "error", code: "room_host_offline" });
    expect(baseTrack.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(session.getSnapshot().state?.voice).toEqual([{ sessionId: "endpoint", roomId: "first", muted: true, deafened: true }]);
    const beforeRecovery = socket.sent.length;
    state.channel.rooms[0].available = true;
    socket.receive({ type: "state", state });
    expect(socket.sent.slice(beforeRecovery)).toContainEqual({ type: "unpublish", publicationId: publication.id });
    expect(socket.sent.slice(beforeRecovery)).toContainEqual({ type: "voice", roomId: "first", joined: true, muted: true, deafened: true });
    state.publications = [];
    state.voice[0].muted = true;
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().state?.voice).toEqual([{ sessionId: "endpoint", roomId: "first", muted: true, deafened: true }]);
    expect(session.getSnapshot().state?.channel.rooms.find(room => room.id === "first")?.available).toBe(true);
    expect(socket.sent.some(command => command.type === "leave" || command.type === "host_stop")).toBe(false);

    const nextTrack = remoteTrack("audio"), next = remoteStream("next-microphone", [nextTrack]);
    microphoneMixer([next]);
    const sourceTrack = remoteTrack("audio"), source = Object.assign(remoteStream("microphone-source", [sourceTrack]), { active: true, clone: () => next });
    getUserMedia.mockResolvedValue(source);
    const unmuting = session.setMuted("first", false);
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    const nextPublish = socket.sent.at(-1)!, nextPublication = nextPublish.publication as typeof publication;
    expect(nextPublication.id).not.toBe(publication.id);
    state.publications = [{ ...nextPublication, sessionId: "endpoint", userId: "self" }];
    socket.receive({ type: "state", state });
    socket.receive({ type: "room_reply", roomId: "first", requestId: nextPublish.requestId, result: { type: "done" } });
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "voice", muted: false, deafened: true }));
    state.voice[0].muted = false;
    socket.receive({ type: "state", state });
    socket.receive({ type: "room_reply", roomId: "first", requestId: socket.sent.at(-1)!.requestId, result: { type: "done" } });
    await unmuting;
    expect(session.getSnapshot().state?.voice[0].muted).toBe(false);

    socket.close();
    Object.defineProperty(nextTrack, "readyState", { value: "ended" });
    nextTrack.dispatchEvent(new Event("ended"));
    expect(sourceTrack.stop).toHaveBeenCalledOnce();
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state });
    expect(resumed.sent).toContainEqual({ type: "unpublish", publicationId: nextPublication.id });
    expect(resumed.sent).toContainEqual({ type: "voice", roomId: "first", joined: true, muted: true, deafened: true });
    expect(resumed.sent.some(command => command.type === "voice" && command.joined === false)).toBe(false);
  } finally { session.close(); }
});

test("local stop does not retire another capture acknowledged before its authority projection", async () => {
  const { session, socket } = await setup();
  const first = remoteTrack("video"), second = remoteTrack("video");
  try {
    const publishingFirst = session.publish("screen", "first", remoteStream("first-capture", [first]));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    const firstId = await publishingFirst;
    const state = structuredClone(session.getSnapshot().state!);
    state.publications = [{ id: firstId, roomId: "first", kind: "screen", muted: false, sessionId: "endpoint", userId: "self" }];
    socket.receive({ type: "state", state });

    const publishingSecond = session.publish("screen", "second", remoteStream("second-capture", [second]));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    const secondId = await publishingSecond;
    const stopping = session.stopScreen(firstId);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await stopping;
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();

    state.publications = [{ id: secondId, roomId: "second", kind: "screen", muted: false, sessionId: "endpoint", userId: "self" }];
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().ownedScreens.has(secondId)).toBe(true);
    expect(session.getSnapshot().state?.publications.map(publication => publication.id)).toEqual([secondId]);
    state.publications = [];
    socket.receive({ type: "state", state });
    expect(second.stop).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

test("camera and display shares use independent picture publications and the same stop owner", async () => {
  const { session, socket } = await setup();
  const display = remoteTrack("video"), camera = remoteTrack("video");
  const cameraStream = remoteStream("camera", [camera]);
  const getDisplayMedia = vi.fn(async () => remoteStream("display", [display]));
  const getUserMedia = vi.fn(async () => cameraStream);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia } });
  const previews = vi.spyOn(cameraPreviews, "loadCameraPreviews").mockResolvedValue();
  try {
    const screenStarting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const first = socket.sent.at(-1)!;
    socket.receive({ type: "ack", requestId: first.requestId });
    await screenStarting;
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: { frameRate: { ideal: 30 } }, audio: true });

    const cameraStarting = session.startScreen("second", "camera", "rear");
    await vi.waitFor(() => expect(socket.sent.filter(command => command.type === "publish")).toHaveLength(2));
    const second = socket.sent.at(-1)!;
    socket.receive({ type: "ack", requestId: second.requestId });
    await cameraStarting;
    const firstId = (first.publication as { id: string }).id, secondId = (second.publication as { id: string }).id;
    expect(second.publication).toEqual({ id: secondId, roomId: "second", kind: "screen", muted: false });
    expect(secondId).not.toBe(firstId);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: {
      resizeMode: { exact: "none" }, deviceId: { exact: "rear" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 },
    } });
    expect(camera.contentHint).toBe("motion");
    expect(session.getSnapshot().ownedScreens).toEqual(new Set([firstId, secondId]));
    const signal = new AbortController().signal, publish = vi.fn();
    await session.cameraPreviews(signal, publish);
    expect(previews).toHaveBeenLastCalledWith(signal, publish, cameraStream);

    const stopping = session.stopScreen(firstId);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await stopping;
    expect(display.stop).toHaveBeenCalledOnce();
    expect(camera.stop).not.toHaveBeenCalled();
    camera.dispatchEvent(new Event("ended"));
    expect(socket.sent.at(-1)).toMatchObject({ type: "unpublish", publicationId: secondId });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await vi.waitFor(() => expect(session.getSnapshot().pending.size).toBe(0));
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    await session.cameraPreviews(signal, publish);
    expect(previews).toHaveBeenLastCalledWith(signal, publish, undefined);
    expect(socket.sent.some(command => command.type === "voice")).toBe(false);
  } finally { session.close(); }
});

test("a rejected camera publication releases its capture without retaining a picture lease", async () => {
  const { session, socket } = await setup();
  const camera = remoteTrack("video");
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => remoteStream("camera", [camera]) } });
  try {
    const starting = session.startScreen("first", "camera", "front");
    const rejected = expect(starting).rejects.toThrow("permission_denied");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    socket.receive({ type: "error", requestId: socket.sent.at(-1)!.requestId, code: "permission_denied" });
    await rejected;
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    expect(session.getSnapshot().pending.size).toBe(0);
  } finally { session.close(); }
});

test("camera permission denial permits retry and closing discards a late camera grant", async () => {
  const { session, socket } = await setup();
  const denied = new DOMException("Declined", "NotAllowedError"), camera = remoteTrack("video");
  let grant!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn().mockRejectedValueOnce(denied)
    .mockImplementationOnce(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  try {
    await expect(session.startScreen("first", "camera")).rejects.toBe(denied);
    expect(session.getSnapshot().pending.size).toBe(0);
    const retrying = session.startScreen("first", "camera");
    const closed = expect(retrying).rejects.toThrow("closed");
    expect(grant).toBeDefined();
    session.close();
    grant(remoteStream("late-camera", [camera]));
    await closed;
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(socket.sent.some(command => command.type === "publish")).toBe(false);
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
  } finally { session.close(); }
});

test("Native capture previews before its snapshot, keeps picture on audio failure, and stops through its App owner", async () => {
  vi.stubGlobal("navigator", { userAgent: "test", userActivation: { isActive: false } });
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: 1, port: 8793, token: "approved" });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const target = { kind: "display" as const, sourceId: "1", title: "Test display" };
    const listing = session.nativeSources();
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("targets"));
    const activationURL = "intent://media#Intent;scheme=piik;package=tv.piik.android.test;end";
    const sources = { sources: [target], processAudio: false, systemAudio: true, activationURL };
    app.receive({ id: app.sent.at(-1)!.id, result: sources });
    await expect(listing).resolves.toEqual(sources);
    const starting = session.startNativeScreen("first", target, true);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("start_capture"));
    const publicationId = app.sent.at(-1)!.publicationId as string;
    expect(app.sent.at(-1)).toMatchObject({ type: "start_capture", publicationId, roomId: "first", target, audio: true });
    expect(session.nativeCaptureRequest("first")).toEqual({ publicationId, activationURL });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("subscribe"));
    expect(session.nativeCaptureRequest("first")).toBeUndefined();
    expect(session.getSnapshot().pending.has("screen:first")).toBe(true);
    const watch = socket.sent.at(-1)!;
    const state = session.getSnapshot().state!;
    socket.receive({ type: "state", state });
    const published = { ...state,
      publications: [{ id: publicationId, roomId: "first", sessionId: "native", userId: "self", kind: "screen", muted: false }],
      subscriptions: [publicationId],
    };
    socket.receive({ type: "state", state: published });
    socket.receive({ type: "room_reply", roomId: "first", requestId: watch.requestId, result: { type: "done" } });
    await starting;
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    expect(session.getSnapshot().state?.subscriptions).toEqual([publicationId]);

    const controllerSessionId = crypto.randomUUID(), intent = crypto.randomUUID().replaceAll("-", "");
    const remote = { mode: "ask", platform: "windows", canSetStopShortcut: false, requests: [{ id: intent, peerId: controllerSessionId, state: "pending" }] };
    app.receive({ type: "input_state", publicationId, state: remote });
    expect(session.getSnapshot().remoteControls.get(publicationId)).toEqual(remote);
    await expect(session.inputShortcut(publicationId)).resolves.toEqual({ key: 10, available: false });
    const rejectedShortcut = session.inputShortcut(publicationId, 11);
    expect(app.sent.at(-1)).toMatchObject({ type: "input_shortcut", publicationId, key: 11 });
    app.receive({ id: app.sent.at(-1)!.id, error: "input_shortcut_unavailable" });
    await expect(rejectedShortcut).rejects.toThrow("input_shortcut_unavailable");
    expect(session.getSnapshot().remoteControls.get(publicationId)?.stopShortcut).toBeUndefined();
    const registeringShortcut = session.inputShortcut(publicationId, 9);
    app.receive({ id: app.sent.at(-1)!.id, result: { key: 9, available: true } });
    await expect(registeringShortcut).resolves.toEqual({ key: 9, available: true });
    await expect(session.inputShortcut(publicationId)).resolves.toEqual({ key: 9, available: true });
    const enabling = session.inputPolicy(publicationId, "ask");
    expect(app.sent.at(-1)).toMatchObject({ type: "input_policy", publicationId, mode: "ask" });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await enabling;
    const approving = session.inputDecide(publicationId, intent, true);
    expect(app.sent.at(-1)).toMatchObject({ type: "input_decide", publicationId, controllerSessionId, intent, allow: true });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await approving;
    expect(socket.sent.some(command => command.type === "input_policy" || command.type === "input_decide")).toBe(false);

    app.receive({ type: "capture_audio_failed", publicationId });
    expect(session.getSnapshot().error).toBe("capture_audio_failed");
    expect(session.getSnapshot().appConnected).toBe(true);
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    expect(session.getSnapshot().state?.publications).toEqual(published.publications);
    expect(session.getSnapshot().state?.subscriptions).toEqual([publicationId]);
    expect(app.sent.some(command => command.type === "stop_capture")).toBe(false);
    session.clearError();
    app.receive({ type: "capture_audio_failed", publicationId: crypto.randomUUID() });
    expect(session.getSnapshot().error).toBeNull();

    const stopping = session.stopScreen(publicationId);
    expect(app.sent.at(-1)).toMatchObject({ type: "stop_capture", publicationId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    socket.receive({ type: "state", state });
    await stopping;
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    expect(session.getSnapshot().remoteControls.size).toBe(0);
    expect(socket.sent.some(command => command.type === "unpublish")).toBe(false);
    session.close();
    expect(app.readyState).toBe(3);
    expect(socket.sent.some(command => command.type === "host_stop")).toBe(false);
  } finally { session.close(); }
});

test("pending Native capture stays page-owned through same-page stop and close", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: 1, port: 8793, token: "approved" });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const target = { kind: "display" as const, sourceId: "1", title: "Test display" };
    const activationURL = "intent://media#Intent;scheme=piik;package=tv.piik.android.test;end";
    const sources = { sources: [target], processAudio: false, systemAudio: true, activationURL };
    const capabilities = session.nativeSources();
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("targets"));
    app.receive({ id: app.sent.at(-1)!.id, result: sources });
    await capabilities;
    const activate = vi.spyOn(nativeActivation, "activateNativePicker").mockImplementation(() => {
      expect(app.sent.at(-1)?.type).toBe("start_capture");
    });
    const starting = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("start_capture"));
    const request = app.sent.at(-1)!;
    const publicationId = request.publicationId as string;
    expect(publicationId).toEqual(expect.any(String));
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    expect(session.nativeCaptureRequest("first")).toEqual({ publicationId, activationURL });
    expect(activate).toHaveBeenCalledWith(activationURL);

    const listing = session.nativeSources();
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("targets"));
    app.receive({ id: app.sent.at(-1)!.id, result: sources });
    await listing;
    const stopping = session.stopScreen(publicationId);
    expect(app.sent.at(-1)).toMatchObject({ type: "stop_capture", publicationId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    app.receive({ id: request.id, error: "capture_cancelled" });
    await stopping;
    expect(await starting).toMatchObject({ name: "AbortError" });
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    expect(session.nativeCaptureRequest("first")).toBeUndefined();
    expect(session.getSnapshot().error).toBeNull();
    expect(socket.sent.some(command => command.type === "subscribe")).toBe(false);

    const failed = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("start_capture"));
    app.receive({ id: app.sent.at(-1)!.id, error: "capture_failed" });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("stop_capture"));
    expect(session.nativeCaptureRequest("first")).toBeUndefined();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    expect((await failed).message).toBe("capture_failed");

    const closing = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("start_capture"));
    expect(session.getSnapshot().ownedScreens.size).toBe(1);
    session.close();
    expect((await closing).message).toBe("app_disconnected");
    expect(app.readyState).toBe(3);
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    expect(session.nativeCaptureRequest("first")).toBeUndefined();
  } finally { session.close(); }
});

test("remembered App intent does not prevent Browser hosting when no App is connected", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  const discovery = vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue(null);
  const host = {
    roomId: "", summary: () => ({ id: host.roomId, name: "Browser room", icon: "couch", creatorId: "self", access: "public" as const, hidden: false, hasPassword: false }),
    bind: async () => {}, close: async () => {},
  };
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createRoomPolicy: async (input: unknown) => JSON.stringify(input),
    BrowserRoomHost: { open: async (_database: string, policy: string) => { host.roomId = JSON.parse(policy).id; return host; } },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const { session, socket } = await setup();
  try {
    expect(discovery).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({ appConnected: false, error: null });
    const creating = session.createRoom({ name: "Browser room", icon: "couch", access: "public", hidden: false });
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "host_register")).toBe(true));
    const register = socket.sent.find(command => command.type === "host_register")!;
    socket.receive({ type: "host_bound", roomId: host.roomId, bindingId: "browser-binding" });
    socket.receive({ type: "ack", requestId: register.requestId });
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "browse" && command.roomId === host.roomId)).toBe(true));
    const browse = socket.sent.findLast(command => command.type === "browse" && command.roomId === host.roomId)!;
    socket.receive({ type: "room_reply", roomId: host.roomId, requestId: browse.requestId, result: { type: "done" } });
    await expect(creating).resolves.toBe(host.roomId);
    expect(discovery).toHaveBeenCalledOnce();
    await expect(session.activateApp()).rejects.toThrow("app_disconnected");
    expect(session.getSnapshot().error).toBe("app_disconnected");
  } finally { session.close(); }
});

test("an App failure during creation does not turn that request into a Browser room", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: 1, port: 8793, token: "approved" });
  let prepared!: (policy: string) => void;
  let policy = "";
  const browserOpen = vi.fn();
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createRoomPolicy: (input: unknown) => { policy = JSON.stringify(input); return new Promise<string>(resolve => { prepared = resolve; }); },
    BrowserRoomHost: { open: browserOpen },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const creating = session.createRoom({ name: "App room", icon: "couch", access: "public", hidden: false });
    const failed = expect(creating).rejects.toThrow("app_disconnected");
    await vi.waitFor(() => expect(prepared).toBeTypeOf("function"));
    app.close();
    prepared(policy);
    await failed;
    expect(browserOpen).not.toHaveBeenCalled();
    expect(socket.sent.some(command => command.type === "host_register")).toBe(false);
    expect(session.getSnapshot().appConnected).toBe(false);
  } finally { session.close(); }
});

test("host binding precedes its first input and a failed binding retires that host", async () => {
  const host = {
    roomId: "",
    summary: () => ({ id: host.roomId, name: "Hosted", icon: "couch", creatorId: "self", access: "public" as const, hidden: false, hasPassword: false }),
    bind: vi.fn(async (_binding: string) => {}),
    dispatch: vi.fn(async (_input: unknown) => ({ bindingId: "binding" })),
    close: vi.fn(async () => {}),
  };
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createRoomPolicy: async (input: unknown) => JSON.stringify(input),
    BrowserRoomHost: {
      open: async (_database: string, policy: string) => { host.roomId = (JSON.parse(policy) as { id: string }).id; return host; },
      storedPolicies: async () => [],
    },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const { session, socket } = await setup();
  try {
    const creating = session.createRoom({ name: "Hosted", icon: "couch", access: "public", hidden: false });
    void creating.catch(() => {});
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "host_register")).toBe(true));
    const registration = socket.sent.at(-1)!;
    socket.receive({ type: "host_bound", roomId: host.roomId, bindingId: "binding" });
    const input = { bindingId: "binding", revision: 1, endpoints: {}, action: { type: "sync" } };
    socket.receive({ type: "host_input", roomId: host.roomId, input });
    expect(host.bind).toHaveBeenCalledWith("binding");
    expect(host.dispatch).toHaveBeenCalledWith(input);
    expect(host.bind.mock.invocationCallOrder[0]).toBeLessThan(host.dispatch.mock.invocationCallOrder[0]);
    socket.receive({ type: "ack", requestId: registration.requestId });
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "browse" && command.roomId === host.roomId)).toBe(true));
    const browse = socket.sent.findLast(command => command.type === "browse" && command.roomId === host.roomId)!;
    socket.receive({ type: "room_reply", roomId: host.roomId, requestId: browse.requestId, result: { type: "done" } });
    await expect(creating).resolves.toBe(host.roomId);
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "host_output")).toBe(true));
    host.bind.mockRejectedValueOnce(new Error("room_host_conflict"));
    socket.receive({ type: "host_bound", roomId: host.roomId, bindingId: "conflicting-binding" });
    await vi.waitFor(() => expect(session.getSnapshot().error).toBe("room_host_conflict"));
    expect(host.close).toHaveBeenCalledOnce();
    expect(socket.sent).toContainEqual({ type: "host_stop", roomId: host.roomId, bindingId: "conflicting-binding" });
    socket.receive({ type: "host_input", roomId: host.roomId, input: { ...input, bindingId: "conflicting-binding" } });
    expect(host.dispatch).toHaveBeenCalledOnce();
    expect(session.getSnapshot().connection).toBe("connected");
  } finally { session.close(); }
});

test("decorative identity keys remain extensible while missing icons and invalid wire values are rejected", async () => {
  const { session } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.icon = "Future_domain-7";
    state.channel.rooms[0].icon = "Future_room-8";
    state.channel.name = "😀".repeat(32);
    expect(snapshotSchema.parse(state).channel).toMatchObject({ name: state.channel.name, icon: "Future_domain-7", rooms: [
      expect.objectContaining({ icon: "Future_room-8" }), expect.anything(),
    ] });
    expect(snapshotSchema.safeParse({ ...state, channel: { ...state.channel, name: "😀".repeat(33) } }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...state, channel: { ...state.channel, icon: undefined } }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...state, channel: { ...state.channel, rooms: [{ ...state.channel.rooms[0], icon: undefined }] } }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...state, channel: { ...state.channel, rooms: [{ ...state.channel.rooms[0], participantSessionIds: undefined }] } }).success).toBe(false);
    expect(identityIconSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(identityIconSchema.safeParse("room/icon").success).toBe(false);
  } finally { session.close(); }
});

test("domain settings use a domain-scoped acknowledgement and surface rejected updates", async () => {
  const { session, socket } = await setup();
  try {
    let settled = false;
    const settings = { name: "Friends renamed", icon: "Future_domain-7" };
    const saving = session.updateDomain(settings).then(() => { settled = true; });
    const request = socket.sent.at(-1)!;
    expect(request).toEqual({ type: "update_domain", ...settings, requestId: expect.any(String) });
    expect(session.getSnapshot().pending.has("domain")).toBe(true);
    socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId, result: { type: "done" } });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.receive({ type: "ack", requestId: request.requestId });
    await saving;
    expect(session.getSnapshot().pending.has("domain")).toBe(false);

    const denied = session.updateDomain(settings);
    const rejected = expect(denied).rejects.toThrow("forbidden");
    socket.receive({ type: "error", requestId: socket.sent.at(-1)!.requestId, code: "forbidden" });
    await rejected;
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", error: "forbidden" });
    expect(session.getSnapshot().pending.has("domain")).toBe(false);
  } finally { session.close(); }
});

test("room replies settle only the request belonging to that room", async () => {
  const { session, socket } = await setup();
  try {
    let settled = false;
    const saving = session.updateRoom("first", { name: "Saved", icon: "couch", access: "public", hidden: false }).then(() => { settled = true; });
    const request = socket.sent.at(-1)!;
    socket.receive({ type: "room_reply", roomId: "second", requestId: request.requestId, result: { type: "done" } });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId,
      result: { type: "done" } });
    await saving;
    expect(settled).toBe(true);
    const updating = session.updateRoom("first", { name: "Unavailable", icon: "couch", access: "public", hidden: false });
    const rejected = expect(updating).rejects.toThrow("room_host_offline");
    socket.receive({ type: "room_reply", roomId: "first", requestId: socket.sent.at(-1)!.requestId,
      result: { type: "error", code: "room_host_offline" } });
    await rejected;
  } finally { session.close(); }
});

test.each([
  ["missing record", [2]],
  ["duplicate sequence", [2, 2]],
  ["missing snapshot", [2, 3]],
] as const)("an incomplete peer history page (%s) preserves messages and permits a complete retry", async (_fault, sequences) => {
  const { session, peer } = await setup();
  try {
    await peer.history([message(1)]);
    const existing = session.getSnapshot().messagesByRoom.first;
    const incomplete = session.loadLatestHistory("first");
    const rejected = expect(incomplete).rejects.toThrow("incomplete_history");
    const request = await peer.next();
    for (const seq of sequences) {
      peer.reply(request, { type: "history_message", message: message(seq) });
      if (_fault !== "missing snapshot") peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(seq, 0) });
    }
    peer.reply(request, { type: "history_end", count: 2, hasMore: false, oldestSeq: 2, before: null });
    await rejected;
    expect(session.getSnapshot().messagesByRoom.first).toBe(existing);
    expect(existing).toEqual([message(1)]);

    const complete = session.loadLatestHistory("first");
    const retry = await peer.next();
    peer.reply(retry, { type: "history_message", message: message(2) });
    peer.reply(retry, { type: "history_message", message: message(3) });
    peer.reply(retry, { type: "message_reactions", snapshot: reactionSnapshot(2, 0) });
    peer.reply(retry, { type: "message_reactions", snapshot: reactionSnapshot(3, 0) });
    expect(session.getSnapshot().messagesByRoom.first).toBe(existing);
    peer.reply(retry, { type: "history_end", count: 2, hasMore: false, oldestSeq: 2, before: null });
    await complete;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(2), message(3)]);
  } finally { session.close(); }
});

test("a separate directory storage error does not fail a committed room request", async () => {
  const { session, socket } = await setup();
  try {
    const updating = session.updateRoom("first", { name: "Saved", icon: "couch", access: "public", hidden: false });
    const request = socket.sent.at(-1)!;
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].name = "Saved";
    socket.receive({ type: "state", state });
    socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId, result: { type: "done" } });
    socket.receive({ type: "error", code: "directory_storage_failed" });
    await expect(updating).resolves.toBeUndefined();
    expect(session.getSnapshot().state?.channel.rooms[0].name).toBe("Saved");
    expect(session.getSnapshot().error).toBe("directory_storage_failed");
    expect(session.getSnapshot().pending.has("room:first")).toBe(false);
  } finally { session.close(); }
});

test("peer confirmation completes a send after browsing another room", async () => {
  const { session, socket, peer } = await setup();
  try {
    session.browse("second");
    let settled = false;
    const sending = session.sendMessage("first", "Hello 1").then(() => { settled = true; });
    void sending.catch(() => {});
    const request = await peer.next();
    expect(request.type).toBe("chat");
    expect(socket.sent.some(command => command.type === "chat")).toBe(false);
    expect(settled).toBe(false);
    expect(session.getSnapshot().pending.has("chat:first")).toBe(true);
    peer.reply(request, { type: "confirmed", message: message(1), inserted: true });
    await sending;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1)]);
    expect(session.getSnapshot().messagesByRoom.second).toBeUndefined();
    expect(settled).toBe(true);
    expect(session.getSnapshot().pending.has("chat:first")).toBe(false);
  } finally { session.close(); }
});

test("merges live messages and original confirmations once in room order within the latest window", async () => {
  const { session, peer } = await setup(2);
  try {
    await peer.history([message(3), message(4)], true);
    for (const [seq, expected] of [[1, [3, 4]], [6, [4, 6]], [5, [5, 6]]] as const) {
      const sending = session.sendMessage("first", message(seq).text);
      const request = await peer.next();
      peer.live(message(seq));
      peer.reply(request, { type: "confirmed", message: message(seq), inserted: false });
      await sending;
      expect(session.getSnapshot().messagesByRoom.first).toEqual(expected.map(message));
    }
  } finally { session.close(); }
});

test.each([
  ["empty", [], null],
  ["older", [message(1)], 1],
] as const)("a delayed %s history page preserves a newer live message", async (_page, messages, oldestSeq) => {
  const { session, peer } = await setup();
  try {
    const loading = session.loadLatestHistory("first");
    const request = await peer.next();
    peer.live(message(2));
    peer.page(request, [...messages], false, oldestSeq);
    await loading;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([...messages, message(2)]);
  } finally { session.close(); }
});

test("pages beyond a full window without live messages interrupting reading, then returns to latest", async () => {
  const { session, peer } = await setup(3);
  try {
    await peer.history([message(8), message(9)], true);
    await peer.history([message(7)], true, true);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(true);
    for (const first of [4, 1]) {
      const loading = session.loadHistory("first");
      void loading.catch(() => {});
      const request = await peer.next();
      expect(request).toMatchObject({ type: "history", before: first + 3 });
      peer.page(request, [message(first), message(first + 1), message(first + 2)], first > 1);
      await loading;
      expect(session.getSnapshot().messagesByRoom.first).toEqual([message(first), message(first + 1), message(first + 2)]);
      expect(session.getSnapshot().historyByRoom.first).toMatchObject({ before: first, atLatest: false });
    }
    peer.live(message(10));
    peer.live(message(4));
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1), message(2), message(3)]);
    const latest = session.loadLatestHistory("first");
    void latest.catch(() => {});
    const request = await peer.next();
    expect(request).not.toHaveProperty("before");
    peer.page(request, [message(9), message(10), message(11)], true);
    await latest;
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(true);
    peer.live(message(12));
    peer.live(message(12));
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(10), message(11), message(12)]);
  } finally { session.close(); }
});

test("a confirmed send returns a historical reader to latest without failing the send when history fails", async () => {
  const { session, peer } = await setup(1);
  try {
    await peer.history([message(2)], true);
    await peer.history([message(1)], false, true);
    const sending = session.sendMessage("first", "Hello 3");
    void sending.catch(() => {});
    const request = await peer.next();
    peer.reply(request, { type: "confirmed", message: message(3), inserted: true });
    await sending;
    const latest = await peer.next();
    expect(latest.type).toBe("history");
    expect(latest).not.toHaveProperty("before");
    peer.reply(latest, { type: "error", code: "storage_failed" });
    await vi.waitFor(() => expect(session.getSnapshot().error).toBe("storage_failed"));
    expect(session.getSnapshot().pending.has("chat:first")).toBe(false);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(false);
  } finally { session.close(); }
});

test("a confirmed file becomes a session source while its sender reads an older history window", async () => {
  const { session, socket, peer } = await setup(1);
  const file = new File(["saved"], "note.txt"), id = crypto.randomUUID();
  const attachment = { id, name: file.name, size: file.size, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  vi.spyOn(session.attachments, "describe").mockResolvedValue([{ id, file, attachment }]);
  try {
    await peer.history([message(2)], true);
    await peer.history([message(1)], false, true);
    const sending = session.sendMessage("first", "file", [{ id, file }]);
    const request = await peer.next();
    expect(request).toMatchObject({ type: "chat", attachments: [attachment] });
    peer.reply(request, { type: "confirmed", message: { ...message(3), attachments: [attachment] }, inserted: true });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1)]);
    expect(socket.sent.at(-1)).toMatchObject({ type: "file_offer", roomId: "first", messageSeq: 3, attachmentId: id, available: true });
    await expect(session.attachments.content({ roomId: "first", messageSeq: 3, attachmentId: id }, attachment, new AbortController().signal)).resolves.toBe(file);
    await sending;
  } finally { session.close(); }
});

class RoomDataChannel extends EventTarget {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  send = vi.fn();
  constructor(readonly label: string, readonly options: RTCDataChannelInit) { super(); }
  open() { this.readyState = "open"; this.onopen?.(); this.dispatchEvent(new Event("open")); }
  close() { if (this.readyState === "closed") return; this.readyState = "closed"; this.onclose?.(); this.dispatchEvent(new Event("close")); }
}
class RoomPeerConnection extends EventTarget {
  static instances: RoomPeerConnection[] = [];
  connectionState = "new";
  signalingState = "stable";
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RoomDataChannel }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  channels: RoomDataChannel[] = [];
  senders: Array<{ track: MediaStreamTrack; stream: MediaStream;
    getParameters(): RTCRtpSendParameters; setParameters(parameters: RTCRtpSendParameters): Promise<void> }> = [];
  receivers: RTCRtpReceiver[] = [];
  getStats = vi.fn(async (): Promise<RTCStatsReport> => new Map() as RTCStatsReport);
  close = vi.fn(() => { this.connectionState = "closed"; });
  constructor() { super(); RoomPeerConnection.instances.push(this); }
  createDataChannel(label: string, options: RTCDataChannelInit) {
    const channel = new RoomDataChannel(label, options); this.channels.push(channel); return channel;
  }
  addTrack(track: MediaStreamTrack, stream: MediaStream): RoomPeerConnection["senders"][number] {
    let parameters = { encodings: [{}] } as RTCRtpSendParameters;
    const sender = { track, stream, getParameters: () => structuredClone(parameters),
      setParameters: async (next: RTCRtpSendParameters) => { parameters = structuredClone(next); } };
    this.senders.push(sender); return sender;
  }
  removeTrack(sender: RoomPeerConnection["senders"][number]) { this.senders.splice(this.senders.indexOf(sender), 1); }
  getReceivers() { return this.receivers; }
  getTransceivers() { return this.senders.map(sender => ({ sender, currentDirection: "sendrecv" as RTCRtpTransceiverDirection })); }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (description.type === "answer" && this.signalingState !== "have-local-offer") throw new Error("answer without pending offer");
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: `offer-${this.channels.length}-${this.senders.length}` }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: `answer-${this.channels.length}-${this.senders.length}` }; }
  async setLocalDescription(description?: RTCSessionDescriptionInit) {
    const value = description ?? await (this.signalingState === "have-remote-offer" ? this.createAnswer() : this.createOffer());
    this.localDescription = { ...value, toJSON: () => ({ ...value }) };
    this.signalingState = value.type === "offer" ? "have-local-offer" : "stable";
  }
  connected() { this.connectionState = "connected"; this.onconnectionstatechange?.(); }
}

test("screen input shares its existing pair and retains only the committed flow's control session", async () => {
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  RoomPeerConnection.instances = [];
  const { session } = await setup();
  const local = "00000000-0000-4000-8000-000000000001", source = "00000000-0000-4000-8000-000000000002";
  const publicationId = crypto.randomUUID(), pairId = crypto.randomUUID(), first = crypto.randomUUID(), trial = crypto.randomUUID();
  let state = { ...session.getSnapshot().state!, subscriptions: [publicationId],
    publications: [{ id: publicationId, roomId: "first", sessionId: source, userId: "self", kind: "screen" as const, muted: false }],
    pairs: [{ id: pairId, peerId: source, rooms: [] as string[], outgoing: [],
      incoming: [{ id: first, publicationId, selected: true, inputFlowId: null }] }],
  };
  const register = vi.fn(), changed = vi.fn();
  let channels: ReadonlyMap<string, InputTransport> = new Map();
  let connected = true;
  const input = new ChannelInput({ context: () => ({ sessionId: local, state, connected }), register,
    send: (peer, frame) => media.sendInput(peer, frame), changed: value => { channels = value; changed(value); } });
  const media = new ChannelMedia(() => {}, () => {}, undefined, undefined, undefined,
    (pair, channel) => input.setChannel(pair, channel));
  let control: RemoteInputSession | undefined;
  try {
    media.update(local, state);
    const pc = RoomPeerConnection.instances.at(-1)!;
    expect(pc.channels.map(channel => channel.label)).toEqual(["piik-input"]);
    expect(pc.channels[0].options).toEqual({ ordered: true });
    pc.connected(); pc.channels[0].open(); input.update();
    const endpoint = channels.get(publicationId)!;
    expect(endpoint).toBeDefined();
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0][0]).toMatchObject({ type: "input_register", publicationId, flowId: first, secret: expect.any(Array) });
    expect(register.mock.calls[0][0].secret).toHaveLength(32);
    control = new RemoteInputSession(endpoint, () => {});
    (endpoint as unknown as EventTarget).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ platform: "windows", mode: "ask", state: "ready", capabilities: ["text"] }) }));
    control.request();
    expect(control.state?.state).toBe("pending");
    state = { ...state, pairs: [{ ...state.pairs[0], incoming: [...state.pairs[0].incoming, { id: trial, publicationId, selected: false, inputFlowId: null }] }] };
    media.update(local, state); input.update();
    state = { ...state, pairs: [{ ...state.pairs[0], incoming: state.pairs[0].incoming.filter(flow => flow.id !== trial) }] };
    media.update(local, state); input.update();
    expect(channels.get(publicationId)).toBe(endpoint);
    expect(control.state?.state).toBe("pending");
    expect(register).toHaveBeenCalledOnce();
    endpoint.close();
    expect(register).toHaveBeenCalledOnce(); // Logical close cannot synchronously create a replacement.
    input.update();
    const refreshed = channels.get(publicationId)!;
    expect(refreshed).not.toBe(endpoint);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1][0].secret).not.toEqual(register.mock.calls[0][0].secret);
    control.dispose(); control = new RemoteInputSession(refreshed, () => {});
    state = { ...state, pairs: [{ ...state.pairs[0], incoming: [{ ...state.pairs[0].incoming[0], id: trial }] }] };
    media.update(local, state); input.update();
    expect(refreshed.readyState).toBe("closed");
    expect(control.state).toBeNull();
    expect(channels.get(publicationId)).not.toBe(refreshed);
    expect(register).toHaveBeenCalledTimes(3);
    const replacement = channels.get(publicationId)!;
    pc.connectionState = "disconnected"; pc.onconnectionstatechange?.();
    expect(replacement.readyState).toBe("closed");
    expect(channels.size).toBe(0);
    expect(RoomPeerConnection.instances).toHaveLength(1);
    expect(pc.close).not.toHaveBeenCalled();
    connected = false;
    pc.connected();
    expect(channels.size).toBe(0);
    connected = true; input.update();
    const recovered = channels.get(publicationId)!;
    expect(recovered).toBeDefined();
    pc.channels[0].close();
    expect(recovered.readyState).toBe("closed");
    expect(pc.close).not.toHaveBeenCalled();
    expect(pc.channels).toHaveLength(1);
    media.update(local, state); input.update();
    expect(pc.channels.map(channel => channel.label)).toEqual(["piik-input", "piik-input"]);
    pc.channels[1].open();
    expect(channels.get(publicationId)?.readyState).toBe("open");
    expect(channels.get(publicationId)).not.toBe(recovered);
    expect(RoomPeerConnection.instances).toHaveLength(1);
    expect(register).toHaveBeenCalledTimes(5);

    // Drive the actual Browser relay adapter through its shared-core boundary;
    // routing policy itself is covered by the core's selected-lineage tests.
    const upstreamPair = crypto.randomUUID(), downstreamPair = crypto.randomUUID(), upstreamFlow = crypto.randomUUID();
    const controller = "00000000-0000-4000-8000-000000000003";
    const binding = { publicationId, controllerSessionId: controller, routeId: trial,
      upstream: { pairId: upstreamPair, peerId: source, flowId: upstreamFlow },
      downstream: { pairId: downstreamPair, peerId: controller, flowId: trial } };
    const relayState = { ...state, subscriptions: [], pairs: [
      { id: upstreamPair, peerId: source, rooms: ["first"], outgoing: [], incoming: [{ id: upstreamFlow, publicationId, selected: true, inputFlowId: null }] },
      { id: downstreamPair, peerId: controller, rooms: ["first"], incoming: [], outgoing: [{ id: trial, publicationId, selected: true, inputFlowId: upstreamFlow }] },
    ] };
    vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
      route_input: (frame: string) => JSON.stringify({ frame: { ...JSON.parse(frame), flowId: upstreamFlow }, route: { nextHop: source, binding } }),
      input_binding_current: () => true,
    } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
    const relayInput = new ChannelInput({ context: () => ({ sessionId: local, state: relayState, connected: true }), register: vi.fn(),
      send: (peer, frame) => relayMedia.sendInput(peer, frame), changed: () => {} });
    const relayMedia = new ChannelMedia(() => {}, () => {}, undefined, undefined, undefined,
      (pair, channel) => relayInput.setChannel(pair, channel));
    try {
      const start = RoomPeerConnection.instances.length;
      relayMedia.update(local, relayState);
      const [up, down] = RoomPeerConnection.instances.slice(start);
      for (const transport of [up, down]) { transport.connected(); for (const channel of transport.channels) channel.open(); }
      const upInput = up.channels.find(channel => channel.label === "piik-input")!;
      const downInput = down.channels.find(channel => channel.label === "piik-input")!;
      const frame = { publicationId, controllerSessionId: controller, routeId: trial, flowId: trial,
        data: { id: controller.replaceAll("-", ""), epoch: trial.replaceAll("-", ""), data: "opaque" } };
      downInput.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      await vi.waitFor(() => expect(upInput.send).toHaveBeenCalledOnce());
      expect(JSON.parse(upInput.send.mock.calls[0][0])).toMatchObject({ flowId: upstreamFlow, data: frame.data });
      downInput.close();
      expect(upInput.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(upInput.send.mock.calls[1][0])).toEqual({ publicationId, controllerSessionId: controller,
        routeId: trial, flowId: upstreamFlow, closed: true });
      relayInput.setChannel(downstreamPair, null);
      expect(upInput.send).toHaveBeenCalledTimes(2);
      expect(upInput.readyState).toBe("open");
      for (const transport of [up, down]) {
        expect(transport.close).not.toHaveBeenCalled();
        expect(transport.channels.find(channel => channel.label === "piik-room")?.readyState).toBe("open");
      }
      relayMedia.update(local, relayState); relayInput.update();
      const nextInput = down.channels.filter(channel => channel.label === "piik-input").at(-1)!;
      expect(nextInput).not.toBe(downInput);
      nextInput.open();
      nextInput.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      await vi.waitFor(() => expect(upInput.send).toHaveBeenCalledTimes(3));
      expect(JSON.parse(upInput.send.mock.calls[2][0])).toMatchObject({ flowId: upstreamFlow, data: frame.data });
      expect(up.channels.filter(channel => channel.label === "piik-input")).toHaveLength(1);
    } finally { relayInput.reset(); relayMedia.reset(); }
  } finally { control?.dispose(); input.reset(); media.reset(); session.close(); }
});

class RoomAudio {
  static instances: RoomAudio[] = [];
  autoplay = false;
  hidden = false;
  muted = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
  remove = vi.fn();
  constructor() { RoomAudio.instances.push(this); }
}

class RoomMediaStream {
  readonly id = crypto.randomUUID();
  constructor(private tracks: MediaStreamTrack[] = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  removeTrack(track: MediaStreamTrack) { this.tracks = this.tracks.filter(current => current !== track); }
}

async function setupRoomMedia() {
  RoomPeerConnection.instances = [];
  RoomAudio.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  vi.stubGlobal("Audio", RoomAudio);
  vi.stubGlobal("document", { body: { append: vi.fn() } });
  const { session, socket } = await setup();
  const state = structuredClone(session.getSnapshot().state!);
  const sent: ChannelCommand[] = [];
  const changed = vi.fn<(streams: ReadonlyMap<string, MediaStream>, inputs: ReadonlyMap<string, readonly ChannelScreenInput[]>) => void>();
  const media = new ChannelMedia(command => sent.push(command), changed);
  state.pairs = [{ id: "pair", peerId: "z", rooms: ["first"], incoming: [], outgoing: [] }];
  media.update("a", state);
  return { session, socket, media, state, sent, changed, pc: RoomPeerConnection.instances[0] };
}

const decodedReport = (framesDecoded: number) => new Map([["video", {
  id: "video", type: "inbound-rtp", kind: "video", framesDecoded,
}]]) as unknown as RTCStatsReport;

async function screenFixture() {
  const fixture = await setupRoomMedia();
  fixture.state.publications = [{ id: "screen", roomId: "first", sessionId: "z", userId: "other", kind: "screen", muted: false }];
  fixture.state.pairs[0].incoming = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
  fixture.media.update("a", fixture.state);
  fixture.pc.connected();
  return fixture;
}

const remoteTrack = (kind: "audio" | "video") => Object.assign(new EventTarget(), {
  id: crypto.randomUUID(), kind, readyState: "live", stop: vi.fn(),
}) as unknown as MediaStreamTrack;

const remoteStream = (id: string, tracks: MediaStreamTrack[]) => Object.assign(new EventTarget(), {
  id, getTracks: () => tracks, getVideoTracks: () => tracks.filter(track => track.kind === "video"),
  getAudioTracks: () => tracks.filter(track => track.kind === "audio"),
}) as unknown as MediaStream;

async function receiveScreen(fixture: Awaited<ReturnType<typeof screenFixture>>, stream: MediaStream) {
  fixture.media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: stream.id },
    tracks: [{ flowId: fixture.state.pairs[0].incoming[0].id, streamId: stream.id }] });
  await vi.waitFor(() => expect(fixture.pc.remoteDescription?.sdp).toBe(stream.id));
  fixture.pc.ontrack?.({ streams: [stream] });
}

test("an audio-first screen waits for decoded video on a currently connected transport", async () => {
  const fixture = await screenFixture();
  const { media, session, pc, sent } = fixture;
  vi.useFakeTimers();
  const tracks = [remoteTrack("audio")];
  const stream = remoteStream("screen-stream", tracks);
  let resolve!: (report: RTCStatsReport) => void;
  const pending = new Promise<RTCStatsReport>(done => { resolve = done; });
  const getStats = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(decodedReport(2));
  try {
    await receiveScreen(fixture, stream);
    stream.dispatchEvent(new Event("removetrack"));
    expect(sent.filter(command => command.type === "flow_state")).toEqual([]);
    const video = remoteTrack("video");
    tracks.push(video);
    pc.receivers = [{ track: video, getStats } as unknown as RTCRtpReceiver];
    pc.ontrack?.({ streams: [stream] });
    pc.connectionState = "disconnected"; pc.onconnectionstatechange?.();
    resolve(decodedReport(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter(command => command.type === "flow_state")).toEqual([]);
    pc.connected();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", state: "decoded" },
    ]);
  } finally { media.reset(); session.close(); }
});

test("a replaced screen cannot be proved by its old receiver's delayed stats", async () => {
  const fixture = await screenFixture();
  const { media, session, pc, sent } = fixture;
  vi.useFakeTimers();
  const resolves: Array<(report: RTCStatsReport) => void> = [];
  try {
    for (const id of ["old", "new"]) {
      const video = remoteTrack("video");
      const pending = new Promise<RTCStatsReport>(resolve => { resolves.push(resolve); });
      pc.receivers = [{ track: video, getStats: () => pending } as unknown as RTCRtpReceiver];
      await receiveScreen(fixture, remoteStream(id, [video]));
    }
    resolves[0](decodedReport(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter(command => command.type === "flow_state")).toEqual([]);
    resolves[1](decodedReport(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1);
  } finally { media.reset(); session.close(); }
});

test("a retired flow's late proof and cleanup cannot affect its replacement on the same pair", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc, sent } = fixture;
  vi.useFakeTimers();
  const oldVideo = remoteTrack("video"), nextVideo = remoteTrack("video");
  const oldStream = remoteStream("old-flow-stream", [oldVideo]);
  const nextStream = remoteStream("next-flow-stream", [nextVideo]);
  const listeners = vi.spyOn(oldStream, "addEventListener");
  let resolveOld!: (report: RTCStatsReport) => void;
  const pending = new Promise<RTCStatsReport>(resolve => { resolveOld = resolve; });
  try {
    state.pairs.push({ id: "downstream", peerId: "y", rooms: ["first"], incoming: [],
      outgoing: [{ id: "screen-downstream", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] });
    media.update("a", state);
    const downstream = RoomPeerConnection.instances[1];
    pc.receivers = [{ track: oldVideo, getStats: () => pending } as unknown as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    const lateCleanup = listeners.mock.calls.find(([type]) => type === "removetrack")![1] as EventListener;
    state.pairs[0].incoming = [];
    media.update("a", state);
    state.pairs[0].incoming = [{ id: "replacement-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    state.pairs[1].outgoing = [{ id: "replacement-downstream", publicationId: "screen", selected: true, inputFlowId: "replacement-flow" }];
    media.update("a", state);
    pc.ontrack?.({ streams: [oldStream] });
    expect(downstream.senders).toEqual([]);
    pc.receivers = [{ track: nextVideo, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    await receiveScreen(fixture, nextStream);
    await vi.advanceTimersByTimeAsync(0);
    resolveOld(decodedReport(20));
    lateCleanup(new Event("removetrack"));
    pc.ontrack?.({ streams: [oldStream] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", flowId: "replacement-flow", pairId: "pair", state: "decoded" },
    ]);
    expect(downstream.senders.map(sender => sender.track)).toEqual([nextVideo]);
    expect(pc.close).not.toHaveBeenCalled();
    expect(oldVideo.stop).not.toHaveBeenCalled(); expect(nextVideo.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each([
  { baseline: 100, first: 100, ready: false },
  { baseline: 100, first: 101, ready: true },
  { baseline: null, first: 100, ready: false },
])("a new flow proves decoded frames from its pre-SDP baseline $baseline -> $first", async sample => {
  const fixture = await screenFixture();
  const { media, session, pc, sent } = fixture;
  vi.useFakeTimers();
  const video = remoteTrack("video"), stream = remoteStream("new-flow-stream", [video]);
  let frames = sample.first;
  pc.getStats.mockImplementation(async () => {
    if (sample.baseline === null) throw new Error("stats unavailable");
    expect(pc.remoteDescription).toBeNull();
    return decodedReport(sample.baseline);
  });
  pc.receivers = [{ track: video, getStats: async () => decodedReport(frames) } as RTCRtpReceiver];
  try {
    await receiveScreen(fixture, stream);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(command => command.type === "flow_state" && command.state === "decoded")).toHaveLength(sample.ready ? 1 : 0);
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();
    if (!sample.ready) {
      frames++;
      await vi.advanceTimersByTimeAsync(100);
      expect(sent.filter(command => command.type === "flow_state" && command.state === "decoded")).toHaveLength(1);
    }
    await receiveScreen(fixture, stream);
    expect(pc.getStats).toHaveBeenCalledOnce();
  } finally { media.reset(); session.close(); }
});

test.each(["approved", "rejected", "retired"])("a leaf candidate stays separate until quality and presentation are %s", async outcome => {
  const fixture = await screenFixture();
  const { media, session, state, pc, sent, changed } = fixture;
  state.subscriptions = ["screen"];
  vi.useFakeTimers();
  const oldVideo = remoteTrack("video"), nextVideo = remoteTrack("video");
  const oldAudio = remoteTrack("audio"), nextAudio = remoteTrack("audio");
  const oldStream = remoteStream("incumbent", [oldVideo, oldAudio]), candidate = remoteStream("candidate", [nextVideo, nextAudio]);
  const quality = (track: MediaStreamTrack, fps: number): RTCStatsReport => new Map([[track.id, {
    id: track.id, type: "inbound-rtp", kind: "video", trackIdentifier: track.id, ssrc: 7,
    timestamp: Date.now(), bytesReceived: Date.now() * 10, framesDecoded: Math.floor(Date.now() / 1000 * fps),
    framesPerSecond: fps, frameWidth: 640, frameHeight: 360, packetsReceived: Date.now(), packetsLost: 0,
    freezeCount: 0, totalFreezesDuration: 0, pauseCount: 0, totalPausesDuration: 0,
  }]]) as unknown as RTCStatsReport;
  try {
    pc.receivers = [{ track: oldVideo, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    await vi.advanceTimersByTimeAsync(0);
    pc.getStats.mockImplementation(async () => quality(oldVideo, 10));
    state.pairs.push({ id: "candidate-pair", peerId: "x", rooms: [], outgoing: [],
      incoming: [{ id: "candidate-flow", publicationId: "screen", selected: false, inputFlowId: null }] });
    media.update("a", state);
    const next = RoomPeerConnection.instances[1]; next.connected();
    next.receivers = [{ track: nextVideo, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    media.signal("candidate-pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "candidate" },
      tracks: [{ flowId: "candidate-flow", streamId: candidate.id }] });
    await vi.waitFor(() => expect(next.remoteDescription?.sdp).toBe("candidate"));
    next.getStats.mockImplementation(async () => quality(nextVideo, outcome === "rejected" ? 5 : 10));
    next.ontrack?.({ streams: [candidate] });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "decoded" });
    expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
    media.screenPresentation("candidate-flow", candidate, "waiting");
    if (outcome === "retired") {
      state.pairs.pop(); media.update("a", state);
      await vi.advanceTimersByTimeAsync(8000);
      media.screenPresentation("candidate-flow", candidate, "prepared");
      expect(next.close).toHaveBeenCalledOnce();
    } else {
      await vi.advanceTimersByTimeAsync(6200);
      expect(sent.some(command => command.type === "flow_state" && command.state === "switch_ready")).toBe(false);
      media.screenPresentation("candidate-flow", candidate, "prepared");
      if (outcome === "approved") {
        expect(sent.filter(command => command.type === "flow_state" && command.state === "switch_ready")).toEqual([
          { type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "switch_ready" },
        ]);
        expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
        expect(changed.mock.calls.at(-1)![1].get("screen")?.find(value => value.flowId === "candidate-flow")?.switchReady).toBe(true);
        media.screenPresentation("candidate-flow", candidate, "waiting");
        state.pairs[0].incoming = [];
        state.pairs[1].incoming[0].selected = true;
        media.update("a", state);
        expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(candidate);
      } else {
        expect(sent).toContainEqual({ type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "failed" });
        expect(changed.mock.calls.at(-1)![1].get("screen")?.some(value => value.flowId === "candidate-flow")).toBe(false);
      }
    }
    if (outcome !== "approved") {
      expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
      expect(sent.some(command => command.type === "flow_state" && command.state === "switch_ready")).toBe(false);
    }
    for (const track of [oldVideo, nextVideo, oldAudio, nextAudio]) expect(track.stop).not.toHaveBeenCalled();
    expect(pc.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each(["commit", "failed"])("a shadow subtree forwards exact inputs and preserves the incumbent on %s", async outcome => {
  const fixture = await screenFixture();
  const { media, session, state, pc, changed, sent } = fixture;
  vi.useFakeTimers();
  const oldVideo = remoteTrack("video"), nextVideo = remoteTrack("video");
  const oldAudio = remoteTrack("audio"), nextAudio = remoteTrack("audio");
  const oldStream = remoteStream("old-branch", [oldVideo, oldAudio]);
  const candidate = remoteStream("shadow-branch", [nextVideo, nextAudio]);
  try {
    state.pairs.push({ id: "candidate-pair", peerId: "x", rooms: [], outgoing: [],
      incoming: [{ id: "candidate-flow", publicationId: "screen", selected: false, inputFlowId: null }] });
    state.pairs.push({ id: "downstream", peerId: "y", rooms: ["first"], incoming: [], outgoing: [
      { id: "current-output", publicationId: "screen", selected: true, inputFlowId: "screen-flow" },
      { id: "shadow-output", publicationId: "screen", selected: false, inputFlowId: "candidate-flow" },
    ] });
    media.update("a", state);
    const next = RoomPeerConnection.instances[1], downstream = RoomPeerConnection.instances[2];
    next.connected(); downstream.connected();
    pc.receivers = [{ track: oldVideo, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    next.receivers = [{ track: nextVideo, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    media.signal("candidate-pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: candidate.id },
      tracks: [{ flowId: "candidate-flow", streamId: candidate.id }] });
    await vi.waitFor(() => expect(next.remoteDescription?.sdp).toBe(candidate.id));
    next.ontrack?.({ streams: [candidate] });
    await vi.advanceTimersByTimeAsync(0);
    expect(downstream.senders.map(sender => sender.track)).toEqual([oldVideo, oldAudio, nextVideo, nextAudio]);
    const currentSenders = downstream.senders.slice(0, 2), shadowSenders = downstream.senders.slice(2);
    const shadowBinding = shadowSenders[0].stream;
    expect(shadowBinding).not.toBe(currentSenders[0].stream);
    expect(shadowSenders[1].stream).toBe(shadowBinding);
    expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
    expect(state.subscriptions).toEqual([]);
    expect(changed.mock.calls.at(-1)![1].get("screen")?.map(input => input.flowId)).toEqual(["screen-flow"]);
    expect(next.getStats).toHaveBeenCalledOnce();
    media.screenPresentation("candidate-flow", candidate, "prepared");
    expect(sent.some(command => command.type === "flow_state" && command.state === "switch_ready")).toBe(false);
    expect(RoomAudio.instances.map(audio => audio.srcObject?.getTracks())).toEqual([[oldAudio], [nextAudio]]);
    const shadowConsumer = RoomAudio.instances[1];
    if (outcome === "commit") {
      state.pairs[0].incoming = [];
      state.pairs[1].incoming[0].selected = true;
      state.pairs[2].outgoing.shift();
      state.pairs[2].outgoing[0].selected = true;
      media.update("a", state);
      expect(downstream.senders).toEqual(shadowSenders);
      expect(downstream.senders[0]).toBe(shadowSenders[0]);
      expect(downstream.senders[0].stream).toBe(shadowBinding);
      expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(candidate);
      expect(shadowConsumer.pause).not.toHaveBeenCalled();
      expect(RoomAudio.instances[0].pause).toHaveBeenCalledOnce();
    } else {
      media.signal("candidate-pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "candidate-ended" }, tracks: [] });
      await vi.waitFor(() => expect(next.remoteDescription?.sdp).toBe("candidate-ended"));
      expect(sent).toContainEqual({ type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "failed" });
      expect(downstream.senders).toEqual(currentSenders);
      expect(downstream.senders[0]).toBe(currentSenders[0]);
      expect(shadowBinding.getTracks()).toEqual([]);
      expect(shadowConsumer.pause).toHaveBeenCalledOnce();
      expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
      state.pairs.splice(1, 1);
      state.pairs[1].outgoing.pop();
      media.update("a", state);
      expect(next.close).toHaveBeenCalledOnce();
    }
    expect(pc.close).not.toHaveBeenCalled(); expect(downstream.close).not.toHaveBeenCalled();
    for (const track of [oldVideo, oldAudio, nextVideo, nextAudio]) expect(track.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("same-publication stream replacement re-proves progress on a reused receiver", async () => {
  const fixture = await screenFixture();
  const { media, session, pc, sent } = fixture;
  vi.useFakeTimers();
  const video = remoteTrack("video");
  let frames = 5;
  pc.receivers = [{ track: video, getStats: async () => decodedReport(frames) } as RTCRtpReceiver];
  try {
    await receiveScreen(fixture, remoteStream("old", [video]));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1);
    await receiveScreen(fixture, remoteStream("new", [video]));
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1);
    frames++;
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(2);
    expect(video.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("a relay updates senders when audio joins and leaves the same remote screen stream", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc } = fixture;
  const video = remoteTrack("video");
  const audio = remoteTrack("audio");
  const tracks = [video], stream = remoteStream("screen-stream", tracks);
  try {
    state.pairs.push({ id: "downstream", peerId: "y", rooms: ["first"], incoming: [], outgoing: [{ id: "screen-downstream", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] });
    media.update("a", state);
    const downstream = RoomPeerConnection.instances[1];
    await receiveScreen(fixture, stream);
    expect(downstream.senders.map(sender => sender.track)).toEqual([video]);
    const videoSender = downstream.senders[0];
    const binding = videoSender.stream;
    expect(binding.id).not.toBe(stream.id);
    tracks.push(audio);
    pc.ontrack?.({ streams: [stream] });
    expect(downstream.senders.map(sender => sender.track)).toEqual([video, audio]);
    await vi.waitFor(() => expect(downstream.senders[1].getParameters().encodings[0].maxBitrate).toBe(128_000));
    expect(downstream.senders[0]).toBe(videoSender);
    // Removing a remote track does not emit ontrack; the SDP replay republishes its stream.
    tracks.pop();
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "audio-removed" },
      tracks: [{ flowId: "screen-flow", streamId: stream.id }] });
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("audio-removed"));
    expect(downstream.senders.map(sender => sender.track)).toEqual([video]);
    expect(downstream.senders[0]).toBe(videoSender);
    expect(binding.getTracks()).toEqual([video]);
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "source-paused" }, tracks: [] });
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("source-paused"));
    expect(downstream.senders).toEqual([]);
    expect(binding.getTracks()).toEqual([]);
    await receiveScreen(fixture, stream);
    expect(downstream.senders[0].stream).toBe(binding);
    state.pairs[1].outgoing = [{ id: "renewed-screen-downstream", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }];
    media.update("a", state);
    expect(downstream.senders.map(sender => sender.track)).toEqual([video]);
    expect(downstream.senders[0].stream.id).not.toBe(binding.id);
    expect(binding.getTracks()).toEqual([]);
    expect(video.stop).not.toHaveBeenCalled(); expect(audio.stop).not.toHaveBeenCalled();
    expect(downstream.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each(["new", "source", "audio", "ended"])("sender rejection rolls back its %s allocation without affecting healthy outputs", async mode => {
  const replacing = mode !== "new";
  const survives = replacing && mode !== "ended";
  const { session, media, state, sent, pc } = await setupRoomMedia();
  const oldVideo = remoteTrack("video"), video = mode === "audio" ? oldVideo : remoteTrack("video"), rejectedAudio = remoteTrack("audio");
  const kept = remoteTrack("audio"), following = remoteTrack("audio");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    pc.connected(); pc.channels[0].open();
    state.publications = [
      { id: "screen", roomId: "first", sessionId: "a", userId: "self", kind: "screen", muted: false },
      ...["kept", "following"].map(id => ({ id, roomId: "first", sessionId: "a", userId: "self", kind: "voice" as const, muted: false })),
    ];
    media.setLocal("kept", remoteStream("kept", [kept]));
    media.setLocal("following", remoteStream("following", [following]));
    if (replacing) media.setLocal("screen", remoteStream("old-screen", [oldVideo]));
    state.pairs[0].outgoing = [
      ...(replacing ? [{ id: "screen-output", publicationId: "screen", selected: true, inputFlowId: null }] : []),
      { id: "kept-output", publicationId: "kept", selected: true, inputFlowId: null },
    ];
    media.update("a", state);
    const keptSender = pc.senders.find(sender => sender.track === kept);
    const oldBinding = pc.senders.find(sender => sender.track === oldVideo)?.stream;
    if (mode === "ended") Object.defineProperty(oldVideo, "readyState", { value: "ended" });
    const attach = pc.addTrack.bind(pc);
    const add = vi.spyOn(pc, "addTrack").mockImplementation((track, stream) => {
      if (track === rejectedAudio) throw new DOMException("sender attach rejected", "InvalidAccessError");
      return attach(track, stream);
    });
    const source = remoteStream("new-screen", [video, rejectedAudio]);
    if (!replacing) media.setLocal("screen", source);
    state.pairs[0].outgoing = [{ id: "screen-output", publicationId: "screen", selected: true, inputFlowId: null },
      { id: "kept-output", publicationId: "kept", selected: true, inputFlowId: null }, { id: "following-output", publicationId: "following", selected: true, inputFlowId: null }];
    expect(() => replacing ? media.setLocal("screen", source) : media.update("a", state)).not.toThrow();
    expect(pc.senders.map(sender => sender.track)).toEqual(survives ? [oldVideo, kept, following] : [kept, following]);
    expect(pc.senders.find(sender => sender.track === kept)).toBe(keptSender);
    expect(oldBinding?.getTracks() ?? []).toEqual(survives ? [oldVideo] : []);
    const failedBinding = add.mock.calls.find(([track]) => track === rejectedAudio)![1];
    expect(failedBinding.getTracks()).toEqual(survives ? [oldVideo] : []);
    expect(sent.filter(command => command.type === "flow_state")).toEqual(survives ? [] : [
      { type: "flow_state", flowId: "screen-output", pairId: "pair", state: "failed" },
    ]);
    expect(warning).toHaveBeenCalledWith("Channel media sender attach failed", { flowId: "screen-output", kind: "audio" }, expect.any(DOMException));
    if (!survives) {
      const attempts = add.mock.calls.length;
      media.update("a", state); media.update("a", state);
      expect(add).toHaveBeenCalledTimes(attempts);
    }
    state.pairs[0].outgoing.shift(); media.update("a", state);
    state.pairs[0].outgoing.push({ id: "renewed-screen-output", publicationId: "screen", selected: true, inputFlowId: null });
    add.mockImplementation(attach);
    media.update("a", state);
    expect(pc.senders.map(sender => sender.track)).toEqual([kept, following, video, rejectedAudio]);
    expect(pc.senders.find(sender => sender.track === video)?.stream.id).not.toBe(failedBinding.id);
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();
    for (const track of [oldVideo, video, rejectedAudio, kept, following]) expect(track.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each(["ended", "removetrack", "unmapped"])("a proven screen withdraws readiness when its video is %s", async ending => {
  const fixture = await screenFixture();
  const { media, session, pc, sent } = fixture;
  const video = remoteTrack("video"), tracks = [video], stream = remoteStream("screen-stream", tracks);
  pc.receivers = [{ track: video, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
  try {
    await receiveScreen(fixture, stream);
    await vi.waitFor(() => expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1));
    if (ending === "ended") {
      Object.defineProperty(video, "readyState", { value: "ended" });
      video.dispatchEvent(new Event("ended"));
    } else if (ending === "removetrack") {
      tracks.pop();
      stream.dispatchEvent(new Event("removetrack"));
    } else {
      media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "unmapped" }, tracks: [] });
      await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("unmapped"));
    }
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", state: "decoded" },
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", state: "failed" },
    ]);
    video.dispatchEvent(new Event("ended")); stream.dispatchEvent(new Event("removetrack"));
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(2);
    expect(video.stop).not.toHaveBeenCalled(); expect(pc.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("a replacement video waits for proof without treating the old input's retirement as failure", async () => {
  const fixture = await screenFixture();
  const { media, session, pc, sent } = fixture;
  const old = remoteTrack("video"), next = remoteTrack("video");
  const oldTracks = [old], oldStream = remoteStream("old", oldTracks), nextStream = remoteStream("new", [next]);
  let resolve!: (report: RTCStatsReport) => void;
  const pending = new Promise<RTCStatsReport>(done => { resolve = done; });
  try {
    pc.receivers = [{ track: old, getStats: async () => decodedReport(5) } as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    await vi.waitFor(() => expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1));
    pc.receivers = [{ track: next, getStats: () => pending } as RTCRtpReceiver];
    const applyDescription = pc.setRemoteDescription.bind(pc);
    vi.spyOn(pc, "setRemoteDescription").mockImplementation(async description => {
      await applyDescription(description);
      oldTracks.pop();
      oldStream.dispatchEvent(new Event("removetrack"));
    });
    await receiveScreen(fixture, nextStream);
    Object.defineProperty(old, "readyState", { value: "ended" }); old.dispatchEvent(new Event("ended"));
    oldStream.dispatchEvent(new Event("removetrack"));
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1);
    resolve(decodedReport(1));
    await vi.waitFor(() => expect(sent.filter(command => command.type === "flow_state")).toHaveLength(2));
    expect(sent.filter(command => command.type === "flow_state" && command.state === "failed")).toEqual([]);
  } finally { media.reset(); session.close(); }
});

test("bulk waits for its own open and buffer while control and media remain available", async () => {
  const { session, media, sent, pc } = await setupRoomMedia();
  try {
    const [control, bulk] = pc.channels;
    pc.connected(); control.open();
    const first = media.sendData("z", "chunk", new Uint8Array([1, 2]));
    await media.sendData("z", "control", "pull");
    expect(control.send).toHaveBeenLastCalledWith("pull");
    expect(bulk.send).not.toHaveBeenCalled();
    bulk.open(); await first;
    bulk.bufferedAmount = 65536;
    const blocked = media.sendData("z", "chunk", new Uint8Array([3]));
    await media.sendData("z", "control", "cancel");
    expect(bulk.send).toHaveBeenCalledOnce();
    bulk.bufferedAmount = 0; bulk.dispatchEvent(new Event("bufferedamountlow"));
    await blocked;
    expect(bulk.send).toHaveBeenCalledTimes(2);
    bulk.bufferedAmount = 65536;
    const closing = media.sendData("z", "chunk", new Uint8Array([4]));
    void closing.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    bulk.close();
    await expect(closing).rejects.toThrow("data_channel_unavailable");
    await media.sendData("z", "control", "still-open");
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.some(command => command.type === "base_state" && !command.ready)).toBe(false);
  } finally { media.reset(); session.close(); }
});

test("queued room data rechecks its owner before sending without closing the shared pair", async () => {
  const { session, media, pc } = await setupRoomMedia();
  try {
    const [control] = pc.channels;
    pc.connected(); control.open();
    control.bufferedAmount = 65536;
    let allowed = true;
    const queued = media.sendData("z", "control", "old-room-content", () => allowed);
    const rejected = expect(queued).rejects.toThrow("room_unavailable");
    await new Promise(resolve => setTimeout(resolve, 0));
    allowed = false;
    control.bufferedAmount = 0; control.dispatchEvent(new Event("bufferedamountlow"));
    await rejected;
    expect(control.send).not.toHaveBeenCalled();
    await media.sendData("z", "control", "current-room-content", () => true);
    expect(control.send).toHaveBeenCalledExactlyOnceWith("current-room-content");
    expect(pc.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("a connecting bulk channel has a bounded frame queue and releases admission after sending", async () => {
  const { session, media, pc } = await setupRoomMedia();
  try {
    pc.connected(); pc.channels[0].open();
    const frames = Array.from({ length: 32 * 17 }, () => media.sendData("z", "chunk", new Uint8Array(8192)));
    await expect(media.sendData("z", "chunk", new Uint8Array([1]))).rejects.toThrow("data_channel_busy");
    await media.sendData("z", "control", "independent");
    expect(pc.channels[0].send).toHaveBeenCalledOnce();
    pc.channels[1].open();
    await Promise.all(frames);
    await media.sendData("z", "chunk", new Uint8Array([2]));
    expect(pc.channels[1].send).toHaveBeenCalledTimes(32 * 17 + 1);
    expect(pc.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("rejected file admission cancels its shared-core consumer and releases the temporary sink", async () => {
  const cancel = vi.fn(() => "[]"), abort = vi.fn(async () => {}), removeEntry = vi.fn(async () => {});
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    initializeFiles: async () => {},
    FileDelivery: class { start() { return "[]"; } update() { return "[]"; } cancel = cancel; free() {} },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async () => ({ createWritable: async () => ({ abort }) }), removeEntry,
  }) }) } });
  const files = new ChannelAttachments(async command => { if (command.type === "file_receive" && command.enabled) throw new Error("forbidden"); }, async () => {});
  files.update("session", [], []);
  const key = { roomId: "room", messageSeq: 1, attachmentId: crypto.randomUUID() };
  const attachment = { id: key.attachmentId, name: "file", size: 1, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  try {
    await expect(files.download(key, attachment)).rejects.toThrow("forbidden");
    expect(cancel).toHaveBeenCalledWith(JSON.stringify(key));
    expect(abort).toHaveBeenCalledOnce(); expect(removeEntry).toHaveBeenCalledOnce();
    expect(files.status(key)).toEqual({ busy: false, error: "forbidden" });
  } finally { files.reset(); }
});

test.each(["flow", "pair", "attach"])("cross-pair retirement permits one companion-audio retry (%s)", async mode => {
  const { media, state, sent, pc, session } = await setupRoomMedia();
  const video = remoteTrack("video"), audio = remoteTrack("audio"), failedVideo = remoteTrack("video");
  const voices = [remoteTrack("audio"), remoteTrack("audio")];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const exchange = async (id: string, connection: RoomPeerConnection, trigger = true) => {
    const before = sent.length;
    if (trigger) connection.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent.slice(before).some(command => command.type === "signal"
      && command.pairId === id && command.payload.description?.type === "offer")).toBe(true));
    const command = sent.slice(before).find(command => command.type === "signal"
      && command.pairId === id && command.payload.description?.type === "offer")!;
    if (command.type !== "signal") throw new Error("missing offer");
    media.signal(id, { exchangeId: command.payload.exchangeId, description: { type: "answer", sdp: "accepted" }, tracks: [] });
    await vi.waitFor(() => expect(connection.signalingState).toBe("stable"));
  };
  try {
    state.publications = ["screen", "failed", "voice-0", "voice-1"].map(id => ({
      id, roomId: "first", sessionId: "a", userId: "self", kind: id.startsWith("voice") ? "voice" : "screen", muted: false,
    }));
    media.setLocal("screen", remoteStream("picture", [video]));
    media.setLocal("failed", remoteStream("unavailable-picture", [failedVideo]));
    voices.forEach((track, index) => media.setLocal(`voice-${index}`, remoteStream(`voice-${index}`, [track])));
    state.pairs[0].outgoing = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    state.pairs.push({ id: "other", peerId: "zz", rooms: ["second"], incoming: [], outgoing: voices.map((_, index) => ({
      id: `voice-flow-${index}`, publicationId: `voice-${index}`, selected: true, inputFlowId: null,
    })) });
    media.update("a", state);
    const other = RoomPeerConnection.instances[1];
    await exchange("pair", pc); await exchange("other", other);
    pc.connected(); other.connected();
    for (const connection of [pc, other]) for (const channel of connection.channels) channel.open();
    const incumbent = pc.senders[0];
    media.setLocal("screen", remoteStream("picture-with-audio", [video, audio]));
    state.pairs[0].outgoing.push({ id: "failed-flow", publicationId: "failed", selected: true, inputFlowId: null });
    media.update("a", state);
    const install = vi.spyOn(pc, "setLocalDescription").mockRejectedValueOnce(new DOMException("local offer refused", "OperationError"));
    pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(pc.senders).toEqual([incumbent]);
    expect(sent.filter(command => command.type === "flow_state" && command.state === "failed")).toEqual([
      { type: "flow_state", pairId: "pair", flowId: "failed-flow", state: "failed" },
    ]);
    media.update("a", state); media.update("a", state);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(install).toHaveBeenCalledOnce();

    const add = vi.spyOn(pc, "addTrack");
    if (mode === "attach") add.mockImplementationOnce(() => { throw new DOMException("audio still unavailable", "OperationError"); });
    if (mode === "pair") state.pairs.pop(); else state.pairs[1].outgoing.shift();
    media.update("a", state);
    await exchange("pair", pc, false);
    expect(add).toHaveBeenCalledOnce();
    expect(other.senders.some(sender => sender.track === voices[0]) && mode !== "pair").toBe(false);
    expect(other.close).toHaveBeenCalledTimes(mode === "pair" ? 1 : 0);
    if (mode === "attach") {
      expect(pc.senders).toEqual([incumbent]);
      media.update("a", state); media.update("a", state);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(add).toHaveBeenCalledOnce();
      state.pairs[1].outgoing = [];
      media.update("a", state);
      await exchange("pair", pc, false);
      expect(add).toHaveBeenCalledTimes(2);
    }
    expect(pc.senders.map(sender => sender.track)).toEqual([video, audio]);
    expect(pc.senders[0]).toBe(incumbent);
    const attempts = install.mock.calls.length;
    media.update("a", state); media.update("a", state);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(install).toHaveBeenCalledTimes(attempts);
    await expect(media.sendData("z", "control", "still-open")).resolves.toBeUndefined();
    expect(pc.channels[0].send).toHaveBeenLastCalledWith("still-open");
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    for (const track of [video, audio, failedVideo, ...voices]) expect(track.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each(["candidate", "audio", "source", "pending", "late", "channel", "initial", "unstable", "no-new"])("local offer failure scopes its %s work without retiring established media", async mode => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const sent: ChannelSignal[][] = [[], []], failed = vi.fn(), outgoingFailed = vi.fn();
  const transports = sent.map((signals, index) => new ChannelTransport({
    polite: Boolean(index), iceServers: [], send: signal => signals.push(signal),
    receive() {}, connected() {}, base() {}, failed, outgoingFailed,
  }));
  const [left, right] = transports, [pc, remote] = RoomPeerConnection.instances;
  const picture = remoteTrack("video"), voice = remoteTrack("audio"), next = remoteTrack(mode === "audio" ? "audio" : "video");
  const screen = remoteStream("incumbent", [picture]), audio = remoteStream("voice", [voice]);
  const outputs = new Map<string, { kind: "screen" | "voice"; stream: MediaStream }>([
    ["screen", { kind: "screen", stream: screen }], ["voice", { kind: "voice", stream: audio }],
  ]);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const exchange = async (trigger = true, duringPending?: () => void) => {
    if (trigger) pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0].some(signal => signal.description?.type === "offer")).toBe(true));
    const offer = sent[0].find(signal => signal.description?.type === "offer")!;
    duringPending?.();
    right.signal(offer);
    await vi.waitFor(() => expect(sent[1].some(signal => signal.exchangeId === offer.exchangeId)).toBe(true));
    left.signal(sent[1].find(signal => signal.exchangeId === offer.exchangeId)!);
    await vi.waitFor(() => expect(pc.signalingState).toBe("stable"));
    sent[0].length = 0; sent[1].length = 0;
  };
  try {
    if (mode !== "channel") { left.setRooms(["room"]); right.setRooms(["room"]); }
    left.setOutgoing(outputs);
    if (mode !== "initial") await exchange();
    if (mode === "pending") {
      outputs.set("confirmed", { kind: "screen", stream: remoteStream("confirmed", [remoteTrack("video")]) });
      left.setOutgoing(outputs);
      await exchange(true, () => {
        outputs.set("candidate", { kind: "screen", stream: remoteStream("later-than-offer", [next]) });
        left.setOutgoing(outputs);
      });
    }
    pc.connected(); remote.connected();
    for (const channel of pc.channels) channel.open();
    const established = pc.senders.filter(sender => sender.track !== next), wrapper = established[0].stream;
    if (mode === "audio") {
      outputs.set("screen", { kind: "screen", stream: remoteStream("with-audio", [picture, next]) });
    } else if (mode === "source") {
      const sender = established[0];
      outputs.set("screen", { kind: "screen", stream: remoteStream("withdrawn", []) });
      left.setOutgoing(outputs); // Only an actually detached sender can be reused by addTrack.
      Object.defineProperty(next, "id", { value: picture.id });
      vi.spyOn(pc, "addTrack").mockImplementationOnce((track, stream) => {
        sender.track = track; sender.stream = stream; pc.senders.push(sender); return sender;
      });
      outputs.set("screen", { kind: "screen", stream: remoteStream("replacement", [next]) });
    } else if (mode !== "no-new") outputs.set("candidate", { kind: "screen", stream: remoteStream("candidate", [next]) });
    left.setOutgoing(outputs);
    let reject!: () => void;
    const pending = new Promise<void>(resolve => { reject = resolve; });
    const install = vi.spyOn(pc, "setLocalDescription").mockImplementationOnce(async () => {
      if (mode === "unstable") pc.signalingState = "have-local-offer";
      if (mode === "late" || mode === "channel") await pending;
      throw new DOMException("local offer refused", "OperationError");
    });
    pc.onnegotiationneeded?.();
    let lateSender: typeof pc.senders[number] | undefined;
    if (mode === "channel") {
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
      left.setRooms(["room"]);
      for (const channel of pc.channels) channel.open();
      reject();
    }
    if (mode === "late") {
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
      lateSender = pc.senders.find(sender => sender.track === next)!;
      outputs.delete("candidate"); left.setOutgoing(outputs);
      const track = remoteTrack("video"); Object.defineProperty(track, "id", { value: next.id });
      vi.spyOn(pc, "addTrack").mockImplementationOnce((track, stream) => {
        lateSender!.track = track; lateSender!.stream = stream; pc.senders.push(lateSender!); return lateSender!;
      });
      outputs.set("later", { kind: "screen", stream: remoteStream("later", [track]) });
      left.setOutgoing(outputs);
      reject();
    }
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    const recoverable = mode !== "initial" && mode !== "unstable";
    if (!recoverable) {
      expect(failed).toHaveBeenCalledOnce();
      expect(outgoingFailed).not.toHaveBeenCalled();
      return;
    }
    expect(failed).not.toHaveBeenCalled();
    const retained = mode === "source" ? established.slice(1) : mode === "late" ? [...established, lateSender!] : established;
    expect(pc.senders).toEqual(retained);
    expect(pc.senders[0]).toBe(retained[0]);
    expect(wrapper.getTracks()).toEqual(mode === "source" ? [] : [picture]);
    expect(outgoingFailed.mock.calls).toEqual(["candidate", "pending", "channel"].includes(mode) ? [["candidate"]] : mode === "source" ? [["screen"]] : []);
    expect(left.isBaseReady()).toBe(true);
    await expect(left.sendData("control", "still-open")).resolves.toBeUndefined();
    expect(pc.channels[0].send).toHaveBeenLastCalledWith("still-open");
    if (mode !== "late" && mode !== "channel") expect(sent[0].some(signal => signal.description)).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();
    for (const track of [picture, voice, next]) expect(track.stop).not.toHaveBeenCalled();
    if (mode === "late" || mode === "channel") {
      await exchange(false);
      expect(pc.senders).toEqual(retained);
      if (mode === "late") expect(outgoingFailed).not.toHaveBeenCalled();
      return;
    }
    pc.onnegotiationneeded?.();
    left.setOutgoing(outputs); // An unchanged projection must not retry refused work.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(install).toHaveBeenCalledOnce();
    install.mockRestore();
    if (mode === "audio") {
      remote.onnegotiationneeded?.();
      await vi.waitFor(() => expect(sent[1].some(signal => signal.description?.type === "offer")).toBe(true));
      const offer = sent[1].find(signal => signal.description?.type === "offer")!;
      left.signal(offer);
      await vi.waitFor(() => expect(sent[0].some(signal => signal.exchangeId === offer.exchangeId)).toBe(true));
      right.signal(sent[0].find(signal => signal.exchangeId === offer.exchangeId)!);
      await vi.waitFor(() => expect(remote.signalingState).toBe("stable"));
      sent[0].length = 0; sent[1].length = 0;
      left.setOutgoing(outputs);
      expect(pc.senders.map(sender => sender.track)).toEqual([picture, voice]);
      expect(sent[0]).toEqual([]);
      outputs.delete("voice"); // A real resource release permits the refused audio binding to be tried again.
      left.setOutgoing(outputs);
      await exchange(false);
      expect(pc.senders.map(sender => sender.track)).toEqual([picture, next]);
      return;
    }
    outputs.delete("candidate");
    if (mode === "source") outputs.delete("screen"); else outputs.set("screen", { kind: "screen", stream: screen });
    left.setOutgoing(outputs);
    const following = remoteTrack("video");
    outputs.set("following", { kind: "screen", stream: remoteStream("following", [following]) });
    left.setOutgoing(outputs);
    await exchange(false);
    expect(failed).not.toHaveBeenCalled();
    expect(pc.senders.some(sender => sender.track === following)).toBe(true);
  } finally { transports.forEach(transport => transport.close()); }
});

test("shared media negotiates stereo reception in both offer directions without replacing voice or picture tracks", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const sent: ChannelSignal[][] = [[], []], failed = vi.fn();
  const transports = sent.map((signals, index) => new ChannelTransport({
    polite: Boolean(index), iceServers: [], send: signal => signals.push(signal),
    receive() {}, connected() {}, base() {}, failed,
  }));
  const connections = RoomPeerConnection.instances;
  const voice = remoteTrack("audio"), audio = remoteTrack("audio"), video = remoteTrack("video");
  const sdp = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0",
    ...[0, 1].flatMap(mid => ["m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=mid:${mid}`, "a=sendrecv",
      "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1"]),
    "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:2", "a=sendrecv", "a=rtpmap:96 VP8/90000", "",
  ].join("\r\n");
  try {
    transports[0].setOutgoing(new Map([
      ["voice", { kind: "voice", stream: remoteStream("voice", [voice]) }],
      ["picture", { kind: "screen", stream: remoteStream("picture", [video, audio]) }],
    ]));
    const senders = [...connections[0].senders];
    for (const pc of connections) {
      vi.spyOn(pc, "createOffer").mockResolvedValue({ type: "offer", sdp });
      vi.spyOn(pc, "createAnswer").mockResolvedValue({ type: "answer", sdp });
    }
    for (const offerer of [0, 1, 0]) {
      const answerer = 1 - offerer;
      sent[0].length = 0; sent[1].length = 0;
      connections[offerer].onnegotiationneeded?.();
      await vi.waitFor(() => expect(sent[offerer].some(value => value.description?.type === "offer")).toBe(true));
      const offer = sent[offerer].find(value => value.description?.type === "offer")!;
      expect(offer.description?.sdp?.match(/stereo=1/g)).toHaveLength(2);
      expect(offer.description?.sdp?.match(/maxaveragebitrate=510000/g)).toHaveLength(2);
      expect(connections[offerer].localDescription?.sdp).toBe(offer.description?.sdp);
      transports[answerer].signal(offer);
      await vi.waitFor(() => expect(sent[answerer].some(value => value.description?.type === "answer")).toBe(true));
      const answer = sent[answerer].find(value => value.description?.type === "answer")!;
      expect(answer.description?.sdp?.match(/stereo=1/g)).toHaveLength(2);
      expect(connections[answerer].localDescription?.sdp).toBe(answer.description?.sdp);
      transports[offerer].signal(answer);
      await vi.waitFor(() => expect(connections[offerer].signalingState).toBe("stable"));
      expect(connections[offerer].remoteDescription?.sdp).toBe(answer.description?.sdp);
      expect(connections[answerer].remoteDescription?.sdp).toBe(offer.description?.sdp);
      expect(connections[0].senders).toEqual(senders);
    }
    expect(failed).not.toHaveBeenCalled();
    for (const track of [voice, audio, video]) expect(track.stop).not.toHaveBeenCalled();
  } finally { for (const transport of transports) transport.close(); }
});

test.each(["offer", "answer"])("resync recovers a lost %s on the same transport with its original track manifest", async lost => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const sent: ChannelSignal[][] = [[], []];
  const failed = [vi.fn(), vi.fn()];
  const transports = sent.map((signals, i) => new ChannelTransport({
    polite: Boolean(i), iceServers: [], send: payload => signals.push(signalSchema.parse(payload)),
    receive: () => {}, connected: () => {}, base: () => {}, failed: failed[i],
  }));
  const [a, b] = transports, [pcA, pcB] = RoomPeerConnection.instances;
  const remoteA = vi.spyOn(pcA, "setRemoteDescription"), remoteB = vi.spyOn(pcB, "setRemoteDescription");
  const stream = (id: string) => ({ id, getTracks: () => [{ kind: "audio" }] }) as unknown as MediaStream;
  try {
    a.setOutgoing(new Map([["voice-flow", { kind: "voice", stream: stream("original") }]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0]).toHaveLength(1));
    const offer = structuredClone(sent[0].shift()!);
    let withheldAnswer: ChannelSignal | undefined;
    if (lost === "answer") {
      b.setOutgoing(new Map([["reverse-flow", { kind: "voice", stream: stream("revoked-reverse") }]]));
      b.signal(offer);
      await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
      withheldAnswer = sent[1].shift(); // The peer applied the offer, but its answer was lost.
      b.setOutgoing(new Map());
    }
    // A later demand must not rewrite the manifest of the offer already in flight.
    a.setOutgoing(new Map([["replacement-flow", { kind: "voice", stream: stream("replacement") }]]));
    if (lost === "offer") {
      b.resync(); // Only the receiving peer reconnects; it cannot know A has an offer.
      await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
      a.signal(sent[1].shift()!);
    } else a.resync(); // Only the peer that missed the answer reconnects.
    await vi.waitFor(() => expect(sent[0].some(signal => signal.description)).toBe(true));
    const replay = sent[0].find(signal => signal.description)!;
    expect(replay).toEqual({ ...offer, tracks: [] });
    expect(offer.tracks).toEqual([{ flowId: "voice-flow", streamId: expect.any(String) }]);
    expect(offer.tracks![0].streamId).not.toBe("original");
    b.signal(replay);
    await vi.waitFor(() => expect(sent[1].some(signal => signal.description?.type === "answer")).toBe(true));
    const answer = sent[1].find(signal => signal.description?.type === "answer")!;
    expect(answer.exchangeId).toBe(offer.exchangeId);
    expect(answer.tracks).toEqual([]);
    if (withheldAnswer) expect(withheldAnswer.tracks).toEqual([{ flowId: "reverse-flow", streamId: expect.any(String) }]);
    a.signal(answer);
    await vi.waitFor(() => expect(pcA.signalingState).toBe("stable"));
    a.signal(answer);
    a.signal({ resync: true }); // Stable transports have no pending offer to replay.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(remoteA).toHaveBeenCalledOnce();
    expect(remoteB).toHaveBeenCalledOnce();
    expect(failed.every(callback => callback.mock.calls.length === 0)).toBe(true);
    expect(pcA.close).not.toHaveBeenCalled(); expect(pcB.close).not.toHaveBeenCalled();
    expect(RoomPeerConnection.instances).toHaveLength(2);
  } finally { transports.forEach(transport => transport.close()); }
});

test("an earlier answer cannot finish a newer exchange on the same transport", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const sent: ChannelSignal[][] = [[], []], failed = vi.fn();
  const transports = sent.map((signals, i) => new ChannelTransport({
    polite: Boolean(i), iceServers: [], send: payload => signals.push(signalSchema.parse(payload)),
    receive: () => {}, connected: () => {}, base: () => {}, failed,
  }));
  const [a, b] = transports, [pcA, pcB] = RoomPeerConnection.instances;
  const remoteA = vi.spyOn(pcA, "setRemoteDescription");
  const stream = (id: string) => ({ id, getTracks: () => [{ kind: "audio" }] }) as unknown as MediaStream;
  try {
    a.setOutgoing(new Map([["voice-flow", { kind: "voice", stream: stream("old") }]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0]).toHaveLength(1));
    const oldOffer = sent[0].shift()!;
    b.signal(oldOffer);
    await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
    const oldAnswer = sent[1].shift()!;
    a.signal(oldAnswer);
    await vi.waitFor(() => expect(pcA.signalingState).toBe("stable"));
    a.setOutgoing(new Map([["voice-flow", { kind: "voice", stream: stream("new") }]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0].some(signal => signal.description)).toBe(true));
    const newOffer = sent[0].find(signal => signal.description)!;
    expect(newOffer.exchangeId).not.toBe(oldOffer.exchangeId);
    expect(newOffer.tracks).toEqual(oldOffer.tracks);
    a.signal(oldAnswer);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(remoteA).toHaveBeenCalledOnce();
    expect(pcA.signalingState).toBe("have-local-offer");
    b.signal(newOffer);
    await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
    expect(sent[1][0].exchangeId).toBe(newOffer.exchangeId);
    a.signal(sent[1][0]);
    await vi.waitFor(() => expect(pcA.signalingState).toBe("stable"));
    expect(remoteA).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
    expect(pcA.close).not.toHaveBeenCalled(); expect(pcB.close).not.toHaveBeenCalled();
  } finally { transports.forEach(transport => transport.close()); }
});

test("a resumed welcome requests resync only for the surviving transport plan", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const { session, socket } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.pairs = ["kept", "removed"].map(id => ({ id, peerId: "z", rooms: ["first"], incoming: [], outgoing: [] }));
    socket.receive({ type: "state", state });
    const [kept, removed] = RoomPeerConnection.instances;
    kept.connected(); kept.channels[0].open();
    socket.close(); session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    state.pairs.pop();
    resumed.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state });
    await vi.waitFor(() => expect(resumed.sent.filter(command => command.type === "signal")).toEqual([
      { type: "signal", pairId: "kept", payload: { resync: true } },
    ]));
    expect(kept.close).not.toHaveBeenCalled();
    expect(removed.close).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

test("source replacement releases unmapped streams and ignores their late track events", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const receive = vi.fn(), send = vi.fn();
  const transport = new ChannelTransport({ polite: true, iceServers: [], send, receive, connected: () => {}, base: () => {}, failed: vi.fn() });
  const pc = RoomPeerConnection.instances[0], stop = vi.fn();
  const stream = (id: string) => ({ id, getTracks: () => [{ stop }] }) as unknown as MediaStream;
  const old = stream("old-source"), current = stream("current-source");
  const offer = (streams: Array<[string, MediaStream]>) => transport.signal({
    exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "source update" },
    tracks: streams.map(([flowId, stream]) => ({ flowId, streamId: stream.id })),
  });
  try {
    offer([["old-flow", old]]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    pc.ontrack?.({ streams: [old] });
    expect(receive).toHaveBeenLastCalledWith("old-flow", old);
    offer([["current-flow", current]]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    pc.ontrack?.({ streams: [current] });
    pc.ontrack?.({ streams: [old] }); // A retired source event must not repopulate the cache.
    receive.mockClear();
    offer([["renewed-flow", old], ["current-flow", current]]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(receive.mock.calls).toEqual([["current-flow", current]]);
    const fresh = stream(old.id);
    pc.ontrack?.({ streams: [fresh] });
    expect(receive).toHaveBeenLastCalledWith("renewed-flow", fresh);
    expect(stop).not.toHaveBeenCalled();
  } finally { transport.close(); }
});

test("base proof waits for open data and connected transport; removing leases preserves media", async () => {
  const { session, media, state, sent, pc } = await setupRoomMedia();
  try {
    pc.connected();
    expect(sent.filter(command => command.type === "base_state")).toEqual([]);
    expect(pc.channels[0].options).toEqual({ ordered: true });
    pc.channels[0].open();
    expect(sent.filter(command => command.type === "base_state")).toEqual([{ type: "base_state", pairId: "pair", roomId: "first", ready: true }]);
    state.pairs[0].rooms.push("second");
    media.update("a", state);
    expect(sent.at(-1)).toEqual({ type: "base_state", pairId: "pair", roomId: "second", ready: true });
    state.pairs[0].rooms = [];
    state.pairs[0].outgoing = [{ id: "screen-outgoing", publicationId: "screen", selected: true, inputFlowId: null }];
    media.update("a", state);
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.filter(command => command.type === "base_state" && !command.ready)).toEqual([]);
    state.pairs = [];
    media.update("a", state);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(sent.filter(command => command.type === "base_state" && !command.ready)).toEqual([]);
  } finally { media.reset(); session.close(); }
});

test("data failure retires only the base attempt and does not retry unchanged demand", async () => {
  const { session, media, state, sent, pc } = await setupRoomMedia();
  try {
    pc.connected(); pc.channels[0].open(); pc.channels[0].close();
    expect(sent.at(-1)).toEqual({ type: "base_state", pairId: "pair", roomId: "first", ready: false });
    media.update("a", state); media.update("a", state);
    expect(pc.channels).toHaveLength(2);
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    state.pairs[0].rooms.push("second");
    media.update("a", state);
    expect(pc.channels).toHaveLength(3);
  } finally { media.reset(); session.close(); }
});

test("transient transport loss retains base leases and proves new leases after recovery", async () => {
  const { session, media, state, sent, pc } = await setupRoomMedia();
  try {
    pc.connected(); pc.channels[0].open();
    sent.length = 0;
    pc.connectionState = "disconnected"; pc.onconnectionstatechange?.();
    state.pairs[0].rooms.push("second");
    media.update("a", state);
    expect(sent).toEqual([]);
    expect(pc.close).not.toHaveBeenCalled();
    pc.connected();
    expect(sent.filter(command => command.type === "base_state")).toEqual([
      { type: "base_state", pairId: "pair", roomId: "second", ready: true },
    ]);
    pc.connectionState = "failed"; pc.onconnectionstatechange?.();
    expect(sent.filter(command => command.type === "base_state" && !command.ready)).toEqual([
      { type: "base_state", pairId: "pair", roomId: "first", ready: false },
      { type: "base_state", pairId: "pair", roomId: "second", ready: false },
    ]);
    expect(sent.at(-1)).toEqual({ type: "link_state", pairId: "pair", state: "failed" });
  } finally { media.reset(); session.close(); }
});

test("connected media keeps its PC when the base channel exceeds the existing preparation deadline", async () => {
  vi.useFakeTimers();
  const { session, media, state, sent, pc } = await setupRoomMedia();
  try {
    pc.connected();
    vi.advanceTimersByTime(19999);
    expect(sent.some(command => command.type === "base_state")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: "base_state", pairId: "pair", roomId: "first", ready: false });
    expect(pc.close).not.toHaveBeenCalled();
    media.update("a", state);
    expect(pc.channels).toHaveLength(2);
    vi.advanceTimersByTime(20000);
    expect(sent.filter(command => command.type === "base_state")).toHaveLength(1);
  } finally { media.reset(); session.close(); }
});

test("browsing retires only reading and resumes the offline selection without ending subscriptions", async () => {
  const { session, socket } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.publications = [{ id: "screen", roomId: "first", sessionId: "other", userId: "friend", kind: "screen", muted: false }];
    socket.receive({ type: "state", state });
    const watching = session.watch("screen");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await watching;
    state.subscriptions = ["screen"];
    socket.receive({ type: "state", state });
    session.browse("second");
    expect(socket.sent.slice(-2)).toEqual([{ type: "browse", roomId: "first", active: false }, expect.objectContaining({ type: "browse", roomId: "second", active: true })]);
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    socket.close();
    const count = socket.sent.length;
    session.browse("first");
    expect(socket.sent).toHaveLength(count);
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    state.channel.rooms.forEach(room => { room.reading = room.id === "second"; });
    resumed.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state });
    expect(resumed.sent.slice(-2)).toEqual([{ type: "browse", roomId: "second", active: false }, expect.objectContaining({ type: "browse", roomId: "first", active: true })]);
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    expect(resumed.sent.some(command => ["unpublish", "subscribe", "voice"].includes(String(command.type)))).toBe(false);
  } finally { session.close(); }
});

test("rapid browsing retires the previous intent before its reading projection arrives", async () => {
  const { session, socket } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms.forEach(room => { room.reading = false; });
    socket.receive({ type: "state", state });
    session.browse("first");
    session.browse("second");
    expect(socket.sent.slice(-3)).toEqual([
      expect.objectContaining({ type: "browse", roomId: "first", active: true }),
      { type: "browse", roomId: "first", active: false },
      expect.objectContaining({ type: "browse", roomId: "second", active: true }),
    ]);
  } finally { session.close(); }
});

test("a resumed room owner retires reading left behind by an offline room switch", async () => {
  const { session, socket } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].available = false;
    socket.receive({ type: "state", state });
    const beforeSwitch = socket.sent.length;
    session.browse("second");
    expect(socket.sent.slice(beforeSwitch)).toEqual([expect.objectContaining({ type: "browse", roomId: "second", active: true })]);
    state.channel.rooms[1].reading = true;
    socket.receive({ type: "state", state });
    const beforeResume = socket.sent.length;
    state.channel.rooms[0].available = true;
    socket.receive({ type: "state", state });
    expect(socket.sent.slice(beforeResume)).toEqual([{ type: "browse", roomId: "first", active: false }]);
    const afterResume = socket.sent.length;
    socket.receive({ type: "state", state });
    expect(socket.sent).toHaveLength(afterResume);
    expect(session.getSnapshot().sessionId).toBe("endpoint");
  } finally { session.close(); }
});

test("voice forwards without local listening and the same pair carries the reverse source", async () => {
  const { session, media, state, pc } = await setupRoomMedia();
  const aTrack = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  const bTrack = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  const voice = (id: string, track: MediaStreamTrack) => ({ id, getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }) as unknown as MediaStream;
  const incoming = voice("a-stream", aTrack), local = voice("b-stream", bTrack);
  try {
    pc.connected(); pc.channels[0].open();
    state.publications = [
      { id: "voice-a", roomId: "first", sessionId: "z", userId: "other", kind: "voice", muted: false },
      { id: "voice-b", roomId: "first", sessionId: "a", userId: "self", kind: "voice", muted: false },
    ];
    state.pairs[0].incoming = [{ id: "voice-a-in", publicationId: "voice-a", selected: true, inputFlowId: null }];
    state.pairs[0].outgoing = [{ id: "voice-b-out", publicationId: "voice-b", selected: true, inputFlowId: null }];
    state.pairs.push({ id: "downstream", peerId: "y", rooms: ["first"], incoming: [], outgoing: [{ id: "voice-a-out", publicationId: "voice-a", selected: true, inputFlowId: "voice-a-in" }] });
    media.setLocal("voice-b", local);
    media.update("a", state);
    const downstream = RoomPeerConnection.instances[1];
    downstream.connected(); downstream.channels[0].open();
    media.signal("pair", { exchangeId: "incoming-exchange", description: { type: "offer", sdp: "fixture" }, tracks: [{ flowId: "voice-a-in", streamId: incoming.id }] });
    await vi.waitFor(() => expect(pc.remoteDescription?.type).toBe("offer"));
    pc.ontrack?.({ streams: [incoming] });
    expect(state.subscriptions).toEqual([]);
    expect(pc.senders.map(sender => sender.track)).toEqual([bTrack]);
    expect(downstream.senders.map(sender => sender.track)).toEqual([aTrack]);
    expect(RoomAudio.instances).toHaveLength(1);
    const consumer = RoomAudio.instances[0];
    expect(consumer.muted && consumer.hidden && consumer.autoplay).toBe(true);
    expect(consumer.srcObject?.getTracks()).toEqual([aTrack]);
    expect(consumer.play).toHaveBeenCalledOnce();
    state.pairs.push({ id: "another-child", peerId: "x", rooms: ["first"], incoming: [], outgoing: [{ id: "voice-a-another-out", publicationId: "voice-a", selected: true, inputFlowId: "voice-a-in" }] });
    media.update("a", state);
    expect(RoomAudio.instances).toHaveLength(1);
    state.pairs[1].outgoing = [];
    media.update("a", state);
    expect(downstream.senders).toEqual([]);
    expect(consumer.pause).not.toHaveBeenCalled();
    state.pairs[2].outgoing = [];
    media.update("a", state);
    expect(consumer.pause).toHaveBeenCalledOnce();
    expect(consumer.srcObject).toBeNull();
    expect(consumer.remove).toHaveBeenCalledOnce();
    expect(aTrack.stop).not.toHaveBeenCalled();
    expect(pc.close).not.toHaveBeenCalled();
    expect(downstream.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});


test("browse waits for the current room path and reconnect cancels unsent history before refreshing", async () => {
  const { session, socket, peer } = await setup(1000, false);
  try {
    const first = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    session.browse("first");
    expect(socket.sent.filter(command => command.type === "browse" && command.active)).toHaveLength(1);
    expect(peer.sent).toEqual([]);
    session.browse("second");
    const second = socket.sent.at(-1)!;
    const state = structuredClone(session.getSnapshot().state!);
    const delivery = state.channel.rooms[1].delivery!;
    delivery.nextHops = {};
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: first.requestId }); await Promise.resolve();
    expect(peer.sent).toEqual([]);
    socket.receive({ type: "room_reply", roomId: "second", requestId: second.requestId, result: { type: "done" } });
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:second")).toBe(true));
    expect(peer.sent).toEqual([]);
    expect(session.getSnapshot().error).toBeNull();
    delivery.nextHops = { host: "host" };
    socket.receive({ type: "state", state });
    const history = await peer.next();
    expect(history).toMatchObject({ type: "history", roomId: "second" });
    session.browse("second");
    socket.receive({ type: "state", state });
    expect(peer.sent).toHaveLength(1);
    expect(socket.sent.some(command => command.type === "history")).toBe(false);
    peer.page(history, [message(5)], true);
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:second")).toBe(false));
    const older = session.loadHistory("second");
    const previous = await peer.next();
    expect(previous).toMatchObject({ type: "history", roomId: "second", before: 5 });
    peer.page(previous, [], false); await older;
    delivery.nextHops = {};
    socket.receive({ type: "state", state });
    const canceled = expect(session.loadLatestHistory("second")).rejects.toThrow("disconnected");
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:second")).toBe(true));
    expect(peer.sent).toHaveLength(2);
    session.reconnect();
    await canceled;
    delivery.nextHops = { host: "host" };
    const resumed = ChannelSocket.current; await resumed.onopen?.();
    resumed.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state });
    expect(peer.sent).toHaveLength(2);
    const browse = resumed.sent.findLast(command => command.type === "browse" && command.active)!;
    resumed.receive({ type: "ack", requestId: browse.requestId });
    expect(await peer.next()).toMatchObject({ type: "history", roomId: "second" });
    expect(peer.sent).toHaveLength(3);
    expect(resumed.sent.some(command => command.type === "history")).toBe(false);
  } finally { session.close(); }
});
