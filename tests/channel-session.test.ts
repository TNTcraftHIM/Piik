import { en } from "../src/client/locales/en";
import { zh } from "../src/client/locales/zh";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/conversation";
import { ChannelSession } from "../src/client/channel/session";
import { FeedbackAudio } from "../src/client/channel/feedback-audio";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import * as hosting from "../src/client/channel/hosting";
import { listeningVoicePublications } from "../src/client/channel/presentation";
import * as backupArchive from "../src/client/channel/backup-archive";
import * as appLink from "../src/client/channel/app-link";
import * as nativeActivation from "../src/client/native/activation";
import * as launchSession from "../src/client/lib/app-launch";
import * as cameraPreviews from "../src/client/media/camera-previews";
import { ChannelMedia } from "../src/client/channel/media";
import { MicrophoneInput } from "../src/client/media/microphone-input";
import { ChannelTransport } from "../src/client/channel/transport";
import { QUALITY_PROFILES, screenVideoSettings, type VideoSettings } from "../src/client/media/quality";
import { ChannelAttachments } from "../src/client/channel/attachments";
import { FileStore } from "../src/client/channel/file-store";
import { CHANNEL_PROTOCOL, identityIconSchema, messageSchema, publicationSchema, snapshotSchema, signalSchema, type ChannelCommand, type ChannelMessage, type ChannelSignal, type ConversationReply, type ScreenSource } from "../src/client/channel/protocol";
import type { ChannelScreenInput } from "../src/client/channel/types";
import { ChannelInput } from "../src/client/channel/input";
import { RemoteInputSession } from "../src/client/remote-control/input-session";
import * as codecPreflight from "../src/client/webrtc/video-codec-preflight";
import * as videoCodec from "../src/client/webrtc/video-codec";
import type { InputTransport } from "../src/client/remote-control/input-route";
import { BrowserEncodingPool, type BrowserPooledSender } from "../src/client/media/browser-encoding-pool";
import * as encodingOutput from "../src/client/media/browser-encoding-output";

class ChannelSocket {
  static OPEN = 1;
  static current: ChannelSocket;
  readyState = ChannelSocket.OPEN;
  onopen: (() => void | Promise<void>) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  profiles = new Map<string, import("../src/client/channel/protocol").ChannelUser>();
  autoProfiles = true;
  constructor(_url: URL) { ChannelSocket.current = this; }
  send(data: string): void {
    const command = JSON.parse(data); this.sent.push(command);
    if (command.type === "profiles" && this.autoProfiles) queueMicrotask(() => this.receive({ type: "profiles", requestId: command.requestId,
      profiles: (command.ids as string[] ?? []).flatMap(id => this.profiles.get(id) ?? []), total: (command.ids as string[] ?? []).filter(id => this.profiles.has(id)).length, nextCursor: null }));
  }
  close(): void { this.readyState = 3; this.onclose?.(); }
  receive(event: object): void {
    const frame = event as { type: string; state?: import("../src/client/channel/protocol").ChannelSnapshot; selfProfile?: import("../src/client/channel/protocol").ChannelUser; sessionId?: string };
    if ((frame.type === "welcome" || frame.type === "state") && frame.state) {
      for (const user of frame.state.users) this.profiles.set(user.id, { avatar: null, ...this.profiles.get(user.id), ...user });
      if (frame.type === "welcome" && !frame.selfProfile) {
        const id = frame.state.sessions.find(session => session.id === frame.sessionId)?.userId;
        frame.selfProfile = this.profiles.get(id ?? "");
      }
    }
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const profileVersion = "0".repeat(64);
const testSigningKey = Array.from(Buffer.from("8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c", "hex"));
beforeEach(() => {
  const browserHistory = { state: null as unknown, replaceState: vi.fn((state: unknown, _title: string, url?: string | URL | null) => {
    browserHistory.state = state;
    if (url != null) location.href = new URL(url, location.href).href;
  }) };
  vi.stubGlobal("history", browserHistory);
  vi.spyOn(launchSession, "isClientActivated").mockReturnValue(false);
  vi.spyOn(ChannelConversation.prototype, "initialize").mockResolvedValue(testSigningKey);
  vi.stubGlobal("MediaStream", RoomMediaStream);
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8", clockRate: 90000 }] }) });
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: [{ mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "packetization-mode=1" }] }) });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(window = 1000, read = true, hash = "room=first", readyInteractions = true, roomIds = ["first", "second"], storage: "saved" | "throws" | "ignores-write" = "saved") {
  vi.stubGlobal("location", new URL(`https://channel.test/__channel-preview${hash ? `#${hash}` : ""}`));
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {
    if (storage === "throws") throw new Error("storage unavailable");
    if (storage === "saved") values.set(key, value);
  } });
  vi.stubGlobal("WebSocket", ChannelSocket);
  const session = new ChannelSession();
  type PeerRequest = Extract<ChannelCommand, { type: "chat" | "history" }> & { requestId: string };
  type InteractionRequest = Extract<ChannelCommand, { type: "interaction_ready" | "react" }> & { requestId: string };
  const sent: PeerRequest[] = [], pending: PeerRequest[] = [];
  const interactions: InteractionRequest[] = [];
  vi.spyOn(ChannelConversation.prototype, "send").mockImplementation(async (command, requestId) => {
    if (command.type === "interaction_ready" || command.type === "react") {
      const request = { ...command, requestId };
      interactions.push(request);
      if (readyInteractions && command.type === "interaction_ready") queueMicrotask(() => peer.reply(request,
        { type: "interaction_ready", serverTime: Date.now(), reactionIds: ["wave", "heart", "future-decoration"], publicationReactions: [] }));
      return;
    }
    const request = { ...command, requestId };
    sent.push(request); pending.push(request);
  });
  const deliver = (reply: ConversationReply) => (session as unknown as { receiveConversation(value: ConversationReply): void }).receiveConversation(reply);
  const peer = {
    sent, interactions,
    async next() { await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0)); return pending.shift()!; },
    reply(request: PeerRequest | InteractionRequest, record: ConversationReply["record"], bindingId = "binding") {
      const reply = { roomId: request.roomId, bindingId, sender: "host", recipient: "endpoint", requestId: request.requestId };
      deliver({ ...reply, record: "message" in record ? { ...record, message: messageSchema.parse(record.message) } : record });
      if (record.type === "confirmed") deliver({ ...reply, record: { type: "message_reactions", snapshot: {
        messageId: record.message.id, messageSeq: record.message.seq, ...(record.message.reactions ?? { revision: 0, counts: {} }),
      } } });
    },
    page(request: PeerRequest, messages: ChannelMessage[], hasMore = false, oldestSeq: number | null = 1, bindingId = "binding") {
      for (const message of messages) {
        peer.reply(request, { type: "history_message", message }, bindingId);
        peer.reply(request, { type: "message_reactions", snapshot: {
          messageId: message.id, messageSeq: message.seq, ...(message.reactions ?? { revision: 0, counts: {} }),
        } }, bindingId);
      }
      peer.reply(request, { type: "history_end", count: messages.length, hasMore, oldestSeq, before: "before" in request ? request.before ?? null : null }, bindingId);
    },
    live(message: ChannelMessage, roomId = "first", bindingId = "binding") {
      deliver({ roomId, bindingId, sender: "host", recipient: "endpoint", requestId: "live", record: { type: "live_message", message: messageSchema.parse(message) } });
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
  socket.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state: {
    channel: { id: "domain", name: "Friends", icon: "future-domain_7", ownerId: "self", historyWindow: window, userCount: 1,
      rooms: roomIds.map(id => ({ id, name: id, icon: "couch", creatorId: "self", access: "public",
        hidden: false, hasPassword: false, authorized: true, canManage: true,
        participantSessionIds: id === "first" ? ["endpoint"] : [],
        lastMessageSeq: 0, realtimeSessionIds: [],
        available: true, reading: id === "first", capabilities: { attachments: true },
        delivery: { hostSessionId: "host", bindingId: "binding", nextHops: { host: "host" } } })) },
    users: [{ id: "self", name: "Me", version: profileVersion }], sessions: [{ id: "endpoint", userId: "self", online: true, signingKey: testSigningKey }],
    publications: [], voice: [], subscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
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

async function ackSourceUpdate(socket: ChannelSocket): Promise<void> {
  await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
  socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
}

const message = (seq: number) => ({ id: `message-${seq}`, seq, userId: "self", text: `Hello ${seq}`, time: seq, attachments: [],
  reactions: { revision: 0, counts: {} } });
const reactionSnapshot = (seq: number, revision: number, counts: Record<string, number> = {}) =>
  ({ messageId: `message-${seq}`, messageSeq: seq, revision, counts });

test("profile reads batch and deduplicate missing IDs without deleting retained identities", async () => {
  const { session, socket } = await setup(1000, false); socket.autoProfiles = false;
  const ids = Array.from({ length: 65 }, (_, index) => `offline-${index}`);
  try {
    const pending = session.loadProfiles([...ids, ...ids]);
    expect(socket.sent.filter(command => command.type === "profiles")).toHaveLength(1);
    const shared = session.loadProfiles(ids);
    expect(socket.sent.filter(command => command.type === "profiles")).toHaveLength(1);
    for (let index = 0; index < 3; index++) {
      await vi.waitFor(() => expect(socket.sent.filter(command => command.type === "profiles")).toHaveLength(index + 1));
      const request = socket.sent.filter(command => command.type === "profiles")[index];
      const profiles = (request.ids as string[]).filter(id => id !== "offline-64").map(id => ({ id, name: id, avatar: null, version: profileVersion }));
      socket.receive({ type: "profiles", requestId: request.requestId, profiles, total: profiles.length, nextCursor: null });
    }
    expect(await pending).toHaveLength(64); expect(await shared).toHaveLength(64);
    expect(socket.sent.filter(command => command.type === "profiles").map(request => (request.ids as string[]).length)).toEqual([32, 32, 1]);
    expect(await session.loadProfiles(ids)).toHaveLength(64);
    expect(socket.sent.filter(command => command.type === "profiles")).toHaveLength(3);
    expect(session.getSnapshot().profiles.get("offline-0")?.name).toBe("offline-0");
    expect(session.getSnapshot().state!.users).toHaveLength(1);
  } finally { session.close(); }
});

test("large offline profile demands keep only one bounded batch in flight", async () => {
  const { session, socket } = await setup(1000, false); socket.autoProfiles = false;
  let current = 0, maximum = 0;
  const send = socket.send.bind(socket);
  vi.spyOn(socket, "send").mockImplementation(data => {
    const request = JSON.parse(data); send(data);
    if (request.type !== "profiles") return;
    current++; maximum = Math.max(maximum, current);
    queueMicrotask(() => {
      current--;
      const profiles = request.ids.map((id: string) => ({ id, name: id, avatar: null, version: profileVersion }));
      socket.receive({ type: "profiles", requestId: request.requestId, profiles, total: profiles.length, nextCursor: null });
    });
  });
  try {
    const ids = Array.from({ length: 2112 }, (_, index) => `history-user-${index}`);
    expect(await session.loadProfiles(ids)).toHaveLength(ids.length);
    expect(socket.sent.filter(command => command.type === "profiles")).toHaveLength(66);
    expect(maximum).toBe(1);
  } finally { session.close(); }
});

test("profile versions refresh names and clear avatars while a new Welcome resets display facts", async () => {
  const { session, socket } = await setup(1000, false); socket.autoProfiles = false;
  const picture = "data:image/png;base64,YWJj";
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.users.push({ id: "friend", name: "Before", version: profileVersion }); state.channel.userCount++;
    socket.receive({ type: "state", state });
    socket.receive({ type: "profiles", requestId: socket.sent.at(-1)!.requestId, profiles: [{ ...state.users[1], avatar: picture }], total: 1, nextCursor: null });
    expect(session.getSnapshot().profiles.get("friend")?.avatar).toBe(picture);
    const next = structuredClone(state); next.users[1] = { id: "friend", name: "After", version: "1".repeat(64) };
    socket.receive({ type: "state", state: next });
    socket.receive({ type: "profiles", requestId: socket.sent.at(-1)!.requestId, profiles: [{ ...next.users[1], avatar: null }], total: 1, nextCursor: null });
    expect(session.getSnapshot().profiles.get("friend")).toEqual({ ...next.users[1], avatar: null });
    const resumed = structuredClone(next); resumed.users = [resumed.users[0]];
    socket.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state: resumed });
    expect(session.getSnapshot().self).toEqual({ ...resumed.users[0], avatar: null });
    expect(session.getSnapshot().profiles.has("friend")).toBe(false);
    const reload = session.loadProfiles(["friend"]);
    socket.receive({ type: "profiles", requestId: socket.sent.at(-1)!.requestId, profiles: [{ ...next.users[1], avatar: null }], total: 1, nextCursor: null });
    expect(await reload).toEqual([{ ...next.users[1], avatar: null }]);
  } finally { session.close(); }
});

test("profile directory abort ignores its late full-avatar reply and uses the content read deadline", async () => {
  const { session, socket } = await setup(1000, false); socket.autoProfiles = false; vi.useFakeTimers();
  try {
    const abort = new AbortController(), reading = session.queryProfiles({ query: "offline" }, abort.signal);
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" }), request = socket.sent.at(-1)!;
    abort.abort(); await rejected;
    socket.receive({ type: "profiles", requestId: request.requestId, profiles: [{ id: "late", name: "Late", avatar: null, version: profileVersion }], total: 1, nextCursor: null });
    expect(session.getSnapshot().profiles.has("late")).toBe(false);
    const slower = session.queryProfiles({}), failed = expect(slower).rejects.toThrow("request_timeout");
    await vi.advanceTimersByTimeAsync(10000); expect(session.getSnapshot().connection).toBe("connected");
    expect((session as unknown as { requests: Map<string, unknown> }).requests.has(socket.sent.at(-1)!.requestId as string)).toBe(true);
    await vi.advanceTimersByTimeAsync(20000); await failed;
  } finally { session.close(); }
});

test("accepted history resolves offline author, reply and mention IDs through the profile reader", async () => {
  const { session, socket, peer } = await setup(); socket.autoProfiles = false;
  try {
    await peer.history([{ ...message(2), userId: "offline-author", text: "@Mention", mentions: [{ userId: "offline-mention", start: 0, end: 8 }],
      reply: { seq: 1, userId: "offline-reply", text: "Earlier", notify: true } }]);
    expect(socket.sent.filter(command => command.type === "profiles").flatMap(command => command.ids as string[]).sort())
      .toEqual(["offline-author", "offline-mention", "offline-reply"]);
  } finally { session.close(); }
});

test("confirmed room events own personal feedback across text, attachments and throw targets", async () => {
  const document = Object.assign(new EventTarget(), { hidden: true });
  vi.stubGlobal("document", document);
  const play = vi.spyOn(FeedbackAudio.prototype, "play").mockImplementation(() => {});
  const configure = vi.spyOn(FeedbackAudio.prototype, "configure").mockImplementation(() => {});
  const close = vi.spyOn(FeedbackAudio.prototype, "close");
  const { session, socket, peer } = await setup();
  const fresh = (seq: number, userId = "friend-user-1234") => ({ ...message(seq), userId, time: Date.now() });
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.users[0].id = "self-user-1234";
    state.sessions[0].userId = "self-user-1234";
    state.channel.ownerId = "self-user-1234";
    state.channel.rooms.forEach(room => { room.creatorId = "self-user-1234"; });
    state.users.push({ id: "friend-user-1234", name: "Friend", version: profileVersion }, { id: "bystander", name: "Other", version: profileVersion });
    state.sessions.push({ id: "native-endpoint", userId: "self-user-1234", online: true, signingKey: testSigningKey });
    state.publications.push({ id: "own-screen", roomId: "first", sessionId: "native-endpoint", userId: "self-user-1234", kind: "screen",
      paused: false, audience: [], source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]) });
    socket.receive({ type: "state", state });
    await vi.waitFor(() => expect(session.getSnapshot().self?.id).toBe("self-user-1234"));
    await vi.waitFor(() => expect(session.getSnapshot().interactionsByRoom.get("first")?.getSnapshot().ready).toBe(true));
    expect(session.getSnapshot().feedbackSound.enabled).toBe(false);
    peer.live(fresh(1));
    expect(play).not.toHaveBeenCalled();
    session.setFeedbackSound({ enabled: true, volume: .4 });
    expect(configure).toHaveBeenLastCalledWith({ enabled: true, volume: .4 });
    peer.live(fresh(1)); // Enabling does not replay already received events.
    peer.live(fresh(2));
    peer.live({ ...fresh(3), text: "", attachments: [{ id: "attachment", name: "notes.txt", mediaType: "application/octet-stream",
      size: 14, sha256: "0".repeat(64) }] });
    peer.live(fresh(2));
    peer.live(fresh(4, "self-user-1234"));
    peer.live({ ...fresh(5), time: Date.now() - 7000 });
    await peer.history([fresh(90, "self-user-1234"), fresh(91)]);
    expect(session.getSnapshot().messagesByRoom.first.find(message => message.seq === 90)?.userId).toBe("self-user-1234");
    expect(play.mock.calls.map(([cue]) => cue)).toEqual(["message", "message"]);
    document.hidden = false;
    peer.live(fresh(92));
    const reaction = (id: string, senderUserId: string, target: import("../src/client/channel/protocol").ReactionTarget, reaction = "tomato") => {
      peer.reply(peer.interactions[0], { type: "reaction", nonce: 1, snapshot: null,
        event: { id, senderUserId, target, reaction, occurredAt: Date.now() } });
    };
    reaction("self-person", "self-user-1234", { type: "person", userId: "friend-user-1234" });
    expect(play.mock.calls.length, "self-person").toBe(3);
    reaction("self-person", "self-user-1234", { type: "person", userId: "friend-user-1234" });
    reaction("to-person", "friend-user-1234", { type: "person", userId: "self-user-1234" });
    expect(play.mock.calls.length, "to-person").toBe(4);
    reaction("to-message", "friend-user-1234", { type: "message", messageSeq: 90 }, "poop");
    expect(play.mock.calls.length, "to-message").toBe(5);
    reaction("to-screen", "friend-user-1234", { type: "publication", publicationId: "own-screen" });
    expect(play.mock.calls.length, "to-screen").toBe(6);
    reaction("self-message", "self-user-1234", { type: "message", messageSeq: 91 });
    expect(play.mock.calls.length, "self-message").toBe(7);
    reaction("self-screen", "self-user-1234", { type: "publication", publicationId: "own-screen" }, "poop");
    expect(play.mock.calls.length, "self-screen").toBe(8);
    expect(play.mock.calls.map(([cue]) => cue)).toEqual(["message", "message", ...Array(6).fill("throw")]);
    reaction("emoji", "friend-user-1234", { type: "person", userId: "self-user-1234" }, "heart");
    reaction("bystander", "friend-user-1234", { type: "person", userId: "bystander" });
    reaction("other-message", "friend-user-1234", { type: "message", messageSeq: 91 });
    reaction("unknown-screen", "friend-user-1234", { type: "publication", publicationId: "other-screen" });
    document.hidden = true;
    reaction("hidden-throw", "friend-user-1234", { type: "person", userId: "self-user-1234" });
    expect(play).toHaveBeenCalledTimes(8);
    session.setFeedbackSound({ enabled: false });
    peer.live(fresh(93));
    expect(play).toHaveBeenCalledTimes(8);
  } finally { session.close(); }
  expect(close).toHaveBeenCalledOnce();
  peer.live(fresh(94));
  expect(play).toHaveBeenCalledTimes(8);
});

test("the site overview does not select a room or load its history", async () => {
  const { session, socket, peer } = await setup(1000, false, "");
  try {
    expect(session.getSnapshot().connection).toBe("connected");
    expect(socket.sent.filter(command => command.type === "browse" && command.active)).toEqual([]);
    expect(peer.sent).toEqual([]);
    session.browse("second");
    expect(socket.sent.filter(command => command.type === "browse" && command.active).map(command => command.roomId)).toEqual(["second"]);
  } finally { session.close(); }
});

test("profile changes use the authenticated identity and only project confirmed state", async () => {
  const { session, socket } = await setup();
  const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
  try {
    const saving = session.updateProfile({ name: "New name", avatar });
    const request = socket.sent.at(-1)!;
    expect(request).toMatchObject({ type: "set_profile", name: "New name", avatar });
    expect(request).not.toHaveProperty("userId");
    expect(session.getSnapshot().self).toMatchObject({ name: "Me", avatar: null });
    const state = structuredClone(session.getSnapshot().state!);
    state.users[0] = { ...state.users[0], name: "New name", version: "1".repeat(64) };
    socket.profiles.set("self", { ...state.users[0], avatar });
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: request.requestId });
    await saving;
    await vi.waitFor(() => expect(session.getSnapshot().self?.avatar).toBe(avatar));
    expect(session.getSnapshot().self).toMatchObject({ name: "New name", avatar });
    const clearing = session.updateProfile({ name: "New name", avatar: null });
    const rejection = expect(clearing).rejects.toThrow("storage_failed");
    socket.receive({ type: "error", requestId: socket.sent.at(-1)!.requestId, code: "storage_failed" });
    await rejection;
    expect(session.getSnapshot().self?.avatar).toBe(avatar);
    expect(session.getSnapshot().error).toBeNull();
  } finally { session.close(); }
});

test("a keyless room fragment supplies navigation without performing admission", async () => {
  const { session, socket } = await setup();
  try {
    const before = socket.sent.length;
    location.hash = "room=second";
    await expect(session.acceptInvitation()).resolves.toBe("second");
    expect(socket.sent).toHaveLength(before);
    expect(session.getSnapshot().pending.size).toBe(0);
    location.hash = "";
    await expect(session.acceptInvitation()).resolves.toBeNull();
  } finally { session.close(); }
});

test("restoring the viewed room does not turn its navigation state into an invitation", async () => {
  history.replaceState({ piikChannelRoom: "second" }, "");
  const { session, socket } = await setup(1000, false, "room=first&invite=room-link");
  try {
    expect(socket.sent.find(command => command.type === "join")).toMatchObject({ protocol: CHANNEL_PROTOCOL });
    expect(socket.sent.filter(command => command.type === "browse" && command.active).map(command => command.roomId)).toEqual(["second"]);
    const entering = socket.sent.find(command => command.type === "enter_room")!;
    expect(entering).toMatchObject({ roomId: "first", inviteKey: "room-link" });
    socket.receive({ type: "ack", requestId: entering.requestId });
    await vi.waitFor(() => expect(history.replaceState).toHaveBeenCalledWith({ piikChannelRoom: "second" }, "", "/__channel-preview#room=first"));
    expect(location.hash).toBe("#room=first");
  } finally { session.close(); }
});

test("a saved owner credential retires only the consumed owner URL parameter and owns reconnect and reload", async () => {
  const { session, socket } = await setup(3, false, "owner=owner-secret&room=first&invite=friend-link&other=keep", true, undefined, "ignores-write");
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } });
  const previousHistory = { scroll: "kept" };
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => { location.href = new URL(url, location.href).href; });
  vi.stubGlobal("history", { state: previousHistory, replaceState });
  location.search = "?theme=dark";
  let reloaded: ChannelSession | undefined;
  try {
    const state = session.getSnapshot().state!;
    socket.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "personal-owner-credential", sessionId: "endpoint", state });
    expect(replaceState).toHaveBeenCalledWith(previousHistory, "", "/__channel-preview?theme=dark#room=first&invite=friend-link&other=keep");
    await vi.waitFor(() => expect(session.getSnapshot().siteURL).toBe("https://channel.test/__channel-preview"));
    expect(values.get("piik.channel.prototype.credential")).toBe("personal-owner-credential");
    vi.useFakeTimers();
    socket.close(); await vi.advanceTimersByTimeAsync(1000);
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    expect(resumed.sent.find(command => command.type === "join")).toMatchObject({ credential: "personal-owner-credential" });
    expect(resumed.sent.find(command => command.type === "join")).not.toHaveProperty("ownerKey");
    session.close();
    reloaded = new ChannelSession(); reloaded.start(); await ChannelSocket.current.onopen?.();
    const join = ChannelSocket.current.sent.find(command => command.type === "join")!;
    expect(join).toMatchObject({ credential: "personal-owner-credential" });
    expect(JSON.stringify(join)).not.toContain("owner-secret");
  } finally { session.close(); reloaded?.close(); }
});

test.each(["throws", "ignores-write"] as const)("owner bootstrap stays recoverable when Browser storage %s", async failure => {
  const { session, socket } = await setup(3, false, "owner=owner-secret&other=keep", true, undefined, failure);
  const replaceState = vi.fn(); vi.stubGlobal("history", { state: null, replaceState });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { if (failure === "throws") throw new Error("storage unavailable"); } });
  try {
    socket.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "personal-owner-credential", sessionId: "endpoint", state: session.getSnapshot().state! });
    expect(replaceState).not.toHaveBeenCalled();
    expect(location.hash).toBe("#owner=owner-secret&other=keep");
    expect(session.getSnapshot().connection).toBe("connected");
    vi.useFakeTimers(); socket.close(); await vi.advanceTimersByTimeAsync(1000); await ChannelSocket.current.onopen?.();
    expect(ChannelSocket.current.sent.find(command => command.type === "join")).toMatchObject({ ownerKey: "owner-secret", credential: "personal-owner-credential" });
  } finally { session.close(); }
});

test.each(["invalid_room_id", "room_not_found", "room_unavailable"])("%s presents an unavailable room instead of a password failure", error => {
  expect(channelErrorPresentation(error, key => en[key]).message).toBe("The room does not exist or is no longer available.");
});

test("opening the site creates identity before independently applying a room invitation", async () => {
  const { session, socket } = await setup(1000, false, "room=first&invite=room-key");
  let reloaded: ChannelSession | undefined;
  try {
    const join = socket.sent.find(command => command.type === "join")!;
    expect(join).toMatchObject({ type: "join", protocol: CHANNEL_PROTOCOL, name: "Guest" });
    for (const field of ["key", "password", "roomId"]) expect(join).not.toHaveProperty(field);
    const entry = socket.sent.find(command => command.type === "enter_room")!;
    expect(entry).toMatchObject({ roomId: "first", inviteKey: "room-key" });
    socket.receive({ type: "error", requestId: entry.requestId, code: "room_access_required" });
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("enter:first")).toBe(false));
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", sessionId: "endpoint", error: "room_access_required" });
    location.hash = "room=second&invite=good-key";
    const entering = session.acceptInvitation();
    const next = socket.sent.findLast(command => command.type === "enter_room")!;
    socket.receive({ type: "ack", requestId: next.requestId });
    await expect(entering).resolves.toBe("second");
    expect(session.getSnapshot().connection).toBe("connected");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/__channel-preview#room=second");
    expect(location.hash).toBe("#room=second");
    expect(socket.sent.filter(command => command.type === "join")).toHaveLength(1);
    const state = session.getSnapshot().state!;
    session.close();
    reloaded = new ChannelSession(); reloaded.start();
    const nextSocket = ChannelSocket.current;
    await nextSocket.onopen?.();
    expect(nextSocket.sent.find(command => command.type === "join")).toMatchObject({ credential: "credential" });
    nextSocket.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    expect(nextSocket.sent.some(command => command.type === "enter_room")).toBe(false);
    expect(nextSocket.sent.find(command => command.type === "browse" && command.active)).toMatchObject({ roomId: "second" });
  } finally { session.close(); reloaded?.close(); }
});

test.each(["throws", "ignores-write"] as const)("room invitation survives reload when identity storage %s", async failure => {
  const { session, socket } = await setup(1000, false, "room=first&invite=room-key", true, undefined, failure);
  let reloaded: ChannelSession | undefined;
  try {
    const entry = socket.sent.find(command => command.type === "enter_room")!;
    socket.receive({ type: "ack", requestId: entry.requestId });
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("enter:first")).toBe(false));
    expect(location.hash).toBe("#room=first&invite=room-key");
    expect(history.replaceState).not.toHaveBeenCalled();
    const state = session.getSnapshot().state!;
    session.close();
    reloaded = new ChannelSession(); reloaded.start();
    const nextSocket = ChannelSocket.current;
    await nextSocket.onopen?.();
    expect(nextSocket.sent.find(command => command.type === "join")).not.toHaveProperty("credential");
    nextSocket.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "new-credential", sessionId: "endpoint", state });
    expect(nextSocket.sent.find(command => command.type === "enter_room")).toMatchObject({ roomId: "first", inviteKey: "room-key" });
  } finally { session.close(); reloaded?.close(); }
});

test("late room admission preserves a newer invitation fragment", async () => {
  const { session, socket } = await setup(1000, false, "");
  try {
    location.hash = "room=first&invite=first-key";
    const entering = session.acceptInvitation();
    const entry = socket.sent.find(command => command.type === "enter_room")!;
    location.hash = "room=second&invite=second-key";
    socket.receive({ type: "ack", requestId: entry.requestId });
    await entering;
    expect(location.hash).toBe("#room=second&invite=second-key");
    expect(history.replaceState).not.toHaveBeenCalled();
  } finally { session.close(); }
});

test("room admission succeeds when History rejects invitation cleanup", async () => {
  const { session, socket } = await setup(1000, false, "");
  vi.mocked(history.replaceState).mockImplementation(() => { throw new DOMException("History unavailable", "SecurityError"); });
  try {
    location.hash = "room=first&invite=room-key";
    const entering = session.acceptInvitation();
    const entry = socket.sent.find(command => command.type === "enter_room")!;
    socket.receive({ type: "ack", requestId: entry.requestId });
    await expect(entering).resolves.toBe("first");
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", error: null });
    expect(location.hash).toBe("#room=first&invite=room-key");
  } finally { session.close(); }
});

test("a browser without WebAssembly reports its capability failure before joining", async () => {
  vi.mocked(ChannelConversation.prototype.initialize).mockRestore();
  vi.stubGlobal("WebAssembly", undefined);
  vi.stubGlobal("location", new URL("https://channel.test/__channel-preview"));
  vi.stubGlobal("WebSocket", ChannelSocket);
  const session = new ChannelSession();
  try {
    session.start();
    const socket = ChannelSocket.current;
    await socket.onopen?.();
    expect(session.getSnapshot()).toMatchObject({ connection: "closed", error: "webassembly_unavailable" });
    expect(socket.sent.some(command => command.type === "join")).toBe(false);
    expect(socket.readyState).toBe(3);
  } finally { session.close(); }
});

test("rejected saved identity stops recovery and preserves credentials for an explicit retry", async () => {
  const { session, socket } = await setup(1000, false, "");
  try {
    vi.useFakeTimers();
    socket.close(); await vi.advanceTimersByTimeAsync(1000);
    const retry = ChannelSocket.current; await retry.onopen?.();
    expect(retry.sent.find(command => command.type === "join")).toMatchObject({ credential: "credential" });
    retry.receive({ type: "error", code: "invalid_credential" });
    expect(session.getSnapshot()).toMatchObject({ connection: "closed", sessionId: null, state: null, error: "invalid_credential" });
    expect(localStorage.getItem("piik.channel.prototype.credential")).toBe("credential");
    await vi.advanceTimersByTimeAsync(30000);
    expect(ChannelSocket.current).toBe(retry);
    expect(session.getSnapshot().error).toBe("invalid_credential");
    session.reconnect(); await ChannelSocket.current.onopen?.();
    expect(ChannelSocket.current.sent.find(command => command.type === "join")).toMatchObject({ credential: "credential" });
  } finally { session.close(); }
});

test.each(["rejection", "disconnect"])("new identity %s retains the saved identity until a later successful Welcome", async failure => {
  const { session, socket } = await setup(1000, false, "");
  const state = structuredClone(session.getSnapshot().state!);
  try {
    socket.receive({ type: "error", code: "invalid_credential" });
    session.joinAsNewIdentity();
    const joining = ChannelSocket.current; await joining.onopen?.();
    const join = joining.sent.find(command => command.type === "join")!;
    for (const field of ["credential", "ownerKey", "sessionId"]) expect(join).not.toHaveProperty(field);
    expect(localStorage.getItem("piik.channel.prototype.credential")).toBe("credential");
    vi.useFakeTimers();
    if (failure === "rejection") joining.receive({ type: "error", code: "channel_full" });
    else {
      joining.close();
      await vi.advanceTimersByTimeAsync(1000);
      const retry = ChannelSocket.current; await retry.onopen?.();
      expect(retry.sent.find(command => command.type === "join")).toMatchObject({ credential: "credential" });
      retry.receive({ type: "error", code: "invalid_credential" });
    }
    const rejected = ChannelSocket.current;
    await vi.advanceTimersByTimeAsync(30000);
    expect(ChannelSocket.current).toBe(rejected);
    expect(session.getSnapshot().connection).toBe("closed");
    expect(localStorage.getItem("piik.channel.prototype.credential")).toBe("credential");
    session.reconnect(); await ChannelSocket.current.onopen?.();
    expect(ChannelSocket.current.sent.find(command => command.type === "join")).toMatchObject({ credential: "credential" });
    ChannelSocket.current.receive({ type: "error", code: "invalid_credential" });
    session.joinAsNewIdentity(); await ChannelSocket.current.onopen?.();
    state.users = [{ id: "new-user", name: "New user", version: profileVersion }];
    state.sessions = [{ id: "new-session", userId: "new-user", online: true, signingKey: testSigningKey }];
    state.channel.rooms = [];
    ChannelSocket.current.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "new-credential", sessionId: "new-session", state });
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", self: { id: "new-user" } });
    expect(localStorage.getItem("piik.channel.prototype.credential")).toBe("new-credential");
  } finally { session.close(); }
});

test("message reaction clicks count independently while nonce retries settle without another live effect", async () => {
  vi.useFakeTimers();
  const { session, peer } = await setup();
  try {
    await peer.history([message(1)]);
    const interaction = session.getSnapshot().interactionsByRoom.get("first")!;
    expect(interaction.send({ kind: "reaction", reaction: "heart" }, { messageSeq: 1 })).toBe(true);
    const first = peer.interactions.at(-1)!;
    expect(first).toMatchObject({ type: "react", roomId: "first", reaction: "heart", target: { type: "message", messageSeq: 1 }, nonce: 1 });
    expect(first).not.toHaveProperty("userId");
    expect(session.getSnapshot().messagesByRoom.first[0].reactions).toEqual({ revision: 0, counts: {} });
    const event = { id: "click-1", occurredAt: Date.now(), senderUserId: "self", reaction: "heart", target: { type: "message" as const, messageSeq: 1 } };
    const snapshot = { type: "message" as const, ...reactionSnapshot(1, 1, { heart: 1 }) };
    peer.reply(first, { type: "reaction", nonce: 1, event, snapshot });
    peer.reply(first, { type: "reaction", nonce: 1, event, snapshot });
    expect(interaction.getSnapshot().reactions).toHaveLength(1);
    expect(session.getSnapshot().messagesByRoom.first[0].reactions).toEqual({ revision: 1, counts: { heart: 1 } });
    vi.advanceTimersByTime(800);
    expect(interaction.send({ kind: "reaction", reaction: "heart" }, { messageSeq: 1 })).toBe(true);
    const second = peer.interactions.at(-1)!;
    expect(second).toMatchObject({ nonce: 2, target: { type: "message", messageSeq: 1 } });
    peer.reply(second, { type: "reaction", nonce: 2, event: { ...event, id: "click-2" },
      snapshot: { ...snapshot, revision: 2, counts: { heart: 2 } } });
    expect(interaction.getSnapshot().reactions).toHaveLength(2);
    expect(session.getSnapshot().messagesByRoom.first[0].reactions).toEqual({ revision: 2, counts: { heart: 2 } });
    vi.advanceTimersByTime(800);
    expect(interaction.send({ kind: "reaction", reaction: "heart" }, { messageSeq: 1 })).toBe(true);
    const unconfirmed = peer.interactions.at(-1)!;
    vi.advanceTimersByTime(5000);
    expect(interaction.getSnapshot().error).toBe("unconfirmed");
    expect(interaction.send({ kind: "reaction", reaction: "heart" }, { messageSeq: 1 })).toBe(true);
    const retry = peer.interactions.at(-1)!;
    expect(retry).toEqual(unconfirmed);
    expect(retry).toMatchObject({ nonce: 3 });
    peer.reply(retry, { type: "reaction", nonce: 3, event: null, snapshot: null });
    expect(interaction.getSnapshot()).toMatchObject({ pending: null, error: null, reactions: [] });
    // The host's current count is a projection, never inferred from a retry ACK.
    peer.reply(retry, { type: "message_reactions", snapshot: reactionSnapshot(1, 2, { heart: 2 }) });
    expect(session.getSnapshot().messagesByRoom.first[0].reactions).toEqual({ revision: 2, counts: { heart: 2 } });
    const sending = session.sendMessage("first", message(1).text), chat = await peer.next();
    peer.reply(chat, { type: "confirmed", message: message(1), inserted: false });
    await sending;
    expect(session.getSnapshot().messagesByRoom.first[0].reactions?.revision).toBe(2);
  } finally { session.close(); }
});

test("history assembles early live reaction snapshots and preserves the newer projection in a historical window", async () => {
  const { session, peer } = await setup(2);
  try {
    await peer.history([message(3), message(4)], true);
    const older = session.loadHistory("first"), request = await peer.next();
    peer.reply({ ...request, requestId: "live-reaction" }, { type: "message_reactions", snapshot: reactionSnapshot(1, 3, { heart: 1 }) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(3), message(4)]);
    peer.reply(request, { type: "history_message", message: message(1) });
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(1, 1, { wave: 1 }) });
    peer.reply(request, { type: "history_message", message: message(2) });
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(2, 0) });
    peer.reply(request, { type: "history_end", count: 2, hasMore: false, oldestSeq: 1, before: 3 });
    await older;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([{ ...message(1), reactions: { revision: 3, counts: { heart: 1 } } }, message(2)]);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(false);
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(2, 4, { clap: 1 }) });
    peer.reply(request, { type: "message_reactions", snapshot: reactionSnapshot(5, 2, { wave: 1 }) });
    peer.live(message(5));
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.seq)).toEqual([1, 2]);
    expect(session.getSnapshot().messagesByRoom.first[1].reactions).toEqual({ revision: 4, counts: { clap: 1 } });
    const latest = session.loadLatestHistory("first");
    peer.page(await peer.next(), [message(1), message(2)], false, 1);
    await latest;
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.reactions?.revision)).toEqual([3, 4]);
    const refreshing = session.loadLatestHistory("first"), refresh = await peer.next();
    peer.reply({ ...refresh, requestId: "new-live-reaction" }, { type: "message_reactions", snapshot: reactionSnapshot(3, 5, { wave: 1 }) });
    peer.live(message(3));
    peer.page(refresh, [message(1), message(2)], false, 1);
    await refreshing;
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.seq)).toEqual([2, 3]);
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.reactions?.revision)).toEqual([4, 5]);
    expect(session.getSnapshot().interactionsByRoom.get("first")!.getSnapshot().reactions).toEqual([]);
  } finally { session.close(); }
});

test("room interactions reuse their original acknowledgement and user identity without chat or media permission", async () => {
  vi.useFakeTimers();
  const { session, socket, peer } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.ownerId = "friend-user-1234";
    state.users.push({ id: "friend-user-1234", name: "Friend", version: profileVersion });
    socket.receive({ type: "state", state });
    await vi.waitFor(() => expect(session.getSnapshot().interactionsByRoom.get("first")?.getSnapshot().ready).toBe(true));
    const interaction = session.getSnapshot().interactionsByRoom.get("first")!;
    expect(interaction.getSnapshot()).toMatchObject({ peerId: "self", reactionIds: ["wave", "heart"] });
    expect(interaction.send({ kind: "reaction", reaction: "heart", targetPeerId: "friend-user-1234" })).toBe(true);
    const request = peer.interactions.at(-1)!;
    expect(request).toEqual({ type: "react", roomId: "first", reaction: "heart", target: { type: "person", userId: "friend-user-1234" }, nonce: 1, requestId: interaction.getSnapshot().pending!.requestId });
    expect(session.getSnapshot().pending.size).toBe(0);
    expect(socket.sent.some(command => command.type === "react")).toBe(false);
    peer.reply({ ...request, requestId: "unsupported-decoration" }, { type: "reaction", nonce: 999, snapshot: null, event: { id: "future", occurredAt: Date.now(), senderUserId: "self", reaction: "future-decoration", target: { type: "person", userId: "self" } } });
    expect(interaction.getSnapshot().pending?.requestId).toBe(request.requestId);
    expect(interaction.getSnapshot().reactions).toEqual([]);
    peer.reply(request, { type: "reaction", nonce: 1, snapshot: null, event: { id: "confirmed", occurredAt: Date.now(), senderUserId: "self", reaction: "heart", target: { type: "person", userId: "friend-user-1234" } } });
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
    expect(interaction.getSnapshot().reactions).toEqual([]);
    expect(interaction.getSnapshot()).toMatchObject({ ready: false, pending: null, error: "unconfirmed", reactions: [] });
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
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

test("interaction readiness follows Domain read admission without waiting for a peer path", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const { session, socket, peer } = await setup(1000, false, "room=first", false);
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].delivery!.nextHops = {};
    socket.receive({ type: "state", state });
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    await vi.waitFor(() => expect(peer.interactions).toHaveLength(1));
    const pending = session.getSnapshot().interactionsByRoom.get("first")!;
    expect(pending.getSnapshot().ready).toBe(false);
    expect(RoomPeerConnection.instances).toHaveLength(0);
    state.channel.rooms[0].delivery!.nextHops = { host: "unused-route" };
    socket.receive({ type: "state", state });
    await Promise.resolve();
    expect(peer.interactions).toHaveLength(1);
    const request = peer.interactions[0];
    peer.reply(request, { type: "interaction_ready", serverTime: Date.now(), reactionIds: ["wave", "future-decoration"], publicationReactions: [] });
    expect(pending.getSnapshot()).toMatchObject({ ready: true, reactionIds: ["wave"] });
    state.channel.rooms[0].available = false;
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().interactionsByRoom.size).toBe(0);
    peer.reply(request, { type: "reaction", nonce: 1, snapshot: null, event: { id: "late", occurredAt: Date.now(), senderUserId: "self", reaction: "wave", target: { type: "person", userId: "self" } } });
    expect(pending.getSnapshot()).toMatchObject({ ready: false, reactions: [] });
  } finally { session.close(); }
});

test("content reaction targets and delayed events stay with the current room binding", async () => {
  const { session, socket, peer } = await setup();
  try {
    const first = session.getSnapshot().interactionsByRoom.get("first")!;
    expect(first.send({ kind: "reaction", reaction: "heart" }, { messageSeq: 1 })).toBe(true);
    const old = peer.interactions.at(-1)!;
    const record = { type: "reaction" as const, nonce: 1, snapshot: null, event: {
      id: "old-room-click", occurredAt: Date.now(), senderUserId: "self", reaction: "heart",
      target: { type: "message" as const, messageSeq: 1 },
    } };
    session.browse("second");
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    peer.page(await peer.next(), [], false, null);
    await vi.waitFor(() => expect(session.getSnapshot().interactionsByRoom.get("second")?.getSnapshot().ready).toBe(true));
    const second = session.getSnapshot().interactionsByRoom.get("second")!;
    peer.reply(old, record);
    expect(first.getSnapshot()).toMatchObject({ ready: false, reactions: [] });
    expect(second.getSnapshot().reactions).toEqual([]);
    expect(second.send({ kind: "reaction", reaction: "wave" }, { publicationId: "second-screen" })).toBe(true);
    expect(peer.interactions.at(-1)).toMatchObject({ type: "react", roomId: "second", nonce: 2,
      target: { type: "publication", publicationId: "second-screen" } });
    peer.reply({ ...old, roomId: "second" }, record, "retired-binding");
    expect(second.getSnapshot().reactions).toEqual([]);
  } finally { session.close(); }
});

test.each([false, true])("peer path changes do not reload the Domain conversation or move historical reading (%s)", async historical => {
  const { session, socket, peer } = await setup(2);
  try {
    await peer.history([message(3), message(4)], true);
    if (historical) await peer.history([message(1), message(2)], false, true);
    const before = session.getSnapshot().messagesByRoom.first;
    const sent = peer.sent.length;
    const state = structuredClone(session.getSnapshot().state!);
    for (const nextHops of [{}, { host: "unopened-peer" }] as Array<Record<string, string>>) {
      state.channel.rooms[0].delivery!.nextHops = nextHops;
      socket.receive({ type: "state", state });
      await Promise.resolve(); await Promise.resolve();
      expect(peer.sent).toHaveLength(sent);
      expect(session.getSnapshot().messagesByRoom.first).toEqual(before);
    }
    peer.live(message(5));
    expect(session.getSnapshot().messagesByRoom.first.map(value => value.seq)).toEqual(historical ? [1, 2] : [4, 5]);
  } finally { session.close(); }
});
test("site addresses and room invitations use the current Welcome origin without local bootstrap data", async () => {
  const { session, peer } = await setup();
  const state = session.getSnapshot().state!;
  vi.stubGlobal("location", new URL("https://channel.test/__channel-preview?piik-client-port=39721#owner=local-owner&piik-client=1&piik-client-port=39721"));
  try {
    for (const invitationOrigin of ["https://friends.example", undefined]) {
      session.reconnect();
      const socket = ChannelSocket.current;
      await socket.onopen?.();
      socket.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state,
        ...(invitationOrigin ? { invitationOrigin } : {}) });
      const origin = invitationOrigin ?? "https://channel.test";
      await vi.waitFor(() => expect(session.getSnapshot().siteURL).toBe(`${origin}/__channel-preview`));
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
  const discovery = vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const localRoom = { id: "saved-browser-room", name: "Browser room", icon: "couch", creatorId: "self", access: "public" as const, hidden: false, hasPassword: false };
  const host = {
    roomId: localRoom.id, summary: () => localRoom,
    bind: vi.fn(async (_binding: string) => {}),
    dispatch: vi.fn(async (_input: unknown) => ({})),
    close: vi.fn(async () => {}),
  };
  vi.stubGlobal("indexedDB", {});
  const storedPolicies = vi.fn(async () => [JSON.stringify(localRoom), JSON.stringify({ ...localRoom, id: "removed-from-domain" })]);
  const open = vi.fn(async () => host);
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    createRoomPolicy: async (input: unknown) => JSON.stringify(input),
    BrowserRoomHost: { open, storedPolicies },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const { session, socket } = await setup(1000, true, "room=first", true, ["first", "second", localRoom.id]);
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
    expect(open).toHaveBeenCalledOnce();

    const creating = session.createRoom({ name: "App room", icon: "couch", access: "private", hidden: true, password: "private-room" });
    acceptCreatedRoom(socket);
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
    const metrics = { sessionId: crypto.randomUUID(), bindingId: crypto.randomUUID(), connections: [] };
    const metricsState = structuredClone(session.getSnapshot().state!);
    metricsState.channel.rooms[0].delivery!.bindingId = metrics.bindingId;
    socket.receive({ type: "state", state: metricsState });
    const beforeRead = socket.sent.length;
    const reading = session.appConnectionMetrics("first");
    const query = app.sent.at(-1)!;
    expect(query).toMatchObject({ type: "connection_metrics", roomId: "first" });
    app.receive({ id: query.id, result: metrics });
    await expect(reading).resolves.toEqual(metrics);
    expect(socket.sent).toHaveLength(beforeRead);
    const abort = new AbortController();
    const aborted = session.appConnectionMetrics("first", undefined, abort.signal);
    const abortedReply = app.sent.at(-1)!;
    const rejectedAbort = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    abort.abort(); await rejectedAbort;
    app.receive({ id: abortedReply.id, result: metrics });
    expect(session.getSnapshot().appConnected).toBe(true);
    const late = session.appConnectionMetrics("first"), rejectedLate = expect(late).rejects.toThrow("room_context_changed");
    const lateReply = app.sent.at(-1)!;
    metricsState.channel.rooms[0].authorized = false;
    socket.receive({ type: "state", state: metricsState });
    app.receive({ id: lateReply.id, result: metrics });
    await rejectedLate;
    expect(session.getSnapshot().error).toBeNull();
    socket.receive({ type: "host_bound", roomId: policy.id, bindingId: "native-binding" });
    socket.receive({ type: "host_input", roomId: policy.id, input: { bindingId: "native-binding", revision: 1, endpoints: {}, action: { type: "sync" } } });
    expect(host.dispatch).not.toHaveBeenCalled();

    app.close();
    expect(session.getSnapshot()).toMatchObject({ appConnected: false, error: null });
    expect(host.close).not.toHaveBeenCalled();
    expect(socket.sent.some(command => command.type === "host_stop")).toBe(false);
    const domainCommands = socket.sent.length, identity = session.getSnapshot().sessionId;
    const resuming = session.resumeApp();
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(app));
    const resumedApp = ChannelSocket.current;
    await resumedApp.onopen?.();
    const resumedHello = resumedApp.sent.at(-1)!;
    expect(resumedHello).toMatchObject({ type: "hello", channelId: "domain", userId: "self" });
    resumedApp.receive({ id: resumedHello.id, result: null });
    await resuming;
    expect(session.getSnapshot()).toMatchObject({ appConnected: true, sessionId: identity, connection: "connected" });
    expect(socket.readyState).toBe(ChannelSocket.OPEN);
    expect(socket.sent).toHaveLength(domainCommands);
    expect(resumedApp.sent.map(command => command.type)).toEqual(["hello"]);
    expect(host.close).not.toHaveBeenCalled();
    expect(storedPolicies).toHaveBeenCalledOnce();
    const healthChecks = discovery.mock.calls.length;
    session.close();
    await session.resumeApp();
    expect(discovery).toHaveBeenCalledTimes(healthChecks);
    expect(ChannelSocket.current).toBe(resumedApp);
    await vi.waitFor(() => expect(host.close).toHaveBeenCalledOnce());
    expect(socket.sent.filter(command => command.type === "host_stop")).toEqual([
      { type: "host_stop", roomId: localRoom.id, bindingId: "browser-binding" },
    ]);
    expect(app.sent.map(command => command.type)).toEqual(["hello", "open", "connection_metrics", "connection_metrics", "connection_metrics"]);
  } finally { session.close(); }
});

test("authority delivery results follow this page's watch intent and clear on current recovery", async () => {
  const { session, socket } = await setup();
  const state = { ...session.getSnapshot().state!, publications: [
    { audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
  ], subscriptions: ["screen"], failedSubscriptions: ["screen"] };
  try {
    socket.receive({ type: "state", state });
    const watching = session.watch("screen");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await watching;
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().state).toMatchObject({ subscriptions: ["screen"], failedSubscriptions: ["screen"] });
    socket.receive({ type: "state", state: { ...state, failedSubscriptions: [] } });
    expect(session.getSnapshot().state).toMatchObject({ subscriptions: ["screen"], failedSubscriptions: [] });
    socket.receive({ type: "state", state });
    const stopping = session.unwatch("screen");
    expect(session.getSnapshot().state).toMatchObject({ subscriptions: [], failedSubscriptions: [] });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await stopping;
  } finally { session.close(); }
});

test.each([false, true])("App viewing assistance withdraws without ending the watch (Domain recovery: %s)", async recovering => {
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const helperSessionId = crypto.randomUUID();
  vi.spyOn(appLink.ChannelApp.prototype, "describeHosting").mockResolvedValue({ sessionId: helperSessionId, roomIds: [] });
  const { session, socket } = await setup();
  const state = { ...session.getSnapshot().state!, publications: [
    { audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
  ], subscriptions: ["screen"] };
  socket.receive({ type: "state", state });
  try {
    const watching = session.watch("screen");
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await watching;
    const connecting = session.activateApp();
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const app = ChannelSocket.current;
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await connecting;
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", publicationId: "screen", enabled: true, helperSessionId }));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    if (recovering) socket.close();
    app.close();
    let current = socket;
    if (recovering) {
      session.reconnect();
      current = ChannelSocket.current;
      await current.onopen?.();
      current.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    }
    const ordinary = current.sent.findLast(command => command.type === "subscribe")!;
    expect(ordinary).toMatchObject({ publicationId: "screen", enabled: true });
    expect(ordinary).not.toHaveProperty("helperSessionId");
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    expect(current.sent.some(command => command.type === "subscribe" && command.enabled === false)).toBe(false);
    expect(app.sent.map(command => command.type)).toEqual(["hello"]);
    current.receive({ type: "ack", requestId: ordinary.requestId });
  } finally { session.close(); }
});

test("App rewatch admits its current helper in the first subscription without a second lookup", async () => {
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const helperSessionId = crypto.randomUUID();
  const description = vi.spyOn(appLink.ChannelApp.prototype, "describeHosting").mockResolvedValue({ sessionId: helperSessionId, roomIds: [] });
  const { session, socket } = await setup();
  const state = { ...session.getSnapshot().state!, publications: [
    { audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null,
      videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
  ] };
  socket.receive({ type: "state", state });
  try {
    const connecting = session.activateApp();
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const app = ChannelSocket.current;
    await app.onopen?.(); app.receive({ id: app.sent.at(-1)!.id, result: null }); await connecting;
    for (const round of [1, 2]) {
      const watching = session.watch("screen");
      await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", publicationId: "screen", enabled: true, helperSessionId }));
      socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await watching;
      expect(description).toHaveBeenCalledTimes(round);
      const stopping = session.unwatch("screen");
      socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await stopping;
    }
    const subscriptions = socket.sent.filter(command => command.type === "subscribe");
    expect(subscriptions.map(command => command.enabled)).toEqual([true, false, true, false]);
    expect(subscriptions.filter(command => command.enabled).every(command => command.helperSessionId === helperSessionId)).toBe(true);
  } finally { session.close(); }
});

test.each([false, true])("local Native playback provenance follows endpoint lifetime, without ownership or user inference (description rejected: %s)", async rejected => {
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const native = crypto.randomUUID(), remote = crypto.randomUUID();
  const description = vi.spyOn(appLink.ChannelApp.prototype, "describeHosting").mockResolvedValue({ sessionId: native, roomIds: [] });
  if (rejected) description.mockRejectedValue(new Error("hosting_unavailable"));
  const { session, socket } = await setup();
  const original = session.getSnapshot().state!, userId = session.getSnapshot().self!.id;
  const publications = [native, remote].map((sessionId, index) => ({ audience: [], id: `screen-${index}`, roomId: "first", sessionId, userId,
    kind: "screen" as const, source: { kind: "screen" as const, name: null }, title: null,
    videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }));
  const state = { ...original, publications, sessions: [...original.sessions,
    ...[native, remote].map(id => ({ id, userId, online: true, signingKey: testSigningKey }))] };
  socket.receive({ type: "state", state });
  try {
    const connecting = session.activateApp();
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const app = ChannelSocket.current;
    await app.onopen?.(); app.receive({ id: app.sent.at(-1)!.id, result: null }); await connecting;
    const watching = session.watch("screen-0");
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", publicationId: "screen-0" }));
    // The listening decision is known before subscription can deliver sound.
    expect(description).toHaveBeenCalled();
    expect([...session.getSnapshot().localScreens]).toEqual(rejected ? [] : ["screen-0"]);
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await watching;
    if (rejected) { expect(session.getSnapshot().error).toBeNull(); return; }
    app.close();
    expect(session.getSnapshot().appConnected).toBe(false);
    expect([...session.getSnapshot().localScreens]).toEqual(["screen-0"]);
    socket.receive({ type: "state", state: { ...state, sessions: state.sessions.map(endpoint => endpoint.id === native ? { ...endpoint, online: false } : endpoint) } });
    expect([...session.getSnapshot().localScreens]).toEqual(["screen-0"]);
    // Exact endpoint retirement clears provenance. A same-user successor is remote.
    socket.receive({ type: "state", state: { ...state, sessions: state.sessions.filter(endpoint => endpoint.id !== native),
      publications: publications.map(publication => ({ ...publication, sessionId: remote })) } });
    expect(session.getSnapshot().localScreens.size).toBe(0);
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
  } finally { session.close(); }
});

test.each(["session", "capture", "app", "unwatch", "retirement"])("pending local-source HTTP follows %s cancellation without trapping the watch", async ending => {
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetcher);
  const { session, socket } = await setup();
  const state = { ...session.getSnapshot().state!, publications: [
    { audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null,
      videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
  ] };
  socket.receive({ type: "state", state });
  const cancel = new AbortController();
  try {
    const connecting = session.activateApp();
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const app = ChannelSocket.current;
    await app.onopen?.(); app.receive({ id: app.sent.at(-1)!.id, result: null }); await connecting;
    const watching = session.watch("screen", undefined, cancel.signal);
    // Attach rejection handling before aborting the underlying request.
    const settled = watching.then(() => null, error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const signal = fetcher.mock.calls[0][1].signal!;
    expect(signal.aborted).toBe(false);
    expect(socket.sent.some(command => command.type === "subscribe")).toBe(false);
    let stopping: Promise<unknown> | undefined;
    if (ending === "session") session.close();
    else if (ending === "capture") cancel.abort();
    else if (ending === "unwatch") stopping = session.unwatch("screen").catch(error => error);
    else if (ending === "retirement") socket.receive({ type: "state", state: { ...state, publications: [] } });
    else app.close();
    expect(signal.aborted).toBe(true);
    if (ending === "app") {
      await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", publicationId: "screen", enabled: true }));
      socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
      expect(await settled).toBeNull();
    } else {
      expect(await settled).toMatchObject({ name: "AbortError" });
      expect(socket.sent.some(command => command.type === "subscribe" && command.enabled)).toBe(false);
    }
    if (stopping) {
      await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", enabled: false }));
      socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
      expect(await stopping).toBeUndefined();
    }
    expect(session.getSnapshot().pending.has("watch:screen")).toBe(false);
  } finally { session.close(); }
});

test("temporary helper unavailability cannot retire a retained watch on Domain recovery", async () => {
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const helperSessionId = crypto.randomUUID();
  const description = vi.spyOn(appLink.ChannelApp.prototype, "describeHosting").mockResolvedValue({ sessionId: helperSessionId, roomIds: [] });
  const { session, socket } = await setup();
  const state = { ...session.getSnapshot().state!, publications: [
    { audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
  ], subscriptions: ["screen"] };
  socket.receive({ type: "state", state });
  try {
    const watching = session.watch("screen");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await watching;
    const connecting = session.activateApp();
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const app = ChannelSocket.current;
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await connecting;
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", helperSessionId }));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });

    socket.close();
    // App control can remain open while its separate Domain session is recovering.
    description.mockRejectedValue(new Error("hosting_unavailable"));
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    for (const command of resumed.sent.filter(command => command.type === "subscribe")) {
      resumed.receive(command.helperSessionId === helperSessionId
        ? { type: "error", requestId: command.requestId, code: "helper_unavailable" }
        : { type: "ack", requestId: command.requestId });
    }
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("watch:screen")).toBe(false));
    expect(app.readyState).toBe(ChannelSocket.OPEN);
    expect(session.getSnapshot().appConnected).toBe(true);
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    expect(session.getSnapshot().error).toBeNull();
    expect(resumed.sent.some(command => command.type === "subscribe" && command.enabled === false)).toBe(false);
  } finally { session.close(); }
});

test("an App description completing after unwatch cannot recreate a subscription", async () => {
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  let describe!: (value: { sessionId: string; roomIds: string[] }) => void;
  const description = vi.spyOn(appLink.ChannelApp.prototype, "describeHosting")
    .mockImplementation(() => new Promise(resolve => { describe = resolve; }));
  const { session, socket } = await setup();
  socket.receive({ type: "state", state: { ...session.getSnapshot().state!, publications: [
    { audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
  ] } });
  try {
    const watching = session.watch("screen");
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", publicationId: "screen", enabled: true }));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await watching;
    const connecting = session.activateApp();
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const app = ChannelSocket.current;
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await connecting;
    await vi.waitFor(() => expect(description).toHaveBeenCalledOnce());
    const stopping = session.unwatch("screen");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await stopping;
    describe({ sessionId: crypto.randomUUID(), roomIds: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent.filter(command => command.type === "subscribe").map(command => command.enabled)).toEqual([true, false]);
    expect(socket.sent.some(command => "helperSessionId" in command)).toBe(false);
  } finally { session.close(); }
});

test.each(["disconnect", "close"])("pending App health cannot create a control socket after Domain %s", async end => {
  const { session, socket } = await setup();
  vi.useFakeTimers();
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  let complete!: (health: Awaited<ReturnType<typeof appLink.discoverChannelAppHealth>>) => void;
  const discovery = vi.spyOn(appLink, "discoverChannelAppHealth").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  try {
    const resuming = session.resumeApp();
    expect(discovery).toHaveBeenCalledOnce();
    if (end === "close") session.close();
    else socket.close();
    complete({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
    await resuming;
    expect(ChannelSocket.current).toBe(socket);
    expect(session.getSnapshot().appConnected).toBe(false);
  } finally { session.close(); }
});

test.each(["absent", "rejected"])("passive App resume leaves the page error unchanged when health is %s", async health => {
  const { session, socket } = await setup();
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  const discovery = vi.spyOn(appLink, "discoverChannelAppHealth");
  if (health === "absent") discovery.mockResolvedValue(null);
  else discovery.mockRejectedValue(new Error("local App unavailable"));
  try {
    const error = session.getSnapshot().error;
    await session.resumeApp();
    expect(session.getSnapshot()).toMatchObject({ appConnected: false, error });
    expect(ChannelSocket.current).toBe(socket);
  } finally { session.close(); }
});

test("personal voice playback follows user identity without sending room commands", async () => {
  const { session, socket } = await setup();
  try {
    const initial = session.getSnapshot().state!;
    const friend = { id: "friend", name: "Friend", version: profileVersion };
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
    gain = { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
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

test("sharing quality is remembered by the actual session across endpoint lifetimes", async () => {
  const preferences = new Map([["piik:quality-preference:v1", JSON.stringify(QUALITY_PROFILES["720p30"])]]);
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => preferences.set(key, value) } });
  const { session } = await setup();
  let resumed: ChannelSession | undefined;
  try {
    expect(session.getSnapshot().quality).toEqual(QUALITY_PROFILES["720p30"]);
    session.setQuality(QUALITY_PROFILES["1080p60"]);
    expect(JSON.parse(preferences.get("piik:quality-preference:v1")!)).toEqual(QUALITY_PROFILES["1080p60"]);
    resumed = new ChannelSession();
    expect(resumed.getSnapshot().quality).toEqual(QUALITY_PROFILES["1080p60"]);
  } finally { resumed?.close(); session.close(); }
});

test("voice microphone permission denial keeps listen-only available and reports the same failure on unmute", async () => {
  const { session, socket } = await setup(3, false);
  const contexts = microphoneMixer([]);
  const getUserMedia = vi.fn().mockRejectedValue(new DOMException("Microphone declined", "NotAllowedError"));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const state = structuredClone(session.getSnapshot().state!);
  try {
    const joining = session.joinVoice("first");
    const denied = expect(joining).rejects.toThrow("voice_microphone_permission_denied");
    expect(getUserMedia).toHaveBeenCalledOnce(); // Permission starts in the user gesture.
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "voice", roomId: "first", joined: false }));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await denied;
    expect(session.getSnapshot().error).toBe("voice_microphone_permission_denied");
    expect(contexts[0].close).toHaveBeenCalledOnce();
    const listening = session.joinVoice("first", true);
    state.voice.push({ sessionId: "endpoint", roomId: "first", muted: true, deafened: false });
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await listening;
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(session.getSnapshot().error).toBeNull();
    await expect(session.setMuted("first", false)).rejects.toThrow("voice_microphone_permission_denied");
    expect(session.getSnapshot().error).toBe("voice_microphone_permission_denied");
    expect(session.getSnapshot().state?.voice[0]).toMatchObject({ muted: true, deafened: false });
    expect(contexts[1].close).toHaveBeenCalledOnce();
    expect(socket.sent.some(command => command.type === "publish")).toBe(false);
  } finally { session.close(); }
});

test("recovery mute stops only this room's retained voice immediately", async () => {
  vi.spyOn(MicrophoneInput.prototype, "level").mockReturnValue(.3);
  const { session, socket } = await setup(3, false);
  const first = remoteTrack("audio"), second = remoteTrack("audio");
  const contexts = microphoneMixer([remoteStream("first", [first]), remoteStream("second", [second])]);
  const raw = remoteTrack("audio"), getUserMedia = vi.fn(async () => remoteStream("shared-raw", [raw]));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const state = structuredClone(session.getSnapshot().state!);
  try {
    for (const roomId of ["first", "second"]) {
      const joining = session.joinVoice(roomId);
      await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "voice", roomId }));
      const join = socket.sent.at(-1)!;
      state.voice.push({ roomId, sessionId: "endpoint", muted: false, deafened: false });
      socket.receive({ type: "state", state });
      socket.receive({ type: "ack", requestId: join.requestId });
      await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
      const publishing = socket.sent.at(-1)!;
      state.publications.push({ audience: [], ...(publishing.publication as { id: string; roomId: string; kind: "voice" }), sessionId: "endpoint", userId: "self", paused: false });
      socket.receive({ type: "state", state });
      socket.receive({ type: "ack", requestId: publishing.requestId });
      await joining;
    }
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(1);
    expect(await session.voiceActivity("first", true)).toEqual(new Map([["endpoint", .3]]));
    state.publications.push(...["first", "second"].map(roomId => ({ audience: [], id: `heard-${roomId}`, roomId, kind: "voice" as const, sessionId: "friend-endpoint", userId: "friend", paused: false })));
    state.subscriptions = ["heard-first", "heard-second"];
    socket.receive({ type: "state", state });
    const received = new Map(["first", "second"].map(roomId => [`heard-${roomId}`, remoteStream(`heard-${roomId}`, [remoteTrack("audio")])]));
    const listening = () => listeningVoicePublications(session.getSnapshot().state, session.getSnapshot().sessionId, received).map(value => value.id);
    const earlier = session.setMuted("first", false), earlierRequest = socket.sent.at(-1)!;
    await session.setMuted("first", true);
    expect(first.enabled).toBe(false); expect(second.enabled).toBe(true);
    expect(await session.voiceActivity("first", true)).toEqual(new Map());
    expect(await session.voiceActivity("second", true)).toEqual(new Map([["endpoint", .3]]));
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: earlierRequest.requestId });
    await earlier;
    expect(first.enabled).toBe(false);
    socket.close();
    const muting = session.setMuted("first", true).catch(error => error);
    expect(first.enabled).toBe(false);
    expect(second.enabled).toBe(true);
    expect(session.getSnapshot().state?.voice.find(value => value.roomId === "first")?.muted).toBe(true);
    await muting;
    await session.setDeafened("first", true);
    expect(listening()).toEqual(["heard-second"]);
    expect(session.getSnapshot().state?.subscriptions).toEqual(state.subscriptions);
    await session.setDeafened("first", false);
    expect(listening()).toEqual(["heard-first", "heard-second"]);
    await session.setMuted("first", false);
    expect(first.enabled).toBe(true);
    await session.setMuted("first", true);
    await session.setDeafened("first", true);
    expect(raw.stop).not.toHaveBeenCalled();
    expect(contexts[0].close).not.toHaveBeenCalled();
    session.reconnect();
    const resumed = ChannelSocket.current; await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    expect(resumed.sent).toContainEqual({ type: "voice", roomId: "first", joined: true, muted: true, deafened: true });
    expect(first.enabled).toBe(false); expect(second.enabled).toBe(true);
    expect(listening()).toEqual(["heard-second"]);
    resumed.receive({ type: "state", state });
    expect(first.enabled).toBe(false);
    expect(session.getSnapshot().state?.voice.find(value => value.roomId === "first")).toMatchObject({ muted: true, deafened: true });
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "new-endpoint", state: { ...state, sessions: state.sessions.map(value => value.id === "endpoint" ? { ...value, id: "new-endpoint" } : value) } });
    expect(session.canUnmute("first")).toBe(false);
    expect(session.getSnapshot().state?.voice.some(value => value.sessionId === "new-endpoint")).toBe(false);
  } finally { session.close(); }
});

test("mute and leave supersede a pending unmute without activating a late microphone", async () => {
  const { session, socket } = await setup(3, false);
  const state = structuredClone(session.getSnapshot().state!);
  const contexts = microphoneMixer([]);
  const raw = remoteTrack("audio");
  let grant!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  try {
    const joining = session.joinVoice("first", true);
    state.voice.push({ roomId: "first", sessionId: "endpoint", muted: true, deafened: false });
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await joining;
    const opening = session.setMuted("first", false);
    expect(session.getSnapshot().pending.has("voice:first")).toBe(true);
    await session.setMuted("first", true);
    expect(session.getSnapshot().state?.voice[0].muted).toBe(true);
    await session.leaveVoice("first");
    expect(session.getSnapshot().state?.voice).toEqual([]);
    grant(remoteStream("late-shared-raw", [raw]));
    await opening;
    expect(socket.sent.some(command => command.type === "publish")).toBe(false);
    expect(raw.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(socket.sent.at(-1)).toMatchObject({ type: "voice", joined: false });
  } finally { session.close(); }
});

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
    getUserMedia.mockRejectedValueOnce(new DOMException("Microphone declined", "NotAllowedError"));
    await expect(session.configureVoiceInput({ deviceId: "denied-device" })).rejects.toThrow("voice_microphone_permission_denied");
    expect(session.getSnapshot().error).toBe("voice_microphone_permission_denied");
    expect(session.getSnapshot().voiceInput.deviceId).toBe("next-device");
    expect(replacement.stop).not.toHaveBeenCalled();
    getUserMedia.mockRejectedValueOnce(new DOMException("Cannot open device", "NotReadableError"));
    await expect(session.configureVoiceInput({ deviceId: "failed-device" })).rejects.toThrow("Cannot open device");
    expect(session.getSnapshot().voiceInput.deviceId).toBe("next-device");
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(contexts[0].close).not.toHaveBeenCalled();
    let grantReplacement!: (stream: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>(resolve => { grantReplacement = resolve; }));
    const lateConfiguration = session.configureVoiceInput({ deviceId: "late-device" });
    const rejected = expect(lateConfiguration).rejects.toMatchObject({ name: "AbortError" });
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
  const rejected = expect(joining).rejects.toMatchObject({ name: "AbortError" });
  session.close();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  grant(remoteStream("late-source", [raw]));
  await rejected;
  expect(contexts[0].createMediaStreamSource).not.toHaveBeenCalled();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(raw.stop).toHaveBeenCalledOnce();
});

test("a new admitted session can request a microphone while retired permission is still pending", async () => {
  const { session, socket } = await setup(1000, false);
  const state = structuredClone(session.getSnapshot().state!);
  const contexts = microphoneMixer([remoteStream("new-voice", [remoteTrack("audio")])]), late = remoteTrack("audio");
  const grants: ((stream: MediaStream) => void)[] = [];
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grants.push(resolve); }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.useFakeTimers();
  const oldJoin = session.joinVoice("first").catch(error => error);
  let nextJoin: Promise<unknown> | undefined;
  try {
    socket.close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.getSnapshot().sessionId).toBeNull();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(await oldJoin).toMatchObject({ name: "AbortError" });
    expect(session.getSnapshot().pending.has("voice:first")).toBe(false);
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    state.sessions = state.sessions.map(value => value.id === "endpoint" ? { ...value, id: "new-endpoint" } : value);
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "new-endpoint", state });
    nextJoin = session.joinVoice("first").catch(error => error);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    grants.shift()!(remoteStream("late-source", [late]));
    await vi.advanceTimersByTimeAsync(0);
    expect(late.stop).toHaveBeenCalledOnce();
    expect(contexts[1].close).not.toHaveBeenCalled();
    grants.shift()!(remoteStream("new-source", [remoteTrack("audio")]));
    await vi.waitFor(() => expect(resumed.sent.at(-1)).toMatchObject({ type: "voice", joined: true }));
    resumed.receive({ type: "ack", requestId: resumed.sent.at(-1)!.requestId });
    await vi.waitFor(() => expect(resumed.sent.at(-1)?.type).toBe("publish"));
    resumed.receive({ type: "ack", requestId: resumed.sent.at(-1)!.requestId });
    expect(await nextJoin).toBeUndefined();
    expect(session.getSnapshot().error).toBeNull();
  } finally {
    session.close();
    grants.forEach(grant => grant(remoteStream("late-source", [late])));
    await Promise.all([oldJoin, nextJoin]);
  }
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
    const state = { ...session.getSnapshot().state!, voice: [{ sessionId: "endpoint", roomId: "first", muted: false, deafened: false }] };
    socket.receive({ type: "state", state });
    socket.receive({ type: "room_reply", roomId: "first", requestId: join.requestId, result: { type: "done" } });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const publish = socket.sent.at(-1)!, publication = publish.publication as { id: string; roomId: string; kind: "voice" };
    state.publications = [{ audience: [], ...publication, paused: false, sessionId: "endpoint", userId: "self" }];
    socket.receive({ type: "state", state });
    socket.receive({ type: "room_reply", roomId: "first", requestId: publish.requestId, result: { type: "done" } });
    await joining;

    const deafening = session.setDeafened("first", true);
    state.voice[0].deafened = true;
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await deafening;

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
    state.publications = [{ audience: [], ...nextPublication, paused: false, sessionId: "endpoint", userId: "self" }];
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
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
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
    state.publications = [{ audience: [], id: firstId, roomId: "first", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false, sessionId: "endpoint", userId: "self" }];
    socket.receive({ type: "state", state });

    const publishingSecond = session.publish("screen", "second", remoteStream("second-capture", [second]));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    const secondId = await publishingSecond;
    const stopping = session.stopScreen(firstId);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await stopping;
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();

    state.publications = [{ audience: [], id: secondId, roomId: "second", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false, sessionId: "endpoint", userId: "self" }];
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
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        voiceIsolation: false, channelCount: { ideal: 2 }, restrictOwnAudio: true },
      systemAudio: "include", windowAudio: "window",
    });

    const cameraStarting = session.startScreen("second", "camera", "rear");
    await vi.waitFor(() => expect(socket.sent.filter(command => command.type === "publish")).toHaveLength(2));
    const second = socket.sent.at(-1)!;
    socket.receive({ type: "ack", requestId: second.requestId });
    await cameraStarting;
    const firstId = (first.publication as { id: string }).id, secondId = (second.publication as { id: string }).id;
    expect(second.publication).toEqual({ id: secondId, roomId: "second", kind: "screen", source: { kind: "camera", name: null },
      videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]) });
    expect(secondId).not.toBe(firstId);
    session.setVideoCodecMode("vp8");
    expect(session.screenCodecMode(firstId)).toBe("auto");
    expect(session.screenCodecMode(secondId)).toBe("auto");
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

test("codec selection cancellation releases capture without publishing or stopping a replacement", async () => {
  const { session, socket } = await setup();
  const video = remoteTrack("video");
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: async () => remoteStream("codec-source", [video]) } });
  let cancelled: AbortSignal | undefined;
  vi.spyOn(codecPreflight, "preferredVideoCodecForTrack").mockImplementation((_track, signal) => {
    cancelled = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  try {
    const starting = session.startScreen("first");
    const result = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(cancelled).toBeDefined());
    await session.cancelScreenSelection("first");
    await result;
    expect(cancelled!.aborted).toBe(true);
    expect(video.stop).toHaveBeenCalledOnce();
    expect(socket.sent.some(command => command.type === "publish")).toBe(false);
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
  } finally { session.close(); }
});

test.each([
  ["vp8", true, ["h264", "vp8"], "vp8"], ["h264", false, ["h264", "vp8"], "h264"],
  ["auto", false, ["h264"], "auto"], ["auto", false, ["h264", "vp8"], "vp8"], ["auto", true, ["h264", "vp8"], "auto"],
] as const)("Native codec selection uses advertised encoders and preserves manual intent (%s, H264 receive=%s, Native=%s)", async (mode, receivingH264, codecs, expected) => {
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [{ mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "packetization-mode=1" }] }) });
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: [receivingH264
    ? { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "packetization-mode=1" }
    : { mimeType: "video/VP8", clockRate: 90000 }] }) });
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  session.setVideoCodecMode(mode);
  try {
    await app.onopen?.(); app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const target = { kind: "display" as const, sourceId: "1", title: "Owned fixture" };
    const listing = session.nativeSources();
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("targets"));
    app.receive({ id: app.sent.at(-1)!.id, result: { sources: [target], codecs, videoAdaptation: true, externalInput: false, processAudio: false, processAudioExclusion: false, systemAudio: false, captureBorderControl: false } });
    await listing;
    const selecting = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    expect(app.sent.at(-1)?.codecMode).toBe(expected);
    const publicationId = app.sent.at(-1)!.publicationId as string;
    app.receive({ id: app.sent.at(-1)!.id, result: { captureId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
      codec: expected === "auto" ? "h264" : expected } });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("subscribe"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await expect(selecting).resolves.toBeUndefined();
    expect(session.getSnapshot().ownedScreens).toEqual(new Set([publicationId]));
    expect(app.sent.filter(command => command.type === "targets")).toHaveLength(1);
    expect(session.getSnapshot().videoCodecMode).toBe(mode);
  } finally { session.close(); }
});

test("Browser screen pause stops the retained picture and source sound before recovery acknowledgement", async () => {
  const { session, socket } = await setup(3, false);
  const video = remoteTrack("video"), sound = remoteTrack("audio");
  microphoneMixer([]);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: async () => remoteStream("owned-screen", [video, sound]) } });
  try {
    const starting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const request = socket.sent.at(-1)!, publication = request.publication as { id: string; roomId: string; kind: "screen"; source: ScreenSource; videoSettings: VideoSettings };
    socket.receive({ type: "ack", requestId: request.requestId }); await starting;
    const state = { ...session.getSnapshot().state!, publications: [{ audience: [], title: null, ...publication, sessionId: "endpoint", userId: "self", paused: false }] };
    socket.receive({ type: "state", state });
    socket.close();
    const pausing = session.setScreenPaused(publication.id, true).catch(error => error);
    expect(video.enabled).toBe(false);
    expect(sound.enabled).toBe(false);
    await pausing;
    expect(session.getSnapshot().state?.publications[0].paused).toBe(true);
    session.reconnect();
    const resumed = ChannelSocket.current; await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    expect(resumed.sent).toContainEqual({ type: "set_paused", publicationId: publication.id, paused: true });
    resumed.receive({ type: "state", state });
    expect(video.enabled).toBe(false); expect(sound.enabled).toBe(false);
    const resuming = session.setScreenPaused(publication.id, false), resumeRequest = resumed.sent.at(-1)!;
    await session.setScreenPaused(publication.id, true);
    expect(video.enabled).toBe(false);
    resumed.receive({ type: "ack", requestId: resumeRequest.requestId });
    await resuming;
    expect(session.getSnapshot().state?.publications[0].paused).toBe(true);
  } finally { session.close(); }
});

test("Browser source mute reaches the incumbent gain while picture quality is pending or rejected", async () => {
  const { session, socket } = await setup(3, false);
  session.setVideoCodecMode("vp8");
  const setLocal = vi.spyOn(ChannelMedia.prototype, "setLocal");
  const contexts = microphoneMixer([]);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: async () => remoteStream("owned-screen", [remoteTrack("video"), remoteTrack("audio")]) } });
  let rejectQuality!: (error: Error) => void;
  try {
    const starting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const request = socket.sent.at(-1)!, id = (request.publication as { id: string }).id;
    socket.receive({ type: "ack", requestId: request.requestId }); await starting;
    const codec = setLocal.mock.lastCall![3];
    await session.setSourceAudio(id, { bitrate: 96_000 });
    expect(setLocal.mock.lastCall![3]).toBe(codec);
    const configure = vi.spyOn(ChannelMedia.prototype, "configureLocal").mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectQuality = reject; }));
    const changing = session.setScreenQuality(id, QUALITY_PROFILES["720p30"]).catch(error => error);
    await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
    await session.setSourceAudio(id, { muted: true });
    expect(contexts[0].gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .01);
    rejectQuality(new Error("quality_rejected")); await changing;
    expect(session.sourceAudio(id)?.muted).toBe(true);
    expect(contexts[0].gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .01);
  } finally { session.close(); }
});

test("commentary off stops an incumbent microphone before pending replacement permission returns", async () => {
  const { session, socket } = await setup(3, false);
  const old = remoteTrack("audio"), late = remoteTrack("audio");
  microphoneMixer([]);
  let grant!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn().mockResolvedValueOnce(remoteStream("old-commentary", [old]))
    .mockImplementationOnce(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: async () => remoteStream("owned-screen", [remoteTrack("video")]), getUserMedia } });
  let replacing: Promise<unknown> | undefined;
  try {
    const starting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const request = socket.sent.at(-1)!, id = (request.publication as { id: string }).id;
    socket.receive({ type: "ack", requestId: request.requestId }); await starting;
    await session.setSourceMicrophone(id, { enabled: true, deviceId: "old" });
    replacing = session.setSourceMicrophone(id, { deviceId: "next" }).catch(error => error);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    const stopping = session.setSourceMicrophone(id, { enabled: false }).catch(error => error);
    expect(old.stop).toHaveBeenCalledOnce();
    grant(remoteStream("late-commentary", [late]));
    await Promise.all([replacing, stopping]);
    expect(session.sourceMicrophone(id)?.enabled).toBe(false);
    expect(late.stop).toHaveBeenCalledOnce();
  } finally { session.close(); if (grant) grant(remoteStream("late-commentary", [late])); await replacing; }
});

test("screen commentary owns a separate microphone and keeps its mixed track across source replacement", async () => {
  const { session, socket } = await setup();
  const voiceTrack = remoteTrack("audio"), commentary = remoteTrack("audio"), nextCommentary = remoteTrack("audio");
  const voiceClone = remoteStream("voice-clone", [remoteTrack("audio")]);
  const contexts = microphoneMixer([voiceClone]);
  const firstVideo = remoteTrack("video"), firstSound = remoteTrack("audio"), nextVideo = remoteTrack("video");
  const getDisplayMedia = vi.fn().mockResolvedValueOnce(remoteStream("first-picture", [firstVideo, firstSound]))
    .mockResolvedValueOnce(remoteStream("next-picture", [nextVideo]));
  const getUserMedia = vi.fn().mockResolvedValueOnce(remoteStream("room-mic", [voiceTrack]))
    .mockResolvedValueOnce(remoteStream("commentary", [commentary]))
    .mockResolvedValueOnce(remoteStream("next-commentary", [nextCommentary]));
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia } });
  try {
    const starting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const publication = socket.sent.at(-1)!.publication as { id: string; roomId: string; kind: "screen"; source: ScreenSource; videoSettings: VideoSettings };
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await starting;
    socket.receive({ type: "state", state: { ...session.getSnapshot().state!, publications: [
      { audience: [], title: null, ...publication, paused: false, sessionId: "endpoint", userId: "self" },
    ] } });
    const mixed = session.getSnapshot().streams.get(publication.id)!.getAudioTracks()[0];
    expect(session.sourceMicrophone(publication.id)).toMatchObject({ available: true, enabled: false });
    expect(getUserMedia).not.toHaveBeenCalled();

    const joining = session.joinVoice("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("voice"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await joining;
    await session.setSourceMicrophone(publication.id, { enabled: true, deviceId: "commentary-device", voiceProcessing: false });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({
      deviceId: { exact: "commentary-device" }, echoCancellation: false,
    }), video: false });
    expect(session.getSnapshot().voiceInput.deviceId).not.toBe("commentary-device");
    const changingGain = session.setSourceMicrophone(publication.id, { volume: .3 });
    expect(session.setSourceMicrophone(publication.id, { volume: .4 })).toBe(changingGain);
    await changingGain;
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(session.sourceMicrophone(publication.id)).toMatchObject({ enabled: true, volume: .4 });
    await session.setSourceMicrophone(publication.id, { enabled: false });
    expect(commentary.stop).toHaveBeenCalledOnce();
    expect(voiceTrack.stop).not.toHaveBeenCalled();
    await session.setSourceMicrophone(publication.id, { enabled: true });

    const replacing = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("transfer_source"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await ackSourceUpdate(socket); await replacing;
    const stream = session.getSnapshot().streams.get(publication.id)!;
    expect(stream.getAudioTracks()[0]).toBe(mixed);
    expect(stream.getVideoTracks()).toEqual([nextVideo]);
    expect(mixed.stop).not.toHaveBeenCalled();
    expect(firstVideo.stop).toHaveBeenCalledOnce(); expect(firstSound.stop).toHaveBeenCalledOnce();
    expect(nextCommentary.stop).not.toHaveBeenCalled(); expect(voiceTrack.stop).not.toHaveBeenCalled();
    expect(contexts[0].close).not.toHaveBeenCalled();
    expect(session.sourceMicrophone(publication.id)).toMatchObject({ available: true, enabled: true, deviceId: "commentary-device" });
    expect(session.sourceMicrophone(publication.id)?.browser).toBe(true);
    expect(session.sourceAudio(publication.id)).toMatchObject({ hasAudio: true, available: true });
    await session.setSourceAudio(publication.id, { level: 0, muted: true });
    expect(session.sourceAudio(publication.id)).toMatchObject({ hasAudio: true, available: true, level: 0, muted: true });
    await session.setSourceMicrophone(publication.id, { enabled: false });
    expect(session.sourceAudio(publication.id)).toMatchObject({ hasAudio: false, available: false });
    expect(session.getSnapshot().streams.get(publication.id)!.getAudioTracks()[0]).toBe(mixed);

    const stopping = session.stopScreen(publication.id);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await stopping;
    expect(nextCommentary.stop).toHaveBeenCalledOnce(); expect(nextVideo.stop).toHaveBeenCalledOnce();
    expect(mixed.stop).toHaveBeenCalled(); expect(voiceTrack.stop).not.toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    const leaving = session.leaveVoice("first");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await leaving;
    expect(voiceTrack.stop).toHaveBeenCalledOnce();
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
    const closed = expect(retrying).rejects.toMatchObject({ name: "AbortError" });
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

test.each(["camera", "browser"] as const)("cancelled %s permission releases the picker before a late grant", async source => {
  const { session, socket } = await setup(1000, false);
  const late = remoteTrack("video"), current = remoteTrack("video");
  let grant!: (stream: MediaStream) => void;
  const acquire = vi.fn().mockImplementationOnce(() => new Promise<MediaStream>(resolve => { grant = resolve; }))
    .mockResolvedValueOnce(remoteStream("new-source", [current]));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: acquire, getDisplayMedia: acquire } });
  try {
    const previous = session.startScreen("first", source);
    const cancelled = expect(previous).rejects.toMatchObject({ name: "AbortError" });
    await session.cancelScreenSelection("first");
    await cancelled;
    expect(session.getSnapshot().pending.has("screen:first")).toBe(false);
    const next = session.startScreen("first", source);
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await next;
    grant(remoteStream("late-source", [late]));
    await vi.waitFor(() => expect(late.stop).toHaveBeenCalledOnce());
    expect(current.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot().ownedScreens.size).toBe(1);
    expect(socket.sent.filter(command => command.type === "publish")).toHaveLength(1);
  } finally { session.close(); }
});

test("Browser source replacement keeps its publication, rejects only the candidate and fences late ended/grant events", async () => {
  const { session, socket } = await setup();
  const old = remoteTrack("video"), expired = remoteTrack("video"), next = remoteTrack("video"), cancelled = remoteTrack("video"), stopped = remoteTrack("video");
  const oldStream = remoteStream("old", [old]), nextStream = remoteStream("next", [next]);
  let grant!: (stream: MediaStream) => void;
  const getDisplayMedia = vi.fn().mockResolvedValueOnce(oldStream)
    .mockRejectedValueOnce(new DOMException("Declined", "NotAllowedError"))
    .mockResolvedValueOnce(remoteStream("expired", [expired]))
    .mockResolvedValueOnce(nextStream)
    .mockImplementation(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  try {
    const initial = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const publication = socket.sent.at(-1)!.publication as { id: string; roomId: string; kind: "screen"; source: ScreenSource; videoSettings: VideoSettings };
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await initial;
    const state = { ...session.getSnapshot().state!, publications: [{ audience: [], title: null, ...publication, paused: false, sessionId: "endpoint", userId: "self" }] };
    socket.receive({ type: "state", state });
    await expect(session.startScreen("first")).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(old.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot().streams.get(publication.id)).toBe(oldStream);
    const ending = session.startScreen("first");
    const ended = expect(ending).rejects.toThrow("capture_unavailable");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("transfer_source"));
    Object.defineProperty(expired, "readyState", { value: "ended" });
    expired.dispatchEvent(new Event("ended"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await ended;
    expect(expired.stop).toHaveBeenCalledOnce();
    expect(old.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot().streams.get(publication.id)).toBe(oldStream);
    expect(socket.sent.some(command => command.type === "unpublish")).toBe(false);
    const endedRequestId = socket.sent.at(-1)!.requestId;
    const replacing = session.startScreen("first");
    await vi.waitFor(() => {
      expect(socket.sent.at(-1)?.type).toBe("transfer_source");
      expect(socket.sent.at(-1)!.requestId).not.toBe(endedRequestId);
    });
    expect(socket.sent.at(-1)).toMatchObject({ publicationId: publication.id, toSessionId: "endpoint" });
    expect(old.stop).not.toHaveBeenCalled();
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await ackSourceUpdate(socket);
    await replacing;
    expect(session.getSnapshot().streams.get(publication.id)).toBe(nextStream);
    expect(socket.sent.filter(command => command.type === "publish")).toHaveLength(2);
    expect(old.stop).toHaveBeenCalledOnce();
    old.dispatchEvent(new Event("ended"));
    expect(socket.sent.some(command => command.type === "unpublish")).toBe(false);
    const pendingCancel = session.startScreen("first");
    const aborted = expect(pendingCancel).rejects.toMatchObject({ name: "AbortError" });
    await session.cancelScreenSelection("first");
    grant(remoteStream("cancelled", [cancelled]));
    await aborted;
    expect(cancelled.stop).toHaveBeenCalledOnce();
    expect(next.stop).not.toHaveBeenCalled();
    const pendingStop = session.startScreen("first");
    const late = expect(pendingStop).rejects.toMatchObject({ name: "AbortError" });
    const stopping = session.stopScreen(publication.id);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await stopping;
    grant(remoteStream("late", [stopped]));
    await late;
    expect(stopped.stop).toHaveBeenCalledOnce();
    expect(next.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
  } finally { session.close(); }
});

test.each(["live", "metadata-rejected", "native-stop-rejected", "stop-before-reply", "candidate-ended-before-reply", "app-close-before-state", "app-close-after-state", "transfer-rejected", "audio-stop-before-reply", "mute-during-native-prepare", "mute-during-native-commit", "mute-rejected-during-native-prepare"])("Browser and Native handoffs keep one publication and use the current Native capture lease (%s)", async outcome => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  const old = remoteTrack("video"), next = remoteTrack("video");
  const muteTransition = outcome.startsWith("mute-");
  const contexts = muteTransition ? microphoneMixer([]) : [];
  vi.mocked(next.stop).mockImplementation(() => { Object.defineProperty(next, "readyState", { value: "ended" }); });
  const nextStream = remoteStream("browser-next", [next]);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn()
    .mockResolvedValueOnce(remoteStream("browser-old", [old, ...(muteTransition ? [remoteTrack("audio")] : [])])).mockResolvedValueOnce(nextStream) } });
  const target = { kind: "display" as const, sourceId: "1", title: "Test display" };
  const nativeSessionId = crypto.randomUUID(), firstCaptureId = crypto.randomUUID(), secondCaptureId = crypto.randomUUID();
  const appReply = (result: unknown = null) => app.receive({ id: app.sent.at(-1)!.id, result });
  const coreReply = () => socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
  const appCommand = async (type: string) => { await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe(type)); return app.sent.at(-1)!; };
  try {
    await app.onopen?.(); appReply();
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const initial = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const publication = socket.sent.at(-1)!.publication as { id: string; roomId: string; kind: "screen"; source: ScreenSource; videoSettings: VideoSettings };
    coreReply(); await initial;
    let state = { ...session.getSnapshot().state!, publications: [{ audience: [], title: null, ...publication, paused: false, sessionId: "endpoint", userId: "self" }] };
    socket.receive({ type: "state", state });
    const cancelled = session.startNativeScreen("first", target);
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const prepare = await appCommand("prepare_capture");
    const cancel = session.cancelScreenSelection("first");
    expect(app.sent.at(-1)).toMatchObject({ type: "cancel_capture", publicationId: publication.id });
    appReply(); await cancel;
    app.receive({ id: prepare.id, error: "capture_cancelled" }); await cancelledResult;
    expect(old.stop).not.toHaveBeenCalled();
    expect(app.sent.some(command => command.type === "stop_capture")).toBe(false);

    const native = session.startNativeScreen("first", target, true);
    const nativePrepare = await appCommand("prepare_capture");
    expect(nativePrepare).toMatchObject({ publicationId: publication.id, roomId: "first", target, audio: true });
    expect(app.sent.at(-1)?.codecMode).toBe("vp8");
    if (outcome === "mute-during-native-prepare" || outcome === "mute-rejected-during-native-prepare") {
      const muting = session.setSourceAudio(publication.id, { muted: true });
      const mutedResult = outcome === "mute-rejected-during-native-prepare" ? expect(muting).rejects.toThrow("audio_unavailable") : muting;
      expect(await appCommand("capture_audio_settings")).toMatchObject({ publicationId: publication.id, settings: { gain: 0 } });
      expect(app.sent.at(-1)).not.toHaveProperty("captureId");
      expect(contexts[0].gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .01);
      app.receive({ id: app.sent.at(-1)!.id, ...(outcome === "mute-rejected-during-native-prepare" ? { error: "audio_unavailable" } : { result: null }) });
      await mutedResult;
      expect(session.sourceAudio(publication.id)?.muted).toBe(true);
      if (outcome === "mute-rejected-during-native-prepare") {
        const cancelled = expect(native).rejects.toMatchObject({ name: "AbortError" });
        const cancelling = session.cancelScreenSelection("first"); appReply(); await cancelling;
        app.receive({ id: nativePrepare.id, error: "capture_cancelled" }); await cancelled;
        expect(old.stop).not.toHaveBeenCalled();
        return;
      }
    }
    app.receive({ id: nativePrepare.id, result: { captureId: firstCaptureId, sessionId: nativeSessionId, codec: "vp8" } });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("transfer_source"));
    expect(socket.sent.at(-1)).toMatchObject({ publicationId: publication.id, toSessionId: nativeSessionId });
    expect(old.stop).not.toHaveBeenCalled();
    state = { ...state, publications: [{ ...state.publications[0], sessionId: nativeSessionId }] };
    socket.receive({ type: "state", state }); coreReply();
    const committing = await appCommand("commit_capture");
    expect(committing).toMatchObject({ publicationId: publication.id, captureId: firstCaptureId });
    const remoteControl = { mode: "ask", platform: "windows", canSetStopShortcut: false, requests: [] };
    app.receive({ type: "input_state", publicationId: publication.id, state: remoteControl });
    expect(session.getSnapshot().remoteControls.get(publication.id)).toEqual(remoteControl);
    if (outcome === "mute-during-native-commit") {
      const muting = session.setSourceAudio(publication.id, { muted: true });
      expect(await appCommand("capture_audio_settings")).toMatchObject({ publicationId: publication.id, settings: { gain: 0 } });
      expect(app.sent.at(-1)).not.toHaveProperty("captureId");
      appReply(); await muting;
      expect(contexts[0].gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .01);
    }
    app.receive({ id: committing.id, result: null });
    app.receive({ type: "capture_audio_state", publicationId: publication.id,
      state: { sourceAudio: true, microphone: { enabled: false, deviceId: "", volume: 1 } } });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("subscribe"));
    state = { ...state, subscriptions: [publication.id] };
    socket.receive({ type: "state", state }); coreReply(); await native;
    expect(old.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().ownedScreens).toEqual(new Set([publication.id]));
    if (muteTransition) { expect(session.sourceAudio(publication.id)?.muted).toBe(true); return; }
    if (outcome === "live") {
      const titling = session.setScreenTitle(publication.id, "Native notes");
      expect(app.sent.at(-1)).toMatchObject({ type: "capture_title", publicationId: publication.id, captureId: firstCaptureId, title: "Native notes" });
      appReply(); await titling;
      expect(socket.sent.some(command => command.type === "set_title")).toBe(false);
      expect(session.getSnapshot().state!.publications[0].title).toBeNull();
    }
    const audioSettings = session.setSourceAudio(publication.id, { bitrate: 192_000, level: 0.5 });
    expect(await appCommand("capture_audio_settings")).toMatchObject({ publicationId: publication.id,
      settings: { bitrate: 192_000, gain: 0.5 } });
    expect(app.sent.at(-1)).not.toHaveProperty("captureId");
    const coalesced = session.setSourceAudio(publication.id, { level: 1.0 });
    const latest = session.setSourceAudio(publication.id, { level: 1.5 });
    expect(coalesced).toBe(audioSettings); expect(latest).toBe(audioSettings);
    expect(app.sent.filter(command => command.type === "capture_audio_settings")).toHaveLength(1);
    await expect(session.startScreen("first")).rejects.toThrow("operation_pending");
    appReply();
    await vi.waitFor(() => expect(app.sent.filter(command => command.type === "capture_audio_settings")).toHaveLength(2));
    expect(app.sent.at(-1)).toMatchObject({ settings: { bitrate: 192_000, gain: 1.5 } });
    appReply(); await audioSettings;
    expect(session.sourceAudio(publication.id)).toMatchObject({ bitrate: 192_000, level: 1.5, muted: false, available: true });

    if (outcome === "audio-stop-before-reply") {
      const rejected = session.setSourceAudio(publication.id, { level: 0.25 });
      const failure = expect(rejected).rejects.toThrow("audio_unavailable");
      await appCommand("capture_audio_settings");
      app.receive({ id: app.sent.at(-1)!.id, error: "audio_unavailable" }); await failure;
      expect(session.sourceAudio(publication.id)?.level).toBe(1.5);
      const updating = session.setSourceAudio(publication.id, { level: 0.75 });
      const retired = expect(updating).rejects.toMatchObject({ name: "AbortError" });
      const pending = await appCommand("capture_audio_settings");
      expect(session.setSourceAudio(publication.id, { level: 1.75 })).toBe(updating);
      const before = app.sent.filter(command => command.type === "capture_audio_settings").length;
      const stopping = session.stopScreen(publication.id);
      expect(app.sent.at(-1)?.type).toBe("stop_capture"); appReply(); await stopping;
      app.receive({ id: pending.id, result: null }); await retired;
      expect(app.sent.filter(command => command.type === "capture_audio_settings")).toHaveLength(before);
      expect(session.sourceAudio(publication.id)).toBeUndefined();
      expect(session.getSnapshot().ownedScreens.size).toBe(0);
      return;
    }

    const oldShortcut = session.inputShortcut(publication.id, 10);
    const oldShortcutCommand = app.sent.at(-1)!;
    const retiredShortcut = expect(oldShortcut).rejects.toMatchObject({ name: "AbortError" });
    const nativeAgain = session.startNativeScreen("first", target);
    expect(await appCommand("prepare_capture")).toMatchObject({ publicationId: publication.id });
    expect(session.sourceAudio(publication.id)?.canMute).toBe(true);
    expect(app.sent.at(-1)?.codecMode).toBe("vp8");
    appReply({ captureId: secondCaptureId, sessionId: nativeSessionId, codec: "vp8" });
    const replacementCommit = await appCommand("commit_capture");
    expect(replacementCommit).toMatchObject({ publicationId: publication.id, captureId: secondCaptureId });
    if (outcome === "live") {
      const stalePolicy = session.inputPolicy(publication.id, "room");
      const staleResult = expect(stalePolicy).rejects.toThrow("input_source_unavailable");
      expect(app.sent.at(-1)).toMatchObject({ type: "input_policy", publicationId: publication.id,
        captureId: firstCaptureId, mode: "room" });
      app.receive({ id: app.sent.at(-1)!.id, error: "input_source_unavailable" });
      await staleResult;
    }
    app.receive({ id: replacementCommit.id, result: null }); await nativeAgain;
    if (outcome === "live") {
      const simultaneous = session.inputSimultaneous(publication.id, true);
      expect(app.sent.at(-1)).toMatchObject({ type: "input_policy", publicationId: publication.id,
        captureId: secondCaptureId, mode: "ask", simultaneous: true });
      appReply(); await simultaneous;
    }
    app.receive({ id: oldShortcutCommand.id, result: { key: 10, available: true } });
    await retiredShortcut;
    expect(socket.sent.filter(command => command.type === "transfer_source")).toHaveLength(1);

    const send = socket.send.bind(socket);
    vi.spyOn(socket, "send").mockImplementation(data => {
      send(data);
      const command = JSON.parse(data);
      if (command.type === "subscribe" && command.publicationId === publication.id) socket.receive({
        type: "error", requestId: command.requestId, code: "invalid_subscription",
      });
    });
    const browser = session.startScreen("first");
    const transferring = await appCommand("transfer_source");
    expect(transferring).toMatchObject({ publicationId: publication.id, captureId: secondCaptureId, toSessionId: "endpoint" });
    if (outcome === "app-close-before-state" || outcome === "app-close-after-state" || outcome === "transfer-rejected") {
      const committed = outcome !== "transfer-rejected";
      const error = committed ? "app_disconnected" : "source_unavailable";
      const failed = expect(browser).rejects.toThrow(error);
      const transferred = { ...state, publications: [{ ...state.publications[0], sessionId: "endpoint" }], subscriptions: [] };
      if (outcome === "app-close-after-state") socket.receive({ type: "state", state: transferred });
      if (committed) app.close();
      else app.receive({ id: transferring.id, error });
      // This update hides the now-unowned local projection before cleanup replies.
      if (outcome === "app-close-after-state") socket.receive({ type: "state", state: transferred });
      await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("unpublish"));
      const cleanup = socket.sent.at(-1)!;
      expect(cleanup).toMatchObject({ publicationId: publication.id, requestId: expect.any(String) });
      if (outcome === "app-close-before-state") socket.receive({ type: "state", state: transferred });
      socket.receive({ type: "room_reply", roomId: "first", requestId: cleanup.requestId,
        result: committed ? { type: "done" } : { type: "error", code: "not_publication_owner" } });
      if (committed) socket.receive({ type: "state", state: { ...transferred, publications: [] } });
      await failed;
      expect(next.stop).toHaveBeenCalledOnce();
      expect(session.getSnapshot().streams.has(publication.id)).toBe(false);
      expect(session.getSnapshot().ownedScreens.has(publication.id)).toBe(!committed);
      expect(session.getSnapshot().state?.publications).toEqual(committed ? [] : state.publications);
      expect(session.getSnapshot().error).toBe(error);
      expect(socket.readyState).toBe(ChannelSocket.OPEN);
      expect(app.sent.some(command => command.type === "stop_capture")).toBe(false);
      expect(socket.sent.filter(command => command.type === "unpublish")).toHaveLength(1);
      return;
    }
    if (outcome === "candidate-ended-before-reply") {
      const ended = expect(browser).rejects.toThrow("capture_unavailable");
      Object.defineProperty(next, "readyState", { value: "ended", configurable: true });
      next.dispatchEvent(new Event("ended"));
      state = { ...state, publications: [{ ...state.publications[0], sessionId: "endpoint" }], subscriptions: [] };
      socket.receive({ type: "state", state }); appReply();
      expect(await appCommand("stop_capture")).toMatchObject({ publicationId: publication.id });
      appReply(); await ended;
      expect(socket.sent.at(-1)).toMatchObject({ type: "unpublish", publicationId: publication.id });
      socket.receive({ type: "state", state: { ...state, publications: [] } });
      expect(next.stop).toHaveBeenCalledOnce();
      expect(session.getSnapshot().streams.has(publication.id)).toBe(false);
      expect(session.getSnapshot().ownedScreens.size).toBe(0);
      return;
    }
    if (outcome === "stop-before-reply") {
      const cancelled = expect(browser).rejects.toMatchObject({ name: "AbortError" });
      const stopping = session.stopScreen(publication.id);
      expect(app.sent.at(-1)).toMatchObject({ type: "stop_capture", publicationId: publication.id });
      appReply(); await stopping;
      expect(socket.sent.some(command => command.type === "unpublish")).toBe(false);
      state = { ...state, publications: [{ ...state.publications[0], sessionId: "endpoint" }], subscriptions: [] };
      socket.receive({ type: "state", state });
      app.receive({ id: transferring.id, result: null });
      await cancelled;
      expect(socket.sent.at(-1)).toEqual({ type: "unpublish", publicationId: publication.id });
      socket.receive({ type: "state", state: { ...state, publications: [] } });
      expect(next.readyState).toBe("ended");
      expect(next.stop).toHaveBeenCalledOnce();
      expect(session.getSnapshot().ownedScreens.size).toBe(0);
      expect(session.getSnapshot().state?.publications).toEqual([]);
      expect(session.getSnapshot().error).toBeNull();
      expect(socket.sent.filter(command => command.type === "publish")).toHaveLength(1);
      return;
    }
    state = { ...state, publications: [{ ...state.publications[0], sessionId: "endpoint" }], subscriptions: [] };
    socket.receive({ type: "state", state }); appReply();
    expect(await appCommand("stop_capture")).toMatchObject({ publicationId: publication.id });
    expect(session.getSnapshot().streams.get(publication.id)).toBe(nextStream);
    if (outcome === "metadata-rejected" || outcome === "native-stop-rejected") {
      const failure = expect(browser).rejects.toThrow("room_unavailable");
      expect(socket.sent.at(-1)).toMatchObject({ type: "publish", publication: { id: publication.id, source: { kind: "screen", name: null } } });
      if (outcome === "metadata-rejected") {
        socket.receive({ type: "error", requestId: socket.sent.at(-1)!.requestId, code: "room_unavailable" });
        appReply();
      } else {
        app.receive({ id: app.sent.at(-1)!.id, error: "room_unavailable" });
        await ackSourceUpdate(socket);
      }
      await failure;
      expect(session.getSnapshot().streams.get(publication.id)).toBe(nextStream);
      expect(next.stop).not.toHaveBeenCalled();
      expect(session.getSnapshot().ownedScreens.has(publication.id)).toBe(true);
      return;
    }
    appReply();
    await ackSourceUpdate(socket);
    await browser;
    expect(socket.sent.some(command => command.type === "subscribe" && command.enabled === false)).toBe(false);
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().state?.publications.map(value => value.id)).toEqual([publication.id]);
    expect(session.getSnapshot().state?.subscriptions).toEqual([]);
    expect(session.getSnapshot().remoteControls.has(publication.id)).toBe(false);
    expect(socket.sent.filter(command => command.type === "publish")).toHaveLength(2);
    expect(socket.sent.some(command => command.type === "unpublish")).toBe(false);
    expect(next.stop).not.toHaveBeenCalled();
  } finally { session.close(); }
});

test("Browser source output gain and bitrate survive replacement and close with the capture", async () => {
  const { session, socket } = await setup();
  const contexts: Array<{ gain: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const node = () => ({ connect() {}, disconnect() {} });
  vi.stubGlobal("AudioContext", class {
    currentTime = 0;
    gain = vi.fn(); close = vi.fn(async () => {});
    constructor() { contexts.push(this); }
    createMediaStreamDestination() { return { ...node(), stream: remoteStream("mixed", [remoteTrack("audio")]) }; }
    createGain() { return { ...node(), gain: { value: 1, setTargetAtTime: this.gain } }; }
    createMediaStreamSource() { return node(); }
    async resume() {}
  });
  const first = remoteStream("original", [remoteTrack("video"), remoteTrack("audio")]);
  const next = remoteStream("replacement", [remoteTrack("video"), remoteTrack("audio")]);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next) } });
  try {
    const starting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const publication = socket.sent.at(-1)!.publication as { id: string; roomId: string; kind: "screen"; source: ScreenSource; videoSettings: VideoSettings };
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await starting;
    socket.receive({ type: "state", state: { ...session.getSnapshot().state!, publications: [{ audience: [], title: null, ...publication, paused: false, sessionId: "endpoint", userId: "self" }] } });
    expect(session.sourceAudio(publication.id)).toMatchObject({ level: 1, muted: false, bitrate: 128_000, available: true });
    await session.setSourceAudio(publication.id, { level: 0.5, bitrate: 192_000 });
    expect(contexts[0].gain).toHaveBeenLastCalledWith(0.5, 0, 0.01);
    const pausing = session.setScreenPaused(publication.id, true);
    expect(socket.sent.at(-1)).toMatchObject({ type: "set_paused", publicationId: publication.id, paused: true });
    socket.receive({ type: "state", state: { ...session.getSnapshot().state!, publications: [{ audience: [], title: null, ...publication, paused: true, sessionId: "endpoint", userId: "self" }] } });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await pausing;
    expect(first.getTracks().every(track => !track.enabled)).toBe(true);
    expect(session.getSnapshot().streams.get(publication.id)!.getTracks().every(track => !track.enabled)).toBe(true);
    expect(session.sourceAudio(publication.id)).toMatchObject({ level: 0.5, muted: false, hasAudio: true, available: true });
    expect(contexts[0].gain).toHaveBeenLastCalledWith(0.5, 0, 0.01);
    const originalProfile = session.screenQuality(publication.id)!.applied;
    let applied!: () => void;
    const constraints = vi.fn(async (_value: MediaTrackConstraints) => {});
    constraints.mockImplementationOnce(() => new Promise<void>(resolve => { applied = resolve; }));
    first.getVideoTracks()[0].applyConstraints = constraints;
    const changingQuality = session.setScreenQuality(publication.id, QUALITY_PROFILES["720p30"]);
    expect(session.getSnapshot().pending.has(`quality:${publication.id}`)).toBe(true);
    expect(session.screenQuality(publication.id)?.applied).toEqual(originalProfile);
    expect(session.setScreenQuality(publication.id, QUALITY_PROFILES["1080p30"])).toBe(changingQuality);
    expect(session.setScreenQuality(publication.id, QUALITY_PROFILES["1080p60"])).toBe(changingQuality);
    expect(session.screenQuality(publication.id)?.requested.maxFramerate).toBe(60);
    applied();
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "publish",
      publication: { id: publication.id, videoSettings: screenVideoSettings(QUALITY_PROFILES["720p30"]) } }));
    expect(session.screenQuality(publication.id)?.applied).toEqual(originalProfile);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "publish",
      publication: { id: publication.id, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p60"]) } }));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await changingQuality;
    expect(constraints).toHaveBeenCalledTimes(2);
    expect(constraints).toHaveBeenLastCalledWith({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 60, max: 60 } });
    const liveProfile = { ...QUALITY_PROFILES["1080p60"], maxAudioBitrate: 192_000 };
    expect(session.screenQuality(publication.id)).toEqual({ applied: liveProfile, requested: liveProfile });
    expect(session.getSnapshot().quality).toEqual(liveProfile);
    expect(session.sourceAudio(publication.id)).toMatchObject({ level: 0.5, muted: false, bitrate: 192_000 });
    expect(first.getTracks().every(track => !track.enabled)).toBe(true);
    constraints.mockRejectedValueOnce(new Error("unsupported profile"));
    await expect(session.setScreenQuality(publication.id, QUALITY_PROFILES["720p30"])).rejects.toThrow("unsupported profile");
    expect(session.screenQuality(publication.id)).toEqual({ applied: liveProfile, requested: liveProfile });
    expect(session.getSnapshot().quality).toEqual(liveProfile);
    expect(session.getSnapshot().pending.has(`quality:${publication.id}`)).toBe(false);
    const rejectedMetadata = session.setScreenQuality(publication.id, QUALITY_PROFILES["720p30"]);
    const rejectedMetadataResult = expect(rejectedMetadata).rejects.toThrow("room_unavailable");
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "publish",
      publication: { id: publication.id, videoSettings: screenVideoSettings(QUALITY_PROFILES["720p30"]) } }));
    socket.receive({ type: "error", requestId: socket.sent.at(-1)!.requestId, code: "room_unavailable" });
    await rejectedMetadataResult;
    expect(constraints).toHaveBeenLastCalledWith({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 60, max: 60 } });
    expect(session.screenQuality(publication.id)?.applied).toEqual(liveProfile);
    session.setQuality(QUALITY_PROFILES["720p30"]);
    expect(session.screenQuality(publication.id)?.applied).toEqual(liveProfile);
    await session.setSourceAudio(publication.id, { muted: true });
    expect(contexts[0].gain).toHaveBeenLastCalledWith(0, 0, 0.01);
    expect(first.getVideoTracks()[0].stop).not.toHaveBeenCalled();
    const switching = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("transfer_source"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await ackSourceUpdate(socket); await switching;
    expect(session.sourceAudio(publication.id)).toMatchObject({ level: 0.5, muted: true, bitrate: 192_000 });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].close).not.toHaveBeenCalled();
    expect(first.getAudioTracks()[0].stop).toHaveBeenCalledOnce();
    expect(next.getTracks().every(track => !track.enabled)).toBe(true);
    const resuming = session.setScreenPaused(publication.id, false);
    socket.receive({ type: "state", state: { ...session.getSnapshot().state!, publications: [{ audience: [], title: null, ...publication, paused: false, sessionId: "endpoint", userId: "self" }] } });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await resuming;
    expect(next.getTracks().every(track => track.enabled)).toBe(true);
    await session.setSourceAudio(publication.id, { muted: false });
    expect(contexts[0].gain).toHaveBeenLastCalledWith(0.5, 0, 0.01);
    await expect(session.setSourceAudio(publication.id, { level: 2.01 })).rejects.toThrow("invalid_audio_settings");
    expect(session.getSnapshot().listeningVolume).toBe(1);
    expect(new Set(socket.sent.filter(command => command.type === "publish").map(command => (command.publication as { id: string }).id)))
      .toEqual(new Set([publication.id]));
  } finally {
    session.close();
    expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true);
  }
  expect(next.getAudioTracks()[0].stop).toHaveBeenCalledOnce();
});

test("explicit source audio edits report sender rejection, restore sibling outputs and accept peer ceilings", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  vi.stubGlobal("Audio", RoomAudio);
  vi.stubGlobal("document", { body: { append: vi.fn() }, createElement: vi.fn((tag: string) => new RoomAudio(tag.toUpperCase())) });
  const { session, socket } = await setup(1000, false);
  session.setVideoCodecMode("vp8");
  const firstVideo = remoteTrack("video"), firstAudio = remoteTrack("audio");
  const secondVideo = remoteTrack("video"), secondAudio = remoteTrack("audio");
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn()
    .mockResolvedValueOnce(remoteStream("first", [firstVideo, firstAudio]))
    .mockResolvedValueOnce(remoteStream("second", [secondVideo, secondAudio])) } });
  const state = structuredClone(session.getSnapshot().state!);
  try {
    for (const roomId of ["first", "second"]) {
      const starting = session.startScreen(roomId);
      await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "publish", publication: { roomId } }));
      const request = socket.sent.at(-1)!;
      const publication = request.publication as { id: string; roomId: string; kind: "screen"; source: ScreenSource; videoSettings: VideoSettings };
      socket.receive({ type: "ack", requestId: request.requestId }); await starting;
      state.publications.push({ audience: [], title: null, ...publication, paused: false, sessionId: "endpoint", userId: "self" });
      socket.receive({ type: "state", state });
    }
    const [first, second] = state.publications;
    await session.setSourceAudio(second.id, { bitrate: 96_000 });
    const flow = (id: string, publicationId: string) => ({ id, publicationId, selected: true, inputFlowId: null });
    state.pairs = [
      { id: "first-pair", peerId: "first-peer", canReceiveVideoLayers: false, rooms: ["first", "second"], incoming: [], outgoing: [flow("first-output", first.id), flow("other-source", second.id)] },
      { id: "second-pair", peerId: "second-peer", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [flow("second-output", first.id)] },
    ];
    socket.receive({ type: "state", state });
    const [firstPeer, secondPeer] = RoomPeerConnection.instances;
    const firstSender = firstPeer.senders.find(sender => sender.track === firstAudio)!;
    const secondSender = secondPeer.senders.find(sender => sender.track === firstAudio)!;
    const otherSender = firstPeer.senders.find(sender => sender.track === secondAudio)!;
    const bitrate = (sender: typeof firstSender) => sender.getParameters().encodings[0].maxBitrate;
    await vi.waitFor(() => expect([bitrate(firstSender), bitrate(secondSender), bitrate(otherSender)]).toEqual([128_000, 128_000, 96_000]));
    const before = session.sourceAudio(first.id);
    const rejected = new DOMException("Audio sender rejected update", "OperationError");
    vi.spyOn(firstSender, "setParameters").mockRejectedValueOnce(rejected);
    const sibling = vi.spyOn(secondSender, "setParameters");
    await expect(session.setSourceAudio(first.id, { bitrate: 192_000 })).rejects.toBe(rejected);
    expect(sibling.mock.calls.map(([parameters]) => parameters.encodings[0].maxBitrate)).toEqual([192_000, 128_000]);
    expect([bitrate(firstSender), bitrate(secondSender), bitrate(otherSender)]).toEqual([128_000, 128_000, 96_000]);
    expect(session.sourceAudio(first.id)).toEqual(before);
    expect(session.sourceAudio(second.id)?.bitrate).toBe(96_000);
    expect(session.getSnapshot().error).toBe("OperationError");
    expect(session.getSnapshot().pending.has(`source-audio:${first.id}`)).toBe(false);

    const parameters = firstSender.getParameters.bind(firstSender);
    vi.spyOn(firstSender, "getParameters").mockImplementation(() => ({ ...parameters(), codecs: [
      { payloadType: 111, mimeType: "audio/opus", clockRate: 48_000, channels: 2, sdpFmtpLine: "stereo=1;maxaveragebitrate=64000" },
    ] }));
    await session.setSourceAudio(first.id, { bitrate: 192_000 });
    expect([bitrate(firstSender), bitrate(secondSender), bitrate(otherSender)]).toEqual([64_000, 192_000, 96_000]);
    expect(session.sourceAudio(first.id)?.bitrate).toBe(192_000);
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().ownedScreens).toEqual(new Set([first.id, second.id]));
    for (const peer of [firstPeer, secondPeer]) expect(peer.close).not.toHaveBeenCalled();
    for (const track of [firstVideo, firstAudio, secondVideo, secondAudio]) expect(track.stop).not.toHaveBeenCalled();
    expect(socket.sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
  } finally { session.close(); }
});

test("a late source-ceiling rejection cannot configure a stopped capture or its replacement", async () => {
  const { session, socket } = await setup();
  const previous = remoteTrack("video"), next = remoteTrack("video");
  const previousConstraints = vi.fn(async () => {});
  previous.applyConstraints = previousConstraints;
  next.applyConstraints = vi.fn(async () => {});
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn()
    .mockResolvedValueOnce(remoteStream("old-source", [previous])).mockResolvedValueOnce(remoteStream("new-source", [next])) } });
  try {
    const starting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const first = socket.sent.at(-1)!;
    const id = (first.publication as { id: string }).id;
    socket.receive({ type: "ack", requestId: first.requestId }); await starting;
    const originalCalls = previousConstraints.mock.calls.length;
    const changing = session.setScreenQuality(id, QUALITY_PROFILES["720p30"]);
    const rejected = expect(changing).rejects.toThrow("room_unavailable");
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "publish",
      publication: { id, videoSettings: screenVideoSettings(QUALITY_PROFILES["720p30"]) } }));
    const updating = socket.sent.at(-1)!;
    const stopping = session.stopScreen(id);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await stopping;
    const replacing = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "publish", publication: { id: expect.not.stringMatching(id) } }));
    const replacement = socket.sent.at(-1)!;
    socket.receive({ type: "ack", requestId: replacement.requestId }); await replacing;
    socket.receive({ type: "error", requestId: updating.requestId, code: "room_unavailable" }); await rejected;
    expect(previousConstraints).toHaveBeenCalledTimes(originalCalls + 1);
    expect(next.stop).not.toHaveBeenCalled();
    expect(session.screenQuality(id)).toBeUndefined();
    expect(session.getSnapshot().streams.get((replacement.publication as { id: string }).id)?.getVideoTracks()).toEqual([next]);
  } finally { session.close(); }
});

test("Native capture previews before its snapshot, keeps picture on audio failure, and stops through its App owner", async () => {
  vi.stubGlobal("navigator", { userAgent: "test", userActivation: { isActive: false } });
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
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
    const excluded = { kind: "window" as const, sourceId: "2", title: "Room voice browser", pid: 42, creationTime: "1234" };
    const sources = { sources: [target, excluded], codecs: ["h264", "vp8"], videoAdaptation: true, externalInput: false, processAudio: true, processAudioExclusion: true, systemAudio: true, captureBorderControl: true, activationURL };
    app.receive({ id: app.sent.at(-1)!.id, result: sources });
    await expect(listing).resolves.toEqual(sources);
    const abort = new AbortController();
    const cancelledPreview = session.nativePreview(target, abort.signal);
    const nextPreview = session.nativePreview(target);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("preview"));
    const previewId = app.sent.at(-1)!.id;
    abort.abort();
    expect(app.sent.at(-1)).toMatchObject({ type: "cancel_preview", requestId: previewId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await Promise.resolve();
    expect(app.sent.filter(command => command.type === "preview")).toHaveLength(1);
    const starting = session.startNativeScreen("first", target, true, excluded, true);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    const publicationId = app.sent.at(-1)!.publicationId as string;
    expect(app.sent.at(-1)).toMatchObject({ type: "prepare_capture", publicationId, roomId: "first", target, audio: true, excludeAudio: excluded, showCaptureBorder: true });
    expect(session.nativeCaptureSelection("first")).toBeUndefined();
    expect(session.nativeCaptureRequest("first")).toEqual({ publicationId, activationURL });
    const captureId = crypto.randomUUID(), nativeSessionId = crypto.randomUUID();
    expect(app.sent.at(-1)?.codecMode).toBe("auto");
    app.receive({ id: app.sent.at(-1)!.id, result: { captureId, sessionId: nativeSessionId, codec: "h264" } });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    expect(app.sent.at(-1)).toMatchObject({ publicationId, captureId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("subscribe"));
    expect(session.nativeCaptureRequest("first")).toBeUndefined();
    expect(session.getSnapshot().pending.has("screen:first")).toBe(true);
    const watch = socket.sent.at(-1)!;
    const state = session.getSnapshot().state!;
    socket.receive({ type: "state", state });
    const published = { ...state,
      publications: [{ audience: [], id: publicationId, roomId: "first", sessionId: "native", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }],
      subscriptions: [publicationId],
    };
    socket.receive({ type: "state", state: published });
    socket.receive({ type: "room_reply", roomId: "first", requestId: watch.requestId, result: { type: "done" } });
    await starting;
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    expect(session.getSnapshot().state?.subscriptions).toEqual([publicationId]);
    expect(session.nativeCaptureSelection("first")).toEqual({ target, audio: true, excludeAudio: excluded, showCaptureBorder: true, current: true });

    const microphone = { enabled: false, deviceId: "", volume: 1 };
    app.receive({ type: "capture_audio_state", publicationId, state: { sourceAudio: true, microphone } });
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ browser: false, available: true, ...microphone });
    expect(session.sourceAudio(publicationId)).toMatchObject({ hasAudio: true, available: true });
    for (const error of ["capture_cancelled", "capture_failed"]) {
      const replacement = session.startNativeScreen("first", target, false).catch(error => error);
      await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
      expect(session.nativeCaptureSelection("first")).toEqual({ target, audio: true, excludeAudio: excluded, showCaptureBorder: true, current: true });
      app.receive({ id: app.sent.at(-1)!.id, error });
      await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("cancel_capture"));
      app.receive({ id: app.sent.at(-1)!.id, result: null });
      expect(await replacement).toMatchObject(error === "capture_cancelled" ? { name: "AbortError" } : { message: error });
      expect(session.sourceAudio(publicationId)).toMatchObject({ hasAudio: true, available: true });
      expect(session.nativeCaptureSelection("first")).toEqual({ target, audio: true, excludeAudio: excluded, showCaptureBorder: true, current: true });
      expect(session.getSnapshot().pending.has("screen:first")).toBe(false);
      expect(session.getSnapshot().error).toBe(error === "capture_cancelled" ? null : error);
    }
    const devices = session.sourceMicrophones(publicationId);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("microphones"));
    app.receive({ id: app.sent.at(-1)!.id, result: [{ id: "native-device", label: "Native microphone" }] });
    await expect(devices).resolves.toEqual([{ id: "native-device", label: "Native microphone" }]);
    const enablingMicrophone = session.setSourceMicrophone(publicationId, { enabled: true, deviceId: "native-device" });
    expect(app.sent.at(-1)).toMatchObject({ type: "capture_microphone", publicationId, roomId: "first", captureId,
      settings: { enabled: true, deviceId: "native-device", volume: 1 } });
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ enabled: false, requested: { enabled: true } });
    const enabledMicrophone = { ...microphone, enabled: true, deviceId: "native-device" };
    const revision = session.getSnapshot();
    app.receive({ type: "capture_audio_state", publicationId, state: { sourceAudio: true, microphone: enabledMicrophone } });
    expect(session.getSnapshot()).not.toBe(revision);
    expect(session.sourceMicrophone(publicationId)?.enabled).toBe(true);
    app.receive({ id: app.sent.at(-1)!.id, result: enabledMicrophone }); await enablingMicrophone;
    const failedDevice = session.setSourceMicrophone(publicationId, { deviceId: "missing" });
    app.receive({ id: app.sent.at(-1)!.id, error: "microphone_unavailable" });
    await expect(failedDevice).rejects.toThrow("microphone_unavailable");
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ ...enabledMicrophone, requested: enabledMicrophone });
    const replacingBeforeOff = session.setSourceMicrophone(publicationId, { deviceId: "pending-before-off" });
    const heldMicrophone = app.sent.at(-1)!;
    const immediateOff = session.setSourceMicrophone(publicationId, { enabled: false });
    const immediateOffRequest = app.sent.at(-1)!;
    expect(immediateOffRequest).toMatchObject({ type: "capture_microphone", publicationId, settings: { enabled: false } });
    expect(immediateOffRequest.id).not.toBe(heldMicrophone.id);
    expect(immediateOffRequest.type).not.toBe("cancel_capture");
    app.receive({ id: heldMicrophone.id, error: "capture_cancelled" });
    app.receive({ id: immediateOffRequest.id, result: { ...enabledMicrophone, enabled: false } });
    await vi.waitFor(() => expect(app.sent.at(-1)!.id).not.toBe(immediateOffRequest.id));
    app.receive({ id: app.sent.at(-1)!.id, result: { ...enabledMicrophone, enabled: false } });
    await Promise.all([replacingBeforeOff, immediateOff]);
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ enabled: false });
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    const reenable = session.setSourceMicrophone(publicationId, { enabled: true, deviceId: "native-device" });
    app.receive({ id: app.sent.at(-1)!.id, result: enabledMicrophone }); await reenable;
    const pendingDevice = session.setSourceMicrophone(publicationId, { deviceId: "candidate" });
    const cancelledMicrophone = expect(pendingDevice).rejects.toMatchObject({ name: "AbortError" });
    const candidateRequest = app.sent.at(-1)!;
    expect(session.setSourceMicrophone(publicationId, { volume: .7 })).toBe(pendingDevice);
    const cancellingMicrophone = session.cancelScreenSelection("first");
    expect(app.sent.at(-1)).toMatchObject({ type: "cancel_capture", publicationId });
    const cancelRequest = app.sent.at(-1)!;
    expect(session.setSourceMicrophone(publicationId, { volume: .8 })).toBe(pendingDevice);
    app.receive({ id: candidateRequest.id, error: "capture_cancelled" });
    app.receive({ id: cancelRequest.id, result: null });
    await cancellingMicrophone; await cancelledMicrophone;
    expect(app.sent.at(-1)).toBe(cancelRequest);
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ ...enabledMicrophone, requested: enabledMicrophone });
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    const disablingMicrophone = session.setSourceMicrophone(publicationId, { enabled: false });
    const closingRequest = app.sent.at(-1)!;
    expect(session.setSourceMicrophone(publicationId, { volume: .6 })).toBe(disablingMicrophone);
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ enabled: true, requested: { enabled: false, volume: .6 } });
    app.receive({ id: closingRequest.id, result: { ...enabledMicrophone, enabled: false } });
    await vi.waitFor(() => expect(app.sent.at(-1)!.id).not.toBe(closingRequest.id));
    expect(app.sent.at(-1)).toMatchObject({ type: "capture_microphone", settings: { enabled: false, deviceId: "native-device", volume: .6 } });
    const disabledMicrophone = { ...enabledMicrophone, enabled: false, volume: .6 };
    app.receive({ id: app.sent.at(-1)!.id, result: disabledMicrophone });
    await disablingMicrophone;
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ enabled: false, volume: .6, requested: { enabled: false, volume: .6 } });

    // Starting media did not wait for a cancelled thumbnail's stop/join reply.
    app.receive({ id: previewId, result: null });
    await expect(cancelledPreview).resolves.toBeNull();
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("preview"));
    const image = "data:image/jpeg;base64,/9j/2Q==";
    app.receive({ id: app.sent.at(-1)!.id, result: image });
    await expect(nextPreview).resolves.toBe(image);
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);

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
    app.receive({ type: "input_state", publicationId, state: { ...remote, platform: "linux", canSetStopShortcut: true, stopShortcutLabel: null } });
    await expect(session.inputShortcut(publicationId)).resolves.toEqual({ key: 10, available: false, stopShortcutLabel: null });
    const portalShortcut = session.inputShortcut(publicationId, 10);
    app.receive({ id: app.sent.at(-1)!.id, result: { key: 10, available: true, stopShortcutLabel: "Super + Escape" } });
    await expect(portalShortcut).resolves.toEqual({ key: 10, available: true, stopShortcutLabel: "Super + Escape" });
    await expect(session.inputShortcut(publicationId)).resolves.toEqual({ key: 10, available: true, stopShortcutLabel: "Super + Escape" });
    app.receive({ type: "input_state", publicationId, state: { ...remote, platform: "linux", canSetStopShortcut: true, stopShortcut: 10, stopShortcutLabel: "Shift + Escape" } });
    await expect(session.inputShortcut(publicationId)).resolves.toEqual({ key: 10, available: true, stopShortcutLabel: "Shift + Escape" });
    app.receive({ type: "input_state", publicationId, state: { ...remote, platform: "linux", canSetStopShortcut: true, stopShortcutLabel: null } });
    await expect(session.inputShortcut(publicationId)).resolves.toEqual({ key: 10, available: false, stopShortcutLabel: null });
    const enabling = session.inputPolicy(publicationId, "ask");
    expect(app.sent.at(-1)).toMatchObject({ type: "input_policy", publicationId, captureId, mode: "ask" });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await enabling;
    const approving = session.inputDecide(publicationId, intent, true);
    expect(app.sent.at(-1)).toMatchObject({ type: "input_decide", publicationId, controllerSessionId, intent, allow: true });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await approving;
    expect(socket.sent.some(command => command.type === "input_policy" || command.type === "input_decide")).toBe(false);
    const inputState = session.getSnapshot().remoteControls.get(publicationId);
    for (const paused of [true, false]) {
      const changing = session.setScreenPaused(publicationId, paused);
      expect(app.sent.at(-1)).toMatchObject({ type: "capture_paused", publicationId, captureId, paused });
      app.receive({ id: app.sent.at(-1)!.id, result: null }); await changing;
      socket.receive({ type: "state", state: { ...published, publications: published.publications.map(publication => ({ ...publication, paused })) } });
      expect(session.getSnapshot().remoteControls.get(publicationId)).toBe(inputState);
    }

    const originalProfile = session.screenQuality(publicationId)!.applied;
    const changingQuality = session.setScreenQuality(publicationId, QUALITY_PROFILES["720p30"]);
    expect(app.sent.at(-1)).toMatchObject({ type: "capture_video_settings", publicationId, captureId,
      settings: { width: 1280, height: 720, fps: 30, bitrate: QUALITY_PROFILES["720p30"].maxBitrate } });
    const firstChange = app.sent.at(-1)!;
    expect(session.setScreenQuality(publicationId, QUALITY_PROFILES["1080p30"])).toBe(changingQuality);
    const requestedProfile = { ...QUALITY_PROFILES["1080p60"], degradationPreference: "maintain-framerate" as const };
    expect(session.setScreenQuality(publicationId, requestedProfile)).toBe(changingQuality);
    expect(session.screenQuality(publicationId)?.applied).toEqual(originalProfile);
    app.receive({ id: firstChange.id, result: null });
    await vi.waitFor(() => expect(app.sent.filter(command => command.type === "capture_video_settings")).toHaveLength(2));
    expect(app.sent.at(-1)).toMatchObject({ type: "capture_video_settings", publicationId, captureId,
      settings: { width: 1920, height: 1080, fps: 60, bitrate: requestedProfile.maxBitrate, degradationPreference: requestedProfile.degradationPreference } });
    app.receive({ id: app.sent.at(-1)!.id, result: null }); await changingQuality;
    const liveProfile = session.screenQuality(publicationId)!.applied;
    expect(liveProfile).toMatchObject(requestedProfile);
    expect(session.getSnapshot().quality).toEqual(liveProfile);
    const rejectedQuality = session.setScreenQuality(publicationId, QUALITY_PROFILES["720p30"]);
    app.receive({ id: app.sent.at(-1)!.id, error: "encoder unavailable" });
    await expect(rejectedQuality).rejects.toThrow("encoder unavailable");
    expect(session.screenQuality(publicationId)).toEqual({ applied: liveProfile, requested: liveProfile });
    expect(session.getSnapshot().quality).toEqual(liveProfile);
    expect(session.getSnapshot().remoteControls.get(publicationId)).toBe(inputState);
    expect(app.sent.filter(command => command.type === "prepare_capture")).toHaveLength(3);
    expect(app.sent.filter(command => command.type === "commit_capture")).toHaveLength(1);
    session.clearError();

    app.receive({ type: "capture_audio_failed", publicationId });
    expect(session.getSnapshot().error).toBe("capture_audio_failed");
    app.receive({ type: "capture_audio_state", publicationId, state: { sourceAudio: false, microphone: disabledMicrophone } });
    expect(session.sourceAudio(publicationId)).toMatchObject({ hasAudio: false, available: false });
    expect(session.getSnapshot().appConnected).toBe(true);
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    expect(session.getSnapshot().state?.publications).toEqual(published.publications);
    expect(session.getSnapshot().state?.subscriptions).toEqual([publicationId]);
    expect(app.sent.some(command => command.type === "stop_capture")).toBe(false);
    session.clearError();
    app.receive({ type: "capture_audio_failed", publicationId: crypto.randomUUID() });
    expect(session.getSnapshot().error).toBeNull();

    const heldInput = session.getSnapshot().remoteControls.get(publicationId);
    const routeCommands = [...socket.sent];
    const volumeChange = session.setSourceAudio(publicationId, { level: .7, bitrate: 96_000 });
    app.receive({ id: app.sent.at(-1)!.id, result: null }); await volumeChange;
    const audioTokens = new Set<string>();
    // A selected source keeps its codec when the preview would now prefer VP8.
    vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8", clockRate: 90000 }] }) });
    for (const { audio, exclusion } of [{ audio: false, exclusion: excluded }, { audio: true, exclusion: undefined },
      { audio: true, exclusion: excluded }, { audio: false, exclusion: excluded }]) {
      const previous = session.nativeCaptureSelection("first")!;
      const changing = session.startNativeScreen("first", previous.target, audio, exclusion, previous.showCaptureBorder);
      await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
      expect(app.sent.at(-1)).toMatchObject({ publicationId, audio, target, showCaptureBorder: true,
        audioSettings: { bitrate: 96_000, gain: .7 } });
      expect(app.sent.at(-1)?.codecMode).toBe("h264");
      if (audio && exclusion) expect(app.sent.at(-1)?.excludeAudio).toEqual(exclusion);
      else expect(app.sent.at(-1)).not.toHaveProperty("excludeAudio");
      expect(session.nativeCaptureSelection("first")).toEqual(previous);
      const audioToken = crypto.randomUUID();
      audioTokens.add(audioToken);
      app.receive({ id: app.sent.at(-1)!.id, result: { captureId: audioToken, sessionId: nativeSessionId, codec: "h264" } });
      await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
      expect(app.sent.at(-1)?.captureId).toBe(audioToken);
      app.receive({ id: app.sent.at(-1)!.id, result: null });
      app.receive({ type: "capture_audio_state", publicationId, state: { sourceAudio: audio, microphone: disabledMicrophone } });
      await changing;
      expect(session.nativeCaptureSelection("first")).toEqual({ target, audio, excludeAudio: exclusion, showCaptureBorder: true, current: true });
      expect(session.getSnapshot().remoteControls.get(publicationId)).toEqual(heldInput);
      expect(session.sourceAudio(publicationId)).toMatchObject({ hasAudio: audio, available: audio });
      expect(socket.sent).toEqual(routeCommands);
    }
    expect(audioTokens.size).toBe(4);
    app.receive({ type: "input_state", publicationId, state: { ...remote, requests: [] } });
    expect(session.getSnapshot().remoteControls.get(publicationId)?.requests).toEqual([]);

    const pendingMicrophone = session.setSourceMicrophone(publicationId, { enabled: true });
    expect(session.sourceAudio(publicationId)).toMatchObject({ hasAudio: false, available: false });
    app.receive({ id: app.sent.at(-1)!.id, result: enabledMicrophone });
    await pendingMicrophone;
    expect(session.sourceAudio(publicationId)).toMatchObject({ hasAudio: true, available: true });
    const pendingReplacement = session.setSourceMicrophone(publicationId, { deviceId: "candidate" });
    const interruptedMicrophone = expect(pendingReplacement).rejects.toMatchObject({ name: "AbortError" });
    const microphoneRequest = app.sent.at(-1)!;
    const stopping = session.stopScreen(publicationId);
    expect(app.sent.at(-1)).toMatchObject({ type: "stop_capture", publicationId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    app.receive({ id: microphoneRequest.id, result: enabledMicrophone });
    await interruptedMicrophone;
    socket.receive({ type: "state", state });
    await stopping;
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    expect(session.getSnapshot().remoteControls.size).toBe(0);
    app.receive({ type: "capture_audio_state", publicationId, state: { sourceAudio: true, microphone: enabledMicrophone } });
    expect(session.sourceAudio(publicationId)).toBeUndefined();
    expect(socket.sent.some(command => command.type === "unpublish")).toBe(false);
    session.close();
    expect(app.readyState).toBe(3);
    expect(socket.sent.some(command => command.type === "host_stop")).toBe(false);
  } finally { session.close(); }
});

test.each(["before-subscribe", "awaiting-ack", "helper-awaiting-ack"])("committed Native preview resumes its watch intent after Domain recovery (%s)", async interrupted => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const nativeSessionId = crypto.randomUUID();
  vi.spyOn(appLink.ChannelApp.prototype, "describeHosting").mockResolvedValue({ sessionId: nativeSessionId, roomIds: ["first"] });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const starting = session.startNativeScreen("first", { kind: "picker", sourceId: "", title: "System picker" }).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    const publicationId = app.sent.at(-1)!.publicationId as string;
    app.receive({ id: app.sent.at(-1)!.id, result: { captureId: crypto.randomUUID(), sessionId: nativeSessionId, codec: "h264" } });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    const committed = app.sent.at(-1)!;
    const state = structuredClone(session.getSnapshot().state!);
    state.publications = [{ audience: [], id: publicationId, roomId: "first", sessionId: nativeSessionId, userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null,
      videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }];
    socket.receive({ type: "state", state });
    if (interrupted === "before-subscribe") socket.close();
    app.receive({ id: committed.id, result: null });
    if (interrupted !== "before-subscribe") {
      await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", publicationId, enabled: true }));
      state.subscriptions = [publicationId];
      socket.receive({ type: "state", state });
      if (interrupted === "helper-awaiting-ack") {
        socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
        expect(await starting).toBeUndefined();
        await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", helperSessionId: nativeSessionId }));
      }
      socket.close();
    }
    expect(await starting).toBeUndefined();
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    await vi.waitFor(() => expect(resumed.sent).toContainEqual(expect.objectContaining({
      type: "subscribe", publicationId, enabled: true,
      ...(interrupted === "helper-awaiting-ack" ? { helperSessionId: nativeSessionId } : {}),
    })));
    for (const command of resumed.sent.filter(command => command.type === "subscribe")) {
      expect(command.enabled).toBe(true);
      if (interrupted === "helper-awaiting-ack") expect(command.helperSessionId).toBe(nativeSessionId);
      resumed.receive({ type: "ack", requestId: command.requestId });
    }
    expect(app.sent.filter(command => command.type === "prepare_capture")).toHaveLength(1);
    expect(app.sent.filter(command => command.type === "commit_capture")).toHaveLength(1);
    expect(app.sent.some(command => command.type === "stop_capture" || command.type === "cancel_capture")).toBe(false);
    expect(session.getSnapshot().error).toBeNull();
  } finally { session.close(); }
});

test.each([
  ["domain-first", false], ["domain-first", true], ["app-first", false], ["app-first", true],
] as const)("Native completion preserves replacement ownership and reports only current failures (%s, failed=%s)", async (order, failed) => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  vi.spyOn(appLink.ChannelApp.prototype, "describeHosting").mockRejectedValue(new Error("Assistance unavailable"));
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const target = { kind: "picker" as const, sourceId: "1", title: "System picker" };
    const sources = session.nativeSources();
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("targets"));
    app.receive({ id: app.sent.at(-1)!.id, result: { sources: [target], codecs: ["h264"], videoAdaptation: true, externalInput: false, processAudio: false, processAudioExclusion: false, systemAudio: false, captureBorderControl: false, activationURL: "piik://media" } });
    await sources;
    const nativeSessionId = crypto.randomUUID(), oldCaptureId = crypto.randomUUID(), captureId = crypto.randomUUID();
    const starting = session.startNativeScreen("first", target);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    const publicationId = app.sent.at(-1)!.publicationId as string;
    app.receive({ id: app.sent.at(-1)!.id, result: { captureId: oldCaptureId, sessionId: nativeSessionId, codec: "h264" } });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("subscribe"));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await starting;
    const empty = structuredClone(session.getSnapshot().state!);
    const published = { ...empty, publications: [{ audience: [], id: publicationId, roomId: "first", sessionId: nativeSessionId, userId: "self",
      kind: "screen" as const, source: { kind: "screen" as const, name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }], subscriptions: [publicationId] };
    socket.receive({ type: "state", state: published });

    const replacing = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    const prepare = app.sent.at(-1)!;
    socket.receive({ type: "state", state: empty });
    app.receive({ type: "capture_ended", publicationId, captureId: oldCaptureId, failed: false });
    expect(session.nativeCaptureRequest("first")?.publicationId).toBe(publicationId);
    expect(app.sent.some(command => command.type === "stop_capture" || command.type === "cancel_capture")).toBe(false);
    app.receive({ id: prepare.id, result: { captureId, sessionId: nativeSessionId, codec: "h264" } });
    await vi.waitFor(() => expect(app.sent.at(-1)).toMatchObject({ type: "commit_capture", captureId }));
    const previousWatch = socket.sent.findLast(command => command.type === "subscribe")!.requestId;
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => {
      expect(socket.sent.at(-1)?.type).toBe("subscribe");
      expect(socket.sent.at(-1)?.requestId).not.toBe(previousWatch);
    });
    socket.receive({ type: "state", state: published });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    expect(await replacing).toBeUndefined();
    app.receive({ type: "capture_ended", publicationId, captureId: oldCaptureId, failed: true });
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    expect(session.getSnapshot().error).toBeNull();

    if (order === "domain-first") socket.receive({ type: "state", state: empty });
    app.receive({ type: "capture_ended", publicationId, captureId, failed });
    if (order === "app-first") socket.receive({ type: "state", state: empty });
    expect(session.getSnapshot().error).toBe(failed ? "capture_failed" : null);
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(false);
    expect(session.nativeCaptureSelection("first")).toBeUndefined();
    expect(session.getSnapshot().appConnected).toBe(true);
    expect(app.sent.some(command => command.type === "stop_capture" || command.type === "cancel_capture")).toBe(false);
  } finally { session.close(); }
});

test("stopping committed Native capture retires its pending automatic preview error", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const target = { kind: "display" as const, sourceId: "1", title: "Test display" };
    const starting = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    const publicationId = app.sent.at(-1)!.publicationId as string;
    const captureId = crypto.randomUUID();
    app.receive({ id: app.sent.at(-1)!.id, result: { captureId, sessionId: crypto.randomUUID(), codec: "h264" } });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("subscribe"));
    const preview = socket.sent.at(-1)!;

    const stopping = session.stopScreen(publicationId);
    expect(app.sent.at(-1)).toMatchObject({ type: "stop_capture", publicationId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await stopping;
    expect(session.getSnapshot().error).toBeNull();
    socket.receive({ type: "error", requestId: preview.requestId, code: "unknown_publication" });
    expect(await starting).toMatchObject({ name: "AbortError" });
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    expect(session.getSnapshot().pending.size).toBe(0);
    expect(app.sent.filter(command => command.type === "stop_capture")).toHaveLength(1);
    expect(socket.sent.filter(command => command.type === "subscribe")).toHaveLength(1);
  } finally { session.close(); }
});

test("pending Native capture stays page-owned through same-page stop and close", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  try {
    await app.onopen?.();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const target = { kind: "display" as const, sourceId: "1", title: "Test display" };
    const activationURL = "intent://media#Intent;scheme=piik;package=tv.piik.android.test;end";
    const sources = { sources: [target], codecs: ["h264", "vp8"], videoAdaptation: true, externalInput: false, processAudio: false, processAudioExclusion: false, systemAudio: true, captureBorderControl: false, activationURL };
    const capabilities = session.nativeSources();
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("targets"));
    app.receive({ id: app.sent.at(-1)!.id, result: sources });
    await capabilities;
    const rejectedExclusion = { kind: "window" as const, sourceId: "2", title: "Unavailable exclusion", pid: 42, creationTime: "1234" };
    await expect(session.startNativeScreen("first", target, true, rejectedExclusion)).rejects.toThrow("audio exclusion unavailable");
    expect(app.sent.some(command => command.type === "prepare_capture")).toBe(false);
    const activate = vi.spyOn(nativeActivation, "activateNativePicker").mockImplementation(() => {
      expect(app.sent.at(-1)?.type).toBe("prepare_capture");
    });
    const starting = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
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
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    app.receive({ id: app.sent.at(-1)!.id, error: "capture_failed" });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("cancel_capture"));
    expect(session.nativeCaptureRequest("first")).toBeUndefined();
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    expect((await failed).message).toBe("capture_failed");

    const closing = session.startNativeScreen("first", target).catch(error => error);
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    expect(session.getSnapshot().ownedScreens.size).toBe(1);
    session.close();
    expect((await closing).message).toBe("app_disconnected");
    expect(app.readyState).toBe(3);
    expect(session.getSnapshot().ownedScreens.size).toBe(0);
    expect(session.nativeCaptureRequest("first")).toBeUndefined();
  } finally { session.close(); }
});

test("external input keeps its waiting activity while each prepared stream uses the existing commit path", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL,
    domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const { session, socket } = await setup();
  const app = ChannelSocket.current;
  const watch = vi.spyOn(session, "watch").mockResolvedValue();
  try {
    await app.onopen?.(); app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const opening = session.startExternalScreen("first");
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_external_input"));
    const request = app.sent.at(-1)!, publicationId = request.publicationId as string;
    app.receive({ id: request.id, result: { endpoint: "http://127.0.0.1:8793/whip/owned-input", token: "synthetic-input-token" } });
    await opening;
    expect(session.externalInput("first")).toMatchObject({ publicationId, state: "waiting" });
    expect(watch).not.toHaveBeenCalled();
    expect(socket.sent.some(command => command.type === "publish")).toBe(false);
    const captureId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    app.receive({ type: "external_input_state", publicationId, state: "prepared", captureId, sessionId, codec: "h264" });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    expect(app.sent.at(-1)).toMatchObject({ publicationId, captureId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(publicationId, "first"));
    app.receive({ type: "external_input_state", publicationId, state: "live", captureId, sessionId, codec: "h264" });
    expect(session.externalInput("first")?.state).toBe("live");
    app.receive({ type: "external_input_state", publicationId, state: "waiting" });
    expect(session.externalInput("first")?.state).toBe("waiting");
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(true);
    const stopping = session.stopScreen(publicationId);
    expect(app.sent.at(-1)).toMatchObject({ type: "stop_capture", publicationId });
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await stopping;
    expect(session.externalInput("first")).toBeUndefined();
    expect(session.getSnapshot().ownedScreens.has(publicationId)).toBe(false);
  } finally { session.close(); }
});

test("arming OBS preserves the current capture controls until the external source commits", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL,
    domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const { session } = await setup();
  const app = ChannelSocket.current;
  vi.spyOn(session, "watch").mockResolvedValue();
  try {
    await app.onopen?.(); app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const starting = session.startNativeScreen("first", { kind: "display", sourceId: "1", title: "Owned capture" });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_capture"));
    const request = app.sent.at(-1)!, publicationId = request.publicationId as string;
    const sessionId = crypto.randomUUID(), original = crypto.randomUUID();
    app.receive({ id: request.id, result: { captureId: original, sessionId, codec: "h264" } });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    app.receive({ id: app.sent.at(-1)!.id, result: null }); await starting;
    app.receive({ type: "capture_audio_state", publicationId, state: { sourceAudio: true,
      microphone: { enabled: true, deviceId: "owned-microphone", volume: 1 } } });
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ enabled: true, available: true });
    const opening = session.startExternalScreen("first");
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("prepare_external_input"));
    app.receive({ id: app.sent.at(-1)!.id, result: { endpoint: "http://127.0.0.1:8793/whip/owned-input", token: "synthetic-input-token" } });
    await opening;
    expect(session.sourceMicrophone(publicationId)).toMatchObject({ enabled: true, available: true });
    const external = crypto.randomUUID();
    app.receive({ type: "external_input_state", publicationId, state: "prepared", captureId: external, sessionId, codec: "h264" });
    await vi.waitFor(() => expect(app.sent.at(-1)?.type).toBe("commit_capture"));
    app.receive({ id: app.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.sourceMicrophone(publicationId)).toMatchObject({ enabled: false, available: false }));
    expect(session.sourceAudio(publicationId)).toMatchObject({ hasAudio: false, canMute: false });
  } finally { session.close(); }
});

function acceptCreatedRoom(socket: ChannelSocket): void {
  const request = socket.sent.findLast(command => command.type === "create_room")!;
  expect(request.type).toBe("create_room");
  socket.receive({ type: "room_created", requestId: request.requestId,
    room: { ...(request.room as object), id: "domain-created-room" } });
}

test("same-session recovery retires its own host binding when the committed room policy is gone", async () => {
  const policy = JSON.stringify({ id: "first", creatorId: "self", name: "First", icon: "couch", access: "public", hidden: false });
  let policies = [policy];
  const host = { roomId: "first", summary: () => ({ ...JSON.parse(policy), hasPassword: false }), bind: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  vi.stubGlobal("indexedDB", {});
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ BrowserRoomHost: { storedPolicies: async () => policies, open: async () => host } } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const { session, socket } = await setup();
  try {
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "host_register")).toBe(true));
    const registration = socket.sent.find(command => command.type === "host_register")!;
    socket.receive({ type: "host_bound", roomId: "first", bindingId: "owned-binding" });
    socket.receive({ type: "ack", requestId: registration.requestId });
    const retained = structuredClone(session.getSnapshot().state!);
    retained.channel.rooms[0].delivery = { hostSessionId: "endpoint", bindingId: "owned-binding", nextHops: {} };
    policies = [];
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state: retained });
    await vi.waitFor(() => expect(resumed.sent.some(command => command.type === "host_stop" && command.roomId === "first" && command.bindingId === "owned-binding")).toBe(true));
    expect(host.close).toHaveBeenCalledOnce();
    expect(resumed.sent.some(command => command.type === "host_register")).toBe(false);
  } finally { session.close(); }
});

test("a room hosted by another page cannot block this page's other rooms from resuming", async () => {
  const policy = (id: string) => ({ id, creatorId: "self", name: id, icon: "couch", access: "public", hidden: false });
  let policies = [JSON.stringify(policy("second"))];
  const hosts = new Map(["first", "second"].map(id => [id, {
    roomId: id, summary: () => policy(id), close: vi.fn(async () => {}), bind: vi.fn(async () => {}),
  }]));
  vi.stubGlobal("indexedDB", {});
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ BrowserRoomHost: {
    storedPolicies: async () => policies,
    open: async (_database: string, value: string) => hosts.get(JSON.parse(value).id),
  } } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const { session, socket } = await setup();
  try {
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === "host_register")).toBe(true));
    const register = socket.sent.find(command => command.type === "host_register")!;
    socket.receive({ type: "host_bound", roomId: "second", bindingId: "own-binding" });
    socket.receive({ type: "ack", requestId: register.requestId });
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].delivery = { hostSessionId: "other-page", bindingId: "other-binding", nextHops: {} };
    state.channel.rooms[1].delivery = { hostSessionId: "endpoint", bindingId: "own-binding", nextHops: {} };
    policies = [JSON.stringify(policy("first")), JSON.stringify(policy("second"))];
    session.reconnect();
    const resumed = ChannelSocket.current; await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    await vi.waitFor(() => expect(resumed.sent.some(command => command.type === "host_register")).toBe(true));
    const conflict = resumed.sent.find(command => command.type === "host_register")!;
    expect(conflict.room).toMatchObject({ id: "first" });
    resumed.receive({ type: "error", requestId: conflict.requestId, code: "room_already_hosted" });
    await vi.waitFor(() => expect(resumed.sent.filter(command => command.type === "host_register")).toHaveLength(2));
    const own = resumed.sent.findLast(command => command.type === "host_register")!;
    expect(own).toMatchObject({ room: { id: "second" }, resumeBinding: "own-binding" });
    resumed.receive({ type: "host_bound", roomId: "second", bindingId: "own-binding" });
    resumed.receive({ type: "ack", requestId: own.requestId });
    expect(hosts.get("first")!.close).toHaveBeenCalledOnce();
    expect(hosts.get("second")!.close).not.toHaveBeenCalled();
    expect(resumed.sent.some(command => command.type === "host_stop")).toBe(false);
    expect(session.getSnapshot().error).toBeNull();
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
    acceptCreatedRoom(socket);
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
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
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
    acceptCreatedRoom(socket);
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
    acceptCreatedRoom(socket);
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

test("publication metadata keeps the video ceiling and source preference together and excludes voice", () => {
  const base = { audience: [], id: "source", roomId: "room", sessionId: "endpoint", userId: "self", paused: false };
  const profile = QUALITY_PROFILES["1080p30"];
  const videoSettings = { ...screenVideoSettings(profile), ceiling: { ...screenVideoSettings(profile).ceiling, maxFramerate: 29.97 } };
  expect(publicationSchema.parse({ ...base, kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings }).videoSettings).toEqual(videoSettings);
  expect(publicationSchema.parse({ ...base, kind: "screen", source: { kind: "screen" as const, name: null }, title: null }).videoSettings).toBeUndefined();
  expect(publicationSchema.safeParse({ ...base, kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: { ceiling: videoSettings.ceiling } }).success).toBe(false);
  expect(publicationSchema.safeParse({ ...base, kind: "voice", videoSettings }).success).toBe(false);
  expect(publicationSchema.safeParse({ ...base, kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: { ...videoSettings, maxAudioBitrate: 128_000 } }).success).toBe(false);
  expect(publicationSchema.parse({ ...base, kind: "voice" }).videoSettings).toBeUndefined();
  const { audience: _audience, ...missingAudience } = base;
  expect(publicationSchema.safeParse({ ...missingAudience, kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings }).success).toBe(false);
  expect(publicationSchema.safeParse({ ...base, kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings, audience: [{ sessionId: "endpoint", state: "connected" }] }).success).toBe(false);
  expect(publicationSchema.safeParse({ ...base, kind: "voice", audience: [{ sessionId: "endpoint", state: "active" }] }).success).toBe(false);
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

test("local room management failures preserve capture errors while voice settings still report globally", async () => {
  const { session, socket } = await setup();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error("capture_failed")) } });
  try {
    await expect(session.startScreen("first", "camera")).rejects.toThrow("capture_failed");
    expect(session.getSnapshot().error).toBe("capture_failed");

    const saving = session.updateRoom("second", { name: "Saved", icon: "couch", access: "public", hidden: false }, false);
    const rejected = expect(saving).rejects.toThrow("room_host_offline");
    const request = socket.sent.at(-1)!;
    expect(request).toMatchObject({ type: "update_room", roomId: "second", name: "Saved" });
    expect(session.getSnapshot().pending.has("room:second")).toBe(true);
    expect(session.getSnapshot().error).toBe("capture_failed");
    socket.receive({ type: "room_reply", roomId: "second", requestId: request.requestId,
      result: { type: "error", code: "room_host_offline" } });
    await rejected;
    expect(session.getSnapshot().error).toBe("capture_failed");
    expect(session.getSnapshot().pending.has("room:second")).toBe(false);

    const voiceSettings = session.setRoomVoiceBitrate("first", 96_000);
    const voiceRejected = expect(voiceSettings).rejects.toThrow("forbidden");
    const voiceRequest = socket.sent.at(-1)!;
    expect(voiceRequest).toMatchObject({ type: "update_room", roomId: "first", voiceBitrate: 96_000 });
    expect(session.getSnapshot().error).toBeNull();
    socket.receive({ type: "error", requestId: voiceRequest.requestId, code: "forbidden" });
    await voiceRejected;
    expect(session.getSnapshot().error).toBe("forbidden");
    expect(session.getSnapshot().pending.has("room:first")).toBe(false);
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
    for (const deleteData of [false, true]) {
      const deleting = session.deleteRoom("first", deleteData);
      const request = socket.sent.at(-1)!;
      expect(request).toMatchObject({ type: "delete_room", roomId: "first", deleteData });
      socket.receive({ type: "room_reply", roomId: "second", requestId: request.requestId, result: { type: "deleted", dataRemoved: true } });
      expect(session.getSnapshot().pending.has("delete:first")).toBe(true);
      socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId, result: { type: "deleted", dataRemoved: deleteData } });
      await expect(deleting).resolves.toEqual({ dataRemoved: deleteData });
    }
    const updating = session.updateRoom("first", { name: "Unavailable", icon: "couch", access: "public", hidden: false });
    const rejected = expect(updating).rejects.toThrow("room_host_offline");
    socket.receive({ type: "room_reply", roomId: "first", requestId: socket.sent.at(-1)!.requestId,
      result: { type: "error", code: "room_host_offline" } });
    await rejected;
  } finally { session.close(); }
});

const topologyResponse = () => ({ bindingId: "binding",
  base: { rootSessionId: "host", edges: [{ sender: "host", receiver: "endpoint", ready: false }] },
  screen: { publicationId: "screen", sourceSessionId: "source", edges: [
    { sender: "source", receiver: "endpoint", selected: true, proof: null, presented: null, presentation: false },
    { sender: "helper", receiver: "endpoint", selected: false, proof: "decoded", presented: false, presentation: true },
  ] },
});

test("topology reads use the Domain reply owner without room activities or media commands", async () => {
  const { session, socket, peer } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.publications.push({ audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false });
    socket.receive({ type: "state", state });
    const before = session.getSnapshot(), sent = socket.sent.length;
    let settled = false;
    const reading = session.roomTopology("first", "screen").then(result => { settled = true; return result; });
    const request = socket.sent.at(-1)!;
    expect(request).toEqual({ type: "room_topology", roomId: "first", publicationId: "screen", requestId: expect.any(String) });
    expect(socket.sent.slice(sent)).toHaveLength(1);
    expect(peer.sent).toHaveLength(0);
    expect(session.getSnapshot().pending).toEqual(before.pending);
    socket.receive({ type: "room_reply", roomId: "second", requestId: request.requestId,
      result: { type: "topology", topology: topologyResponse() } });
    await Promise.resolve(); expect(settled).toBe(false);
    socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId,
      result: { type: "topology", topology: topologyResponse() } });
    await expect(reading).resolves.toEqual(topologyResponse());
    expect(session.getSnapshot().state).toEqual(before.state);
    expect(session.getSnapshot().error).toBeNull();
  } finally { session.close(); }
});

test("topology parsing and server refusal reject only the read", async () => {
  const { session, socket } = await setup();
  try {
    for (const result of [
      { type: "topology", topology: { bindingId: "binding", base: { rootSessionId: "host", edges: [] }, screen: null, address: "private" } },
      { type: "topology", topology: { bindingId: "old-binding", base: { rootSessionId: "host", edges: [] }, screen: null } },
      { type: "error", code: "room_access_required" },
    ]) {
      const reading = session.roomTopology("first"), rejected = expect(reading).rejects.toThrow();
      socket.receive({ type: "room_reply", roomId: "first", requestId: socket.sent.at(-1)!.requestId, result });
      await rejected;
      expect(session.getSnapshot()).toMatchObject({ connection: "connected", error: null });
    }
  } finally { session.close(); }
});

test("topology read abort and close retire requests without a late error banner", async () => {
  const { session, socket } = await setup();
  const resetMedia = vi.spyOn(ChannelMedia.prototype, "reset");
  try {
    const controller = new AbortController();
    const reading = session.roomTopology("first", undefined, controller.signal);
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    const request = socket.sent.at(-1)!;
    controller.abort(); await rejected;
    socket.receive({ type: "error", requestId: request.requestId, code: "room_unavailable" });
    expect(resetMedia).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", error: null });
    const closing = session.roomTopology("first"), closed = expect(closing).rejects.toThrow("closed");
    session.close(); await closed;
  } finally { session.close(); }
});

test("topology reads reject late data after binding access account or selection changes", async () => {
  for (const change of ["binding", "access", "account", "selection", "publication"] as const) {
    const { session, socket } = await setup();
    try {
      const initial = structuredClone(session.getSnapshot().state!);
      initial.publications.push({ audience: [], id: "screen", roomId: "first", sessionId: "source", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false });
      socket.receive({ type: "state", state: initial });
      const reading = session.roomTopology("first", "screen"), rejected = expect(reading).rejects.toThrow();
      const request = socket.sent.at(-1)!;
      const state = structuredClone(initial);
      if (change === "binding") state.channel.rooms[0].delivery!.bindingId = "replacement";
      else if (change === "access") state.channel.rooms[0].authorized = false;
      else if (change === "account") {
        state.sessions[0].userId = "replacement-user";
        state.users = [{ id: "replacement-user", name: "Other account", version: profileVersion }];
      }
      else if (change === "publication") state.publications = [];
      if (change === "selection") session.browse("second");
      else socket.receive({ type: "state", state });
      socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId,
        result: { type: "topology", topology: topologyResponse() } });
      await rejected;
      expect(session.getSnapshot().error).toBeNull();
    } finally { session.close(); }
  }
});

test("connection metrics bridge returns only the Browser media owner's current observation", async () => {
  const { session } = await setup();
  try {
    const metrics = vi.spyOn(ChannelMedia.prototype, "connectionMetrics").mockResolvedValue([]);
    await expect(session.connectionMetrics("first", "screen")).resolves.toEqual([]);
    expect(metrics).toHaveBeenCalledExactlyOnceWith("first", "screen");
  } finally { session.close(); }
});

test("room voice settings use the managed room update without changing local input or listening", async () => {
  const { session, socket } = await setup();
  try {
    const previous = session.getSnapshot();
    const saving = session.setRoomVoiceBitrate("first", 96_000);
    const request = socket.sent.at(-1)!;
    expect(request).toMatchObject({ type: "update_room", roomId: "first", voiceBitrate: 96_000 });
    socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId, result: { type: "done" } });
    await saving;
    expect(session.getSnapshot().voiceInput).toEqual(previous.voiceInput);
    expect(session.getSnapshot().listeningVolume).toBe(previous.listeningVolume);
    await expect(session.setRoomVoiceBitrate("first", 320_001)).rejects.toThrow("invalid_audio_bitrate");
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].canManage = false;
    socket.receive({ type: "state", state });
    await expect(session.setRoomVoiceBitrate("first", 32_000)).rejects.toThrow("forbidden");
    expect(socket.sent.filter(command => command.type === "update_room")).toHaveLength(1);
  } finally { session.close(); }
});

test("automatic audio ceilings isolate room voice and tolerate a source sender rejection", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const transport = new ChannelTransport({ polite: true, iceServers: [],
    send() {}, receive() {}, connected() {}, base() {}, failed() {} });
  const pc = RoomPeerConnection.instances[0];
  const voice = remoteStream("voice", [remoteTrack("audio")]);
  const screen = remoteStream("source", [remoteTrack("audio")]);
  const update = (voiceBitrate: number, audioBitrate = 192_000) => transport.setOutgoing(new Map([
    ["voice", { kind: "voice", stream: voice, voiceBitrate }],
    ["screen", { kind: "screen", stream: screen, profile: QUALITY_PROFILES["1080p30"], audioBitrate }],
  ]));
  try {
    update(96_000);
    await vi.waitFor(() => expect(pc.senders.map(sender => sender.getParameters().encodings[0].maxBitrate)).toEqual([96_000, 192_000]));
    const senders = [...pc.senders];
    update(32_000);
    await vi.waitFor(() => expect(pc.senders[0].getParameters().encodings[0].maxBitrate).toBe(32_000));
    expect(pc.senders).toEqual(senders);
    expect(senders[0].replaceTrack).not.toHaveBeenCalled();
    expect(senders[1].getParameters().encodings[0].maxBitrate).toBe(192_000);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejected = new DOMException("Automatic audio settings rejected", "OperationError");
    vi.spyOn(senders[1], "setParameters").mockRejectedValueOnce(rejected);
    update(32_000, 96_000);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("Channel audio bitrate could not be applied", { flowId: "screen" }, rejected));
    expect(senders.map(sender => sender.getParameters().encodings[0].maxBitrate)).toEqual([32_000, 192_000]);
    expect(pc.senders).toEqual(senders);
    expect(pc.close).not.toHaveBeenCalled();
  } finally { transport.close(); }
});

test("authoritative sender pause retains tracks, layer choices and independent room voice", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const transport = new ChannelTransport({ polite: true, iceServers: [], canReceiveVideoLayers: true,
    send() {}, receive() {}, connected() {}, base() {}, failed() {} });
  const pc = RoomPeerConnection.instances[0];
  const screen = remoteStream("paused-source", [remoteTrack("video"), remoteTrack("audio")]);
  const voice = remoteStream("voice", [remoteTrack("audio")]);
  const update = (paused: boolean) => transport.setOutgoing(new Map([
    ["screen", { kind: "screen", stream: screen, paused, profile: QUALITY_PROFILES["1080p30"] }],
    ["voice", { kind: "voice", stream: voice, voiceBitrate: 96_000 }],
  ]));
  try {
    update(false);
    await vi.waitFor(() => expect(pc.senders[2].getParameters().encodings[0].maxBitrate).toBe(96_000));
    const senders = [...pc.senders];
    const parameters = senders[0].getParameters();
    parameters.encodings[0].active = false;
    parameters.encodings[1].active = true;
    await senders[0].setParameters(parameters);
    let releaseProfile!: () => void;
    const applyParameters = senders[0].setParameters.bind(senders[0]);
    vi.spyOn(senders[0], "setParameters").mockImplementationOnce(async next => {
      await new Promise<void>(resolve => { releaseProfile = resolve; });
      return applyParameters(next);
    });
    const configuring = transport.configureVideo("screen", { ...QUALITY_PROFILES["1080p30"], maxBitrate: 7_000_000 });
    await vi.waitFor(() => expect(releaseProfile).toBeTypeOf("function"));
    update(true);
    expect(senders[0].track?.enabled).toBe(false);
    releaseProfile(); await configuring;
    await vi.waitFor(() => expect(senders.slice(0, 2).flatMap(sender => sender.getParameters().encodings.map(e => e.active))).toEqual([false, false, false]));
    expect(senders[2].getParameters().encodings[0].active).not.toBe(false);
    update(false);
    await vi.waitFor(() => expect(senders.slice(0, 2).flatMap(sender => sender.getParameters().encodings.map(e => e.active))).toEqual([false, true, true]));
    expect(pc.senders).toEqual(senders);
    for (const sender of senders) expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(pc.close).not.toHaveBeenCalled();
    for (const track of screen.getTracks()) expect(track.stop).not.toHaveBeenCalled();
  } finally { transport.close(); }
});

test("a reused sender waits for negotiated encodings before audio limits and pause are applied", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const transport = new ChannelTransport({ polite: true, iceServers: [],
    send() {}, receive() {}, connected() {}, base() {}, failed() {} });
  const pc = RoomPeerConnection.instances[0];
  const add = pc.addTrack.bind(pc);
  let negotiated = false;
  vi.spyOn(pc, "addTrack").mockImplementation((track, stream) => {
    const sender = add(track, stream), parameters = sender.getParameters.bind(sender);
    sender.getParameters = () => negotiated ? parameters() : { encodings: [], codecs: [] } as unknown as RTCRtpSendParameters;
    return sender;
  });
  const install = pc.setLocalDescription.bind(pc);
  vi.spyOn(pc, "setLocalDescription").mockImplementation(async description => { await install(description); negotiated = true; });
  try {
    transport.setOutgoing(new Map([["screen", { audience: [], kind: "screen", stream: remoteStream("reused-audio", [remoteTrack("audio")]), paused: true,
      profile: QUALITY_PROFILES["1080p30"], audioBitrate: 192_000 }]]));
    const sender = pc.senders[0], set = vi.spyOn(sender, "setParameters");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(set).not.toHaveBeenCalled();
    transport.signal({ exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "renegotiated" }, tracks: [] });
    await vi.waitFor(() => expect(sender.getParameters().encodings[0]).toMatchObject({ maxBitrate: 192_000, active: false }));
    expect(warning).not.toHaveBeenCalled();
    expect(pc.senders).toEqual([sender]);
  } finally { transport.close(); }
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

test.each([
  ["older", [message(1)], message(2)],
  ["empty", [], undefined],
] as const)("a fresh host binding replaces cached history with its %s head", async (_head, messages, live) => {
  const { session, socket, peer } = await setup();
  try {
    await peer.history([{ ...message(1), reactions: { revision: 7, counts: { heart: 7 } } }, message(8), message(9)], true);
    peer.live(message(7), "second");
    const loading = session.loadHistory("first");
    const cancelled = expect(loading).rejects.toThrow("room_unavailable");
    const oldRead = await peer.next();
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].delivery!.bindingId = "restored-binding";
    socket.receive({ type: "state", state });
    await cancelled;
    expect(session.getSnapshot().messagesByRoom.first).toBeUndefined();
    expect(session.getSnapshot().historyByRoom.first).toBeUndefined();
    expect(session.getSnapshot().messagesByRoom.second).toEqual([message(7)]);
    peer.page(oldRead, [message(5)], true);
    expect(session.getSnapshot().messagesByRoom.first).toBeUndefined();
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    const refreshed = await peer.next();
    expect(refreshed).toMatchObject({ type: "history", roomId: "first" });
    expect(refreshed).not.toHaveProperty("before");
    if (live) peer.live(live, "first", "restored-binding");
    peer.page(refreshed, [...messages], false, messages[0]?.seq ?? null, "restored-binding");
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:first")).toBe(false));
    expect(session.getSnapshot().messagesByRoom.first).toEqual([...messages, ...(live ? [live] : [])]);
    expect(session.getSnapshot().historyByRoom.first).toMatchObject({ atLatest: true, hasMore: false });
  } finally { session.close(); }
});

test("a fresh binding retires a pending browse before its late acknowledgement", async () => {
  const { session, socket, peer } = await setup(1000, false);
  try {
    const previous = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].delivery!.bindingId = "replacement-binding";
    socket.receive({ type: "state", state });
    const current = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    expect(current.requestId).not.toBe(previous.requestId);
    socket.receive({ type: "ack", requestId: previous.requestId });
    await Promise.resolve();
    expect(peer.sent).toEqual([]);
    socket.receive({ type: "ack", requestId: current.requestId });
    const refreshed = await peer.next();
    peer.page(refreshed, [], false, null, "replacement-binding");
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:first")).toBe(false));
    expect(peer.sent).toHaveLength(1);
    expect(session.getSnapshot().messagesByRoom.first).toEqual([]);
    expect(session.getSnapshot().error).toBeNull();
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
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  const retain = vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new DOMException("Full", "QuotaExceededError"));
  const { session, socket, peer } = await setup(1);
  const file = new File(["saved"], "note.txt"), id = crypto.randomUUID();
  const attachment = { id, name: file.name, size: file.size, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  vi.spyOn(session.attachments, "describe").mockResolvedValue([{ id, file, attachment }]);
  vi.spyOn(session.attachments, "limits").mockResolvedValue({ maxFileBytes: 100, maxInlineImageBytes: 65536, maxAttachmentsPerMessage: 8, maxRetainedBytes: 20, maxRetainedFiles: 2 });
  try {
    await peer.history([message(2)], true);
    await peer.history([message(1)], false, true);
    const sending = session.sendMessage("first", "file", [{ id, file }]);
    const request = await peer.next();
    expect(request).toMatchObject({ type: "chat", attachments: [attachment] });
    peer.reply(request, { type: "confirmed", message: { ...message(3), attachments: [{ ...attachment, sha256: attachment.sha256.toUpperCase() }] }, inserted: true });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1)]);
    expect(socket.sent.at(-1)).toMatchObject({ type: "file_offer", roomId: "first", messageSeq: 3, attachmentId: id, sha256: attachment.sha256.toUpperCase(), available: true });
    await expect(session.attachments.content({ roomId: "first", messageSeq: 3, attachmentId: id }, attachment, new AbortController().signal)).resolves.toBe(file);
    await sending;
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    await expect(session.attachments.content({ roomId: "first", messageSeq: 3, attachmentId: id }, { ...attachment, sha256: "b".repeat(64) }, new AbortController().signal)).rejects.toThrow("attachment_unavailable");
  } finally { session.close(); }
});

test("retained files offer only authorized rooms and eviction withdraws cache sources, preserving selected files", async () => {
  const cached = new File(["cached"], "cached.txt"), selected = new File(["selected"], "selected.txt");
  const key = { roomId: "first", messageSeq: 1, attachmentId: crypto.randomUUID() };
  const descriptor = { id: key.attachmentId, name: cached.name, size: cached.size, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([{ key, attachment: descriptor, file: cached }, { key: { ...key, roomId: "unreadable" }, attachment: descriptor, file: cached }]);
  const retain = vi.spyOn(FileStore.prototype, "retain").mockResolvedValue({ file: selected, evicted: [key] });
  const { session, socket } = await setup();
  vi.spyOn(session.attachments, "limits").mockResolvedValue({ maxFileBytes: 100, maxInlineImageBytes: 65536, maxAttachmentsPerMessage: 8, maxRetainedBytes: 20, maxRetainedFiles: 2 });
  try {
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ type: "file_offer", ...key, available: true })));
    expect(socket.sent.some(command => command.type === "file_offer" && command.roomId === "unreadable")).toBe(false);
    const attachment = { ...descriptor, id: crypto.randomUUID(), name: selected.name, size: selected.size };
    session.attachments.confirmed("first", { ...message(2), attachments: [attachment] }, [{ id: attachment.id, attachment, file: selected }]);
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ type: "file_offer", ...key, available: false })));
    const selectedKey = { ...key, messageSeq: 2, attachmentId: attachment.id };
    retain.mockResolvedValue({ file: cached, evicted: [selectedKey] });
    const next = { ...descriptor, id: crypto.randomUUID() };
    session.attachments.confirmed("first", { ...message(3), attachments: [next] }, [{ id: next.id, attachment: next, file: cached }]);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledTimes(2));
    await expect(session.attachments.content(selectedKey, attachment, new AbortController().signal)).resolves.toBe(selected);
    expect(socket.sent.some(command => command.type === "file_offer" && command.attachmentId === selectedKey.attachmentId && command.available === false)).toBe(false);
  } finally { session.close(); }
});

test("an old identity's retained-file restore cannot publish into the next identity", async () => {
  let finish!: (files: Awaited<ReturnType<FileStore["list"]>>) => void;
  const old = new Promise<Awaited<ReturnType<FileStore["list"]>>>(resolve => { finish = resolve; });
  vi.spyOn(FileStore.prototype, "list").mockReturnValueOnce(old).mockReturnValueOnce(old).mockResolvedValue([]);
  const { session, socket } = await setup();
  try {
    const exporting = session.attachments.retained("first");
    const state = structuredClone(session.getSnapshot().state!);
    state.sessions[0].userId = "new-user";
    state.users = [{ ...state.users[0], id: "new-user" }];
    socket.receive({ type: "state", state });
    const file = new File(["private"], "old.txt"), id = crypto.randomUUID();
    finish([{ key: { roomId: "first", messageSeq: 1, attachmentId: id }, file,
      attachment: { id, name: file.name, size: file.size, mediaType: "application/octet-stream", sha256: "a".repeat(64) } }]);
    await old; await Promise.resolve();
    await expect(exporting).resolves.toEqual([]);
    session.attachments.resume();
    expect(socket.sent.some(command => command.type === "file_offer" && command.attachmentId === id)).toBe(false);
  } finally { session.close(); }
});

test("restored file bytes retain their digest and remain readable when optional caching fails", async () => {
  const file = new File(["restored"], "restored.txt"), id = crypto.randomUUID();
  const key = { roomId: "first", messageSeq: 1, attachmentId: id };
  const attachment = { id, name: file.name, size: file.size, mediaType: "application/octet-stream" as const, sha256: "b".repeat(64) };
  const entry = { key, attachment, file };
  const list = vi.spyOn(FileStore.prototype, "list").mockResolvedValue([entry, { ...entry, key: { ...key, roomId: "second" } }]);
  const retain = vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new DOMException("Full", "QuotaExceededError"));
  const { session, socket } = await setup();
  const limits = vi.spyOn(session.attachments, "limits").mockResolvedValue({ maxFileBytes: 100, maxInlineImageBytes: 65536, maxAttachmentsPerMessage: 8, maxRetainedBytes: 20, maxRetainedFiles: 2 });
  try {
    await expect(session.attachments.retained("first")).resolves.toEqual([entry]);
    const calls = list.mock.calls.length;
    await expect(session.attachments.retained("unreadable")).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(calls);
    await expect(session.attachments.restoreRetained("first", [entry])).resolves.toBe(false);
    await expect(session.attachments.content(key, attachment, new AbortController().signal)).resolves.toBe(file);
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "file_offer", ...key, sha256: attachment.sha256, available: true }));
    retain.mockResolvedValue({ file, evicted: [] });
    await expect(session.attachments.restoreRetained("first", [entry])).resolves.toBe(true);

    let ready!: (value: Awaited<ReturnType<ChannelAttachments["limits"]>>) => void;
    limits.mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    const restoring = session.attachments.restoreRetained("first", [entry]);
    const before = retain.mock.calls.length;
    const state = structuredClone(session.getSnapshot().state!);
    state.sessions[0].userId = "new-user"; state.users = [{ ...state.users[0], id: "new-user" }];
    socket.receive({ type: "state", state });
    ready({ maxFileBytes: 100, maxInlineImageBytes: 65536, maxAttachmentsPerMessage: 8, maxRetainedBytes: 20, maxRetainedFiles: 2 });
    await expect(restoring).resolves.toBe(false);
    expect(retain).toHaveBeenCalledTimes(before);
  } finally { session.close(); }
});

test("retained source content and availability follow the current authenticated descriptor", async () => {
  const file = new File(["cached"], "cached.txt"), id = crypto.randomUUID(), changedId = crypto.randomUUID();
  const attachment = { id, name: file.name, size: file.size, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  const key = { roomId: "first", messageSeq: 1, attachmentId: id }, changedKey = { ...key, messageSeq: 2, attachmentId: changedId };
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([{ key, file, attachment }, { key: changedKey, file, attachment: { ...attachment, id: changedId } }]);
  const remove = vi.spyOn(FileStore.prototype, "remove").mockResolvedValue();
  const { session, socket } = await setup();
  try {
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ type: "file_offer", ...changedKey, available: true })));
    await expect(session.attachments.content(key, { ...attachment, sha256: attachment.sha256.toUpperCase() }, new AbortController().signal)).resolves.toBe(file);
    await expect(session.attachments.content(key, { ...attachment, sha256: "b".repeat(64) }, new AbortController().signal)).rejects.toThrow("attachment_unavailable");
    const state = structuredClone(session.getSnapshot().state!);
    state.files = [{ ...changedKey, attachment: { ...attachment, id: changedId, size: file.size + 1 }, sourceId: "endpoint", upstream: null, downstream: [], receiving: false }];
    socket.receive({ type: "state", state });
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "file_offer", ...key, sha256: attachment.sha256, available: false }));
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "file_offer", ...changedKey, sha256: attachment.sha256, available: false }));
    expect(remove).toHaveBeenCalledWith(key); expect(remove).toHaveBeenCalledWith(changedKey);
  } finally { session.close(); }
});

class RoomDataChannel extends EventTarget {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
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
  // Active-sender test observations; SDK getters retain removed senders/transceivers.
  senders: Array<{ track: MediaStreamTrack; stream: MediaStream;
    replaceTrack(track: MediaStreamTrack): Promise<void>;
    setStreams(...streams: MediaStream[]): void;
    getParameters(): RTCRtpSendParameters; setParameters(parameters: RTCRtpSendParameters): Promise<void> }> = [];
  transceivers: Array<{ sender: RoomPeerConnection["senders"][number]; receiver: RTCRtpReceiver;
    direction: RTCRtpTransceiverDirection; currentDirection: RTCRtpTransceiverDirection;
    setCodecPreferences: ReturnType<typeof vi.fn>; stop(): void }> = [];
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
      replaceTrack: vi.fn(async (next: MediaStreamTrack) => {
        sender.track = next;
        if (next && !this.senders.includes(sender)) this.senders.push(sender);
      }),
      setStreams: (...streams: MediaStream[]) => { sender.stream = streams[0]; },
      setParameters: async (next: RTCRtpSendParameters) => { parameters = structuredClone(next); } };
    this.senders.push(sender);
    const transceiver = { sender, receiver: { track: remoteTrack(track.kind as "audio" | "video"),
      getStats: async () => new Map() as RTCStatsReport } as RTCRtpReceiver, direction: "sendrecv" as RTCRtpTransceiverDirection,
      get currentDirection() { return this.direction; }, setCodecPreferences: vi.fn(),
      stop() { this.direction = "stopped"; } };
    this.transceivers.push(transceiver);
    return sender;
  }
  addTransceiver(track: MediaStreamTrack, init: RTCRtpTransceiverInit) {
    const sender = this.addTrack(track, init.streams![0]);
    void sender.setParameters({ encodings: init.sendEncodings ?? [{}] } as RTCRtpSendParameters);
    const transceiver = this.transceivers.find(value => value.sender === sender)!;
    transceiver.direction = init.direction ?? "sendrecv";
    return transceiver;
  }
  removeTrack(sender: RoomPeerConnection["senders"][number]) {
    const index = this.senders.indexOf(sender);
    if (index >= 0) this.senders.splice(index, 1);
    sender.track = null as unknown as MediaStreamTrack;
    const transceiver = this.transceivers.find(value => value.sender === sender)!;
    if (transceiver.direction === "sendrecv") transceiver.direction = "recvonly";
    else if (transceiver.direction === "sendonly") transceiver.direction = "inactive";
  }
  getReceivers() { return [...this.receivers, ...this.transceivers.map(transceiver => transceiver.receiver)]; }
  getSenders() { return this.transceivers.map(transceiver => transceiver.sender); }
  getTransceivers() { return this.transceivers; }
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

test("input registration replies stay with their endpoint after its media flow retires", async () => {
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  RoomPeerConnection.instances = [];
  const { session, socket } = await setup();
  const publicationId = crypto.randomUUID(), pairId = crypto.randomUUID(), source = "source";
  let flowId = crypto.randomUUID();
  const state = () => ({ ...session.getSnapshot().state!, subscriptions: [publicationId],
    publications: [{ audience: [], id: publicationId, roomId: "first", sessionId: source, userId: "self", kind: "screen" as const, source: { kind: "screen" as const, name: null }, title: null,
      videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }],
    pairs: [{ id: pairId, peerId: source, canReceiveVideoLayers: false, rooms: ["first"], outgoing: [],
      incoming: [{ id: flowId, publicationId, selected: true, inputFlowId: null }] }],
  });
  const registration = () => socket.sent.findLast(command => command.type === "input_register")!;
  try {
    socket.receive({ type: "state", state: state() });
    const watching = session.watch(publicationId, "first");
    socket.receive({ type: "ack", requestId: socket.sent.findLast(command => command.type === "subscribe")!.requestId });
    await watching;
    socket.receive({ type: "state", state: state() });
    const pc = RoomPeerConnection.instances.at(-1)!;
    pc.connected(); pc.channels.find(channel => channel.label === "piik-input")!.open();
    const retired = session.getSnapshot().inputChannels.get(publicationId)!;
    const oldRequest = registration();
    expect(oldRequest).toMatchObject({ flowId, requestId: expect.any(String) });

    flowId = crypto.randomUUID();
    socket.receive({ type: "state", state: state() });
    const replacement = session.getSnapshot().inputChannels.get(publicationId)!;
    expect(retired.readyState).toBe("closed");
    expect(replacement).not.toBe(retired);
    const currentRequest = registration();
    socket.receive({ type: "error", requestId: oldRequest.requestId, code: "unassigned_input_route" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(session.getSnapshot().error).toBeNull();
    expect(replacement.readyState).toBe("open");
    socket.receive({ type: "ack", requestId: currentRequest.requestId });
    expect(session.getSnapshot().inputChannels.get(publicationId)).toBe(replacement);

    flowId = crypto.randomUUID();
    socket.receive({ type: "state", state: state() });
    const rejected = session.getSnapshot().inputChannels.get(publicationId)!;
    socket.receive({ type: "error", requestId: registration().requestId, code: "unassigned_input_route" });
    await vi.waitFor(() => expect(rejected.readyState).toBe("closed"));
    expect(session.getSnapshot().error).toBeNull();

    flowId = crypto.randomUUID();
    socket.receive({ type: "state", state: state() });
    const healthy = session.getSnapshot().inputChannels.get(publicationId)!;
    socket.receive({ type: "ack", requestId: registration().requestId });
    await Promise.resolve();
    expect(healthy.readyState).toBe("open");
    expect(session.getSnapshot().error).toBeNull();
  } finally { session.close(); }
});

test("screen input shares its existing pair and retains only the committed flow's control session", async () => {
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  RoomPeerConnection.instances = [];
  const { session } = await setup();
  const local = "00000000-0000-4000-8000-000000000001", source = "00000000-0000-4000-8000-000000000002";
  const publicationId = crypto.randomUUID(), pairId = crypto.randomUUID(), first = crypto.randomUUID(), trial = crypto.randomUUID();
  let state = { ...session.getSnapshot().state!, subscriptions: [publicationId],
    publications: [{ audience: [], id: publicationId, roomId: "first", sessionId: source, userId: "self", kind: "screen" as const, source: { kind: "screen" as const, name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }],
    pairs: [{ id: pairId, peerId: source, canReceiveVideoLayers: false, rooms: [] as string[], outgoing: [],
      incoming: [{ id: first, publicationId, selected: true, inputFlowId: null }] }],
  };
  const register = vi.fn(async (_command: Extract<ChannelCommand, { type: "input_register" }>) => {}), changed = vi.fn();
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
      { id: upstreamPair, peerId: source, canReceiveVideoLayers: false, rooms: ["first"], outgoing: [], incoming: [{ id: upstreamFlow, publicationId, selected: true, inputFlowId: null }] },
      { id: downstreamPair, peerId: controller, canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: trial, publicationId, selected: true, inputFlowId: upstreamFlow }] },
    ] };
    vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
      route_input: (frame: string) => JSON.stringify({ frame: { ...JSON.parse(frame), flowId: upstreamFlow }, route: { nextHop: source, binding } }),
      input_binding_current: () => true,
    } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
    const relayInput = new ChannelInput({ context: () => ({ sessionId: local, state: relayState, connected: true }), register: vi.fn(async () => {}),
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
  playsInline = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
  remove = vi.fn();
  constructor(readonly tagName = "AUDIO") { RoomAudio.instances.push(this); }
}

class RoomMediaStream {
  readonly id = crypto.randomUUID();
  constructor(private tracks: MediaStreamTrack[] = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  removeTrack(track: MediaStreamTrack) { this.tracks = this.tracks.filter(current => current !== track); }
}

async function setupRoomMedia(layered = false, localSessionId = "a", buffering?: ConstructorParameters<typeof ChannelMedia>[6]) {
  RoomPeerConnection.instances = [];
  RoomAudio.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  vi.stubGlobal("Audio", RoomAudio);
  vi.stubGlobal("document", { body: { append: vi.fn() }, createElement: vi.fn((tag: string) => new RoomAudio(tag.toUpperCase())) });
  const { session, socket } = await setup();
  const state = structuredClone(session.getSnapshot().state!);
  const sent: ChannelCommand[] = [];
  const changed = vi.fn<(streams: ReadonlyMap<string, MediaStream>, inputs: ReadonlyMap<string, readonly ChannelScreenInput[]>) => void>();
  const media = new ChannelMedia(command => sent.push(command), changed, undefined, undefined, undefined, undefined, buffering);
  state.pairs = [{ id: "pair", peerId: "z", canReceiveVideoLayers: layered, rooms: ["first"], incoming: [], outgoing: [] }];
  media.update(localSessionId, state);
  return { session, socket, media, state, sent, changed, pc: RoomPeerConnection.instances[0] };
}

const decodedReport = (framesDecoded: number) => new Map([["video", {
  id: "video", type: "inbound-rtp", kind: "video", framesDecoded,
}]]) as unknown as RTCStatsReport;

async function screenFixture(buffering?: ConstructorParameters<typeof ChannelMedia>[6]) {
  const fixture = await setupRoomMedia(false, "a", buffering);
  fixture.state.publications = [{ audience: [], id: "screen", roomId: "first", sessionId: "z", userId: "other", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }];
  fixture.state.pairs[0].incoming = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
  fixture.media.update("a", fixture.state);
  fixture.pc.connected();
  return fixture;
}

const remoteTrack = (kind: "audio" | "video") => Object.assign(new EventTarget(), {
  id: crypto.randomUUID(), kind, readyState: "live", stop: vi.fn(), getSettings: () => ({}),
  clone: vi.fn(function (this: MediaStreamTrack) { return Object.assign(remoteTrack(kind), { getSettings: this.getSettings }); }),
}) as unknown as MediaStreamTrack;

const lastClone = (track: MediaStreamTrack) => vi.mocked(track.clone).mock.results.at(-1)?.value;

const remoteStream = (id: string, tracks: MediaStreamTrack[]) => Object.assign(new EventTarget(), {
  id, getTracks: () => tracks, getVideoTracks: () => tracks.filter(track => track.kind === "video"),
  getAudioTracks: () => tracks.filter(track => track.kind === "audio"),
}) as unknown as MediaStream;

function channelEncodingFixture() {
  vi.spyOn(encodingOutput, "supportsBrowserEncoding").mockReturnValue(true);
  const clones: MediaStreamTrack[] = [], carriers: MediaStreamTrack[] = [], claimed: RTCRtpSender[] = [];
  let rejectClaim = false;
  const source = () => {
    const track = Object.assign(remoteTrack("video"), { enabled: true, contentHint: "detail",
      getSettings: () => ({ width: 1920, height: 1080 }), getCapabilities: () => ({}),
      getConstraints: () => ({}), applyConstraints: vi.fn(async () => {}),
    });
    track.clone = () => { const clone = source(); clones.push(clone); return clone; };
    return track;
  };
  vi.stubGlobal("document", { createElement: () => {
    const track = Object.assign(source(), { getSettings: () => ({ width: 16, height: 16 }), requestFrame: vi.fn() });
    carriers.push(track);
    return { getContext: () => ({ fillRect() {} }), captureStream: () => ({ getVideoTracks: () => [track] }) };
  } });
  const add = RoomPeerConnection.prototype.addTransceiver;
  vi.spyOn(RoomPeerConnection.prototype, "addTransceiver").mockImplementation(function (this: RoomPeerConnection, track, init) {
    const transceiver = add.call(this, track, init);
    Object.assign(transceiver.sender, { createEncodedStreams: () => {
      claimed.push(transceiver.sender as unknown as RTCRtpSender);
      if (rejectClaim) { rejectClaim = false; throw new DOMException("sender claim refused", "InvalidStateError"); }
      return { readable: new ReadableStream<RTCEncodedVideoFrame>(), writable: new WritableStream<RTCEncodedVideoFrame>() };
    } });
    return transceiver;
  });
  type Create = Parameters<BrowserEncodingPool["create"]>;
  type Member = { pool: BrowserEncodingPool; source: MediaStreamTrack; sender: RTCRtpSender;
    encoded: Create[4]; configure: Create[5]; requestKey: Create[6]; fatal: Create[7];
    carrier: boolean; handle: BrowserPooledSender };
  const members: Member[] = [];
  vi.spyOn(BrowserEncodingPool.prototype, "create").mockImplementation(function (this: BrowserEncodingPool, source, sender, _pc, profile, encoded, configure, requestKey, fatal) {
    const member: Member = { pool: this, source, sender, encoded, configure, requestKey, fatal, carrier: true,
      handle: { updateProfile: vi.fn(async () => {}),
        carrierScale: () => member.carrier ? Math.max(1, (sender.track?.getSettings().width ?? profile.resolution.width) / 16) : undefined,
        setPaused: vi.fn(), metrics: (value => value), dispose: vi.fn(),
      } as BrowserPooledSender };
    members.push(member);
    return member.handle;
  });
  return { source, clones, carriers, claimed, members, rejectNextClaim: () => { rejectClaim = true; } };
}

test("room metrics read each PC once and follow current selected flows without mixing publications", async () => {
  const fixture = await setupRoomMedia();
  const video = remoteTrack("video"), sound = remoteTrack("audio"), voice = remoteTrack("audio"), other = remoteTrack("video");
  try {
    fixture.state.publications = [
      { audience: [], id: "screen", roomId: "first", sessionId: "a", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
      { audience: [], id: "voice", roomId: "first", sessionId: "a", userId: "self", kind: "voice", paused: false },
      { audience: [], id: "other", roomId: "second", sessionId: "a", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
    ];
    fixture.state.pairs[0].rooms.push("second");
    fixture.state.pairs[0].outgoing = fixture.state.publications.map(publication => ({ id: `${publication.id}-out`, publicationId: publication.id, selected: true, inputFlowId: null }));
    fixture.media.update("a", fixture.state);
    fixture.media.setLocal("screen", new MediaStream([video, sound]), undefined, videoCodec.VP8_ONLY_VIDEO_CODEC);
    fixture.media.setLocal("voice", new MediaStream([voice]));
    fixture.media.setLocal("other", new MediaStream([other]), undefined, videoCodec.VP8_ONLY_VIDEO_CODEC);
    await vi.waitFor(() => expect(fixture.pc.senders).toHaveLength(4));
    const report = (timestamp: number) => new Map<string, Record<string, unknown>>(fixture.pc.senders.map(sender => sender.track!).flatMap((track, index) => [
      [`source-${index}`, { id: `source-${index}`, timestamp, type: "media-source", kind: track.kind, trackIdentifier: track.id }],
      [`rtp-${index}`, { id: `rtp-${index}`, timestamp, type: "outbound-rtp", kind: track.kind, mediaSourceId: `source-${index}`,
        bytesSent: timestamp * [100, 16, 6, 1000][index]!, framesEncoded: timestamp / 100 }],
    ])) as unknown as RTCStatsReport;
    fixture.pc.getStats.mockResolvedValueOnce(report(1000)).mockResolvedValueOnce(report(2000));
    await fixture.media.connectionMetrics("first", "screen");
    expect(await fixture.media.connectionMetrics("first", "screen")).toMatchObject([
      { publicationId: "screen", direction: "send", media: "video", metrics: { bitrateKbps: 800, audioBitrateKbps: 128 } },
      { publicationId: "voice", direction: "send", media: "audio", metrics: { bitrateKbps: 48, audioBitrateKbps: 48 } },
    ]);
    expect(fixture.pc.getStats).toHaveBeenCalledTimes(2);
    let complete!: (value: RTCStatsReport) => void;
    fixture.pc.getStats.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const reading = fixture.media.connectionMetrics("first", "screen");
    fixture.state.pairs[0].outgoing = fixture.state.pairs[0].outgoing.filter(flow => flow.publicationId !== "screen");
    fixture.media.update("a", fixture.state);
    complete(report(3000));
    expect(await reading).toMatchObject([{ publicationId: "voice", media: "audio" }]);
  } finally { fixture.media.reset(); fixture.session.close(); }
});

test("voice activity follows subscribed speaking endpoints and discards retired input stats", async () => {
  const fixture = await setupRoomMedia();
  try {
    fixture.state.publications = [
      { audience: [], id: "voice-a", roomId: "first", sessionId: "speaker-a", userId: "friend", kind: "voice", paused: false },
      { audience: [], id: "voice-b", roomId: "first", sessionId: "speaker-b", userId: "friend", kind: "voice", paused: false },
      { audience: [], id: "relay-only", roomId: "first", sessionId: "relay-source", userId: "other", kind: "voice", paused: false },
      { audience: [], id: "candidate", roomId: "first", sessionId: "candidate-source", userId: "other", kind: "voice", paused: false },
      { audience: [], id: "another-room", roomId: "second", sessionId: "other-source", userId: "other", kind: "voice", paused: false },
      { audience: [], id: "screen-sound", roomId: "first", sessionId: "screen-source", userId: "other", kind: "screen", source: { kind: "screen", name: null }, title: null, paused: false, videoSettings: screenVideoSettings(QUALITY_PROFILES["720p30"]) },
    ];
    fixture.state.subscriptions = ["voice-a", "voice-b", "candidate", "another-room", "screen-sound"];
    fixture.state.pairs[0].incoming = fixture.state.publications.map(publication => ({ id: `${publication.id}-flow`, publicationId: publication.id, selected: publication.id !== "candidate", inputFlowId: null }));
    fixture.media.update("a", fixture.state); fixture.pc.connected();
    const streams = fixture.state.publications.map(publication => remoteStream(publication.id, [remoteTrack("audio")]));
    fixture.media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "voice-activity" },
      tracks: streams.map((stream, index) => ({ flowId: fixture.state.pairs[0].incoming[index].id, streamId: stream.id })) });
    await vi.waitFor(() => expect(fixture.pc.remoteDescription?.sdp).toBe("voice-activity"));
    for (const stream of streams) fixture.pc.ontrack?.({ streams: [stream] });
    const report = new Map(streams.map((stream, index) => [stream.id, { id: stream.id, type: "inbound-rtp", kind: "audio", trackIdentifier: stream.getAudioTracks()[0].id, audioLevel: index < 2 ? .2 + index * .2 : .9 }])) as unknown as RTCStatsReport;
    fixture.pc.getStats.mockClear().mockResolvedValue(report);
    expect(await fixture.media.voiceActivity("first")).toEqual(new Map([["speaker-a", .2], ["speaker-b", .4]]));
    expect(fixture.pc.getStats).toHaveBeenCalledOnce();
    let complete!: (report: RTCStatsReport) => void;
    fixture.pc.getStats.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = fixture.media.voiceActivity("first");
    fixture.state.subscriptions = [];
    fixture.media.update("a", fixture.state); complete(report);
    expect(await pending).toEqual(new Map());
  } finally { fixture.media.reset(); fixture.session.close(); }
});

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
    state.pairs.push({ id: "downstream", peerId: "y", canReceiveVideoLayers: false, rooms: ["first"], incoming: [],
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
    expect(downstream.senders.map(sender => sender.track)).toEqual([lastClone(nextVideo)]);
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

test("an inactive Native carrier reused by a new flow cannot reuse its old decoded-frame proof", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc, sent } = fixture;
  vi.useFakeTimers();
  const video = remoteTrack("video"), stream = remoteStream("stable-native-msid", [video]);
  let frames = 5;
  pc.receivers = [{ track: video, getStats: async () => decodedReport(frames) } as RTCRtpReceiver];
  try {
    await receiveScreen(fixture, stream);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(command => command.type === "flow_state" && command.state === "decoded")).toHaveLength(1);
    state.pairs[0].incoming = []; media.update("a", state);
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "inactive" }, tracks: [] });
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("inactive"));
    state.pairs[0].incoming = [{ id: "new-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    media.update("a", state);
    pc.getStats.mockImplementation(async () => decodedReport(frames));
    await receiveScreen(fixture, stream);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.some(command => command.type === "flow_state" && command.flowId === "new-flow")).toBe(false);
    frames++;
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(command => command.type === "flow_state" && command.flowId === "new-flow")).toEqual([
      { type: "flow_state", pairId: "pair", flowId: "new-flow", state: "decoded" },
    ]);
    expect(pc.close).not.toHaveBeenCalled(); expect(video.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("a selected screen reports only its current playback failure and keeps the room transport", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc, sent, changed } = fixture;
  state.subscriptions = ["screen"];
  media.update("a", state);
  vi.useFakeTimers();
  const video = remoteTrack("video"), replacement = remoteTrack("video");
  const previous = remoteStream("previous", [video]), current = remoteStream("current", [replacement]);
  try {
    pc.receivers = [{ track: video, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    await receiveScreen(fixture, previous);
    await vi.advanceTimersByTimeAsync(0);
    pc.receivers = [{ track: replacement, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    await receiveScreen(fixture, current);
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;
    media.resync();
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", pairId: "pair", flowId: "screen-flow", state: "decoded" },
    ]);
    sent.length = 0;
    pc.connectionState = "disconnected"; pc.onconnectionstatechange?.();
    media.resync();
    expect(sent.filter(command => command.type === "flow_state")).toEqual([]);
    pc.connected();
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", pairId: "pair", flowId: "screen-flow", state: "decoded" },
    ]);
    sent.length = 0;
    media.screenPresentation("screen-flow", previous, "failed");
    media.screenPresentation("screen-flow", current, "prepared");
    expect(sent.some(command => command.type === "flow_state" && ["failed", "switch_ready"].includes(command.state))).toBe(false);
    media.screenPresentation("screen-flow", current, "failed");
    media.screenPresentation("screen-flow", current, "failed");
    expect(sent.filter(command => command.type === "flow_state" && command.state === "failed")).toEqual([
      { type: "flow_state", pairId: "pair", flowId: "screen-flow", state: "failed" },
    ]);
    sent.length = 0;
    media.resync();
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", pairId: "pair", flowId: "screen-flow", state: "failed" },
    ]);
    expect(changed.mock.calls.at(-1)![0].has("screen")).toBe(false);
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();
    expect(video.stop).not.toHaveBeenCalled(); expect(replacement.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each(["approved", "warming", "retired", "live"])("a leaf candidate stays separate until quality and presentation are %s", async outcome => {
  const fixture = await screenFixture();
  const { media, session, state, pc, sent, changed } = fixture;
  state.subscriptions = ["screen"];
  vi.useFakeTimers();
  const oldVideo = remoteTrack("video"), nextVideo = remoteTrack("video");
  const oldAudio = remoteTrack("audio"), nextAudio = remoteTrack("audio");
  const oldStream = remoteStream("incumbent", [oldVideo, oldAudio]), candidate = remoteStream("candidate", [nextVideo, nextAudio]);
  let candidateWidth = outcome === "warming" ? 320 : 640;
  let sampleTimestamp: number | undefined, lastQualityTime = 0;
  const quality = (track: MediaStreamTrack, width = 640): RTCStatsReport => {
    const now = lastQualityTime = sampleTimestamp ?? Date.now();
    return new Map([[track.id, {
      id: track.id, type: "inbound-rtp", kind: "video", trackIdentifier: track.id, ssrc: 7,
      timestamp: now, bytesReceived: now * 10, framesDecoded: Math.floor(now / 100),
      framesPerSecond: 10, frameWidth: width, frameHeight: width * 9 / 16, packetsReceived: now, packetsLost: 0,
      freezeCount: 0, totalFreezesDuration: 0, pauseCount: 0, totalPausesDuration: 0,
    }]]) as unknown as RTCStatsReport;
  };
  try {
    pc.receivers = [{ track: oldVideo, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    await vi.advanceTimersByTimeAsync(0);
    pc.getStats.mockImplementation(async () => quality(oldVideo));
    state.pairs.push({ id: "candidate-pair", peerId: "x", canReceiveVideoLayers: false, rooms: [], outgoing: [],
      incoming: [{ id: "candidate-flow", publicationId: "screen", selected: false, inputFlowId: null }] });
    media.update("a", state);
    const next = RoomPeerConnection.instances[1]; next.connected();
    next.receivers = [{ track: nextVideo, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
    media.signal("candidate-pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "candidate" },
      tracks: [{ flowId: "candidate-flow", streamId: candidate.id }] });
    await vi.waitFor(() => expect(next.remoteDescription?.sdp).toBe("candidate"));
    next.getStats.mockImplementation(async () => quality(nextVideo, candidateWidth));
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
      if (outcome === "warming") {
        expect(sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
        expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
        expect(changed.mock.calls.at(-1)![1].get("screen")?.some(value => value.flowId === "candidate-flow")).toBe(true);
        candidateWidth = 640;
        await vi.advanceTimersByTimeAsync(8100);
      }
      expect(sent.filter(command => command.type === "flow_state" && command.state === "switch_ready").length).toBeGreaterThan(0);
      sent.length = 0;
      media.resync();
      expect(sent.filter(command => command.type === "flow_state" && command.state === "switch_ready")).toEqual([]);
      expect(sent).toContainEqual({ type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "decoded" });
      media.screenPresentation("candidate-flow", candidate, "prepared");
      expect(sent.filter(command => command.type === "flow_state" && command.state === "switch_ready")).toEqual([]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
      expect(changed.mock.calls.at(-1)![1].get("screen")?.find(value => value.flowId === "candidate-flow")?.switchReady).toBe(true);
      if (outcome === "live") {
        // An early leg keeps proving itself while the room waits for another leg.
        sent.length = 0;
        await vi.advanceTimersByTimeAsync(6000);
        expect(sent.filter(command => command.type === "flow_state" && command.state === "switch_ready")).toHaveLength(3);
        sampleTimestamp = lastQualityTime;
        sent.length = 0;
        await vi.advanceTimersByTimeAsync(2000);
        expect(sent.filter(command => command.type === "flow_state")).toEqual([]);
        expect(changed.mock.calls.at(-1)![1].get("screen")?.find(value => value.flowId === "candidate-flow")?.switchReady).toBe(true);
        sampleTimestamp = undefined; candidateWidth = 320;
        await vi.advanceTimersByTimeAsync(2000);
        expect(sent.filter(command => command.type === "flow_state")).toEqual([
          { type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "decoded" },
        ]);
        expect(changed.mock.calls.at(-1)![1].get("screen")?.find(value => value.flowId === "candidate-flow")?.switchReady).toBe(false);
        await vi.advanceTimersByTimeAsync(2000);
        expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1);
        candidateWidth = 640;
        await vi.advanceTimersByTimeAsync(6000);
        expect(sent.at(-1)).toEqual({ type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "switch_ready" });
        state.pairs.pop(); media.update("a", state);
        const polls = next.getStats.mock.calls.length;
        sent.length = 0;
        await vi.advanceTimersByTimeAsync(4000);
        expect(next.getStats).toHaveBeenCalledTimes(polls);
        expect(sent.filter(command => command.type === "flow_state")).toEqual([]);
        expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
        return;
      }
      media.screenPresentation("candidate-flow", candidate, "waiting");
      state.pairs[0].incoming = [];
      state.pairs[1].incoming[0].selected = true;
      media.update("a", state);
      expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(candidate);
    }
    if (outcome === "retired") {
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
    state.pairs.push({ id: "candidate-pair", peerId: "x", canReceiveVideoLayers: false, rooms: [], outgoing: [],
      incoming: [{ id: "candidate-flow", publicationId: "screen", selected: false, inputFlowId: null }] });
    state.pairs.push({ id: "downstream", peerId: "y", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [
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
    expect(downstream.senders.map(sender => sender.track)).toEqual([lastClone(oldVideo), oldAudio, lastClone(nextVideo), nextAudio]);
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
    expect(RoomAudio.instances.map(player => player.srcObject?.getTracks())).toEqual([[oldVideo, oldAudio], [nextVideo, nextAudio]]);
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
      Object.defineProperty(nextVideo, "readyState", { value: "ended" });
      nextVideo.dispatchEvent(new Event("ended"));
      expect(sent).toContainEqual({ type: "flow_state", pairId: "candidate-pair", flowId: "candidate-flow", state: "failed" });
      state.pairs.splice(1, 1);
      state.pairs[1].outgoing.pop();
      media.update("a", state);
      expect(downstream.senders).toEqual(currentSenders);
      expect(downstream.senders[0]).toBe(currentSenders[0]);
      expect(shadowBinding.getTracks()).toEqual([]);
      expect(shadowConsumer.pause).toHaveBeenCalledOnce();
      expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
      expect(next.close).toHaveBeenCalledOnce();
    }
    expect(pc.close).not.toHaveBeenCalled(); expect(downstream.close).not.toHaveBeenCalled();
    for (const track of [oldVideo, oldAudio, nextVideo, nextAudio]) expect(track.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each([false, true])("SDP track replacement stays atomic for the same MSID (new stream object: %s)", async newObject => {
  const fixture = await screenFixture();
  const { media, session, pc, sent, changed } = fixture;
  vi.useFakeTimers();
  const oldVideo = remoteTrack("video"), nextVideo = remoteTrack("video"), audio = remoteTrack("audio");
  const tracks = [oldVideo, audio], oldStream = remoteStream("same-native-msid", tracks);
  const nextStream = newObject ? remoteStream(oldStream.id, [nextVideo, audio]) : oldStream;
  let frames = 1;
  try {
    pc.receivers = [{ track: oldVideo, getStats: async () => decodedReport(frames) } as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ type: "flow_state", pairId: "pair", flowId: "screen-flow", state: "decoded" });
    sent.length = 0;
    const apply = pc.setRemoteDescription.bind(pc);
    let finish!: () => void;
    const inProgress = new Promise<void>(resolve => { finish = resolve; });
    const srd = vi.spyOn(pc, "setRemoteDescription").mockImplementationOnce(async description => {
      tracks.splice(0, 1);
      oldStream.dispatchEvent(new Event("removetrack"));
      await inProgress;
      if (!newObject) tracks.unshift(nextVideo);
      pc.receivers = [{ track: nextVideo, getStats: async () => decodedReport(frames) } as RTCRtpReceiver];
      pc.ontrack?.({ streams: [nextStream] });
      await apply(description);
    });
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "replacement" },
      tracks: [{ flowId: "screen-flow", streamId: oldStream.id }] });
    await vi.waitFor(() => expect(srd).toHaveBeenCalledOnce());
    expect(sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
    expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(oldStream);
    finish();
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("replacement"));
    frames++;
    await vi.advanceTimersByTimeAsync(100);
    expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(nextStream);
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", pairId: "pair", flowId: "screen-flow", state: "decoded" },
    ]);
    if (newObject) {
      oldStream.dispatchEvent(new Event("removetrack"));
      media.screenPresentation("screen-flow", oldStream, "failed");
      expect(changed.mock.calls.at(-1)![0].get("screen")).toBe(nextStream);
      expect(sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
    }
    expect(pc.close).not.toHaveBeenCalled();
    for (const track of [oldVideo, nextVideo, audio]) expect(track.stop).not.toHaveBeenCalled();
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

test("a relay shares one video consumer across children and releases only its own player on track changes or retirement", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc } = fixture;
  const video = remoteTrack("video"), nextVideo = remoteTrack("video"), audio = remoteTrack("audio");
  const tracks = [video, audio], stream = remoteStream("shared-relay", tracks);
  pc.receivers = [{ track: video, getStats: async () => decodedReport(0) } as RTCRtpReceiver];
  try {
    state.pairs.push(...["first-child", "second-child"].map(id => ({ id, peerId: id, canReceiveVideoLayers: false,
      rooms: ["first"], incoming: [], outgoing: [{ id: `${id}-out`, publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] })));
    media.update("a", state);
    await receiveScreen(fixture, stream);
    expect(RoomAudio.instances).toHaveLength(1);
    const first = RoomAudio.instances[0];
    expect(first).toMatchObject({ tagName: "VIDEO", hidden: true, muted: true, autoplay: true, playsInline: true });
    expect(first.srcObject?.getTracks()).toEqual([video, audio]);
    expect(first.play).toHaveBeenCalledOnce();
    expect(document.body.append).toHaveBeenCalledWith(first);

    state.subscriptions = ["screen"]; media.update("a", state);
    state.subscriptions = []; media.update("a", state);
    state.pairs[1].outgoing = []; media.update("a", state);
    expect(RoomAudio.instances).toHaveLength(1);
    expect(first.pause).not.toHaveBeenCalled();

    tracks[0] = nextVideo;
    pc.receivers = [{ track: nextVideo, getStats: async () => decodedReport(0) } as RTCRtpReceiver];
    pc.ontrack?.({ streams: [stream] });
    expect(RoomAudio.instances).toHaveLength(2);
    const replacement = RoomAudio.instances[1];
    expect(first.pause).toHaveBeenCalledOnce(); expect(first.remove).toHaveBeenCalledOnce();
    expect(first.srcObject).toBeNull();
    expect(replacement.srcObject?.getTracks()).toEqual([nextVideo, audio]);
    expect(replacement.play).toHaveBeenCalledOnce();

    state.pairs[2].outgoing = []; media.update("a", state);
    expect(replacement.pause).toHaveBeenCalledOnce(); expect(replacement.remove).toHaveBeenCalledOnce();
    expect(replacement.srcObject).toBeNull();
    state.pairs[2].outgoing = [{ id: "resumed-out", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }];
    media.update("a", state);
    const resumed = RoomAudio.instances[2];
    expect(resumed.srcObject?.getTracks()).toEqual([nextVideo, audio]);
    media.reset();
    expect(resumed.pause).toHaveBeenCalledOnce(); expect(resumed.remove).toHaveBeenCalledOnce();
    expect(resumed.srcObject).toBeNull();
    expect(stream.getTracks()).toEqual([nextVideo, audio]);
    for (const track of [video, nextVideo, audio]) expect(track.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("a relay waits for decoded input and Auto proof before creating its original flow sender", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc } = fixture;
  let resolve!: (codec: "h264") => void, signal!: AbortSignal;
  const probe = vi.spyOn(codecPreflight, "preferredVideoCodecForTrack").mockImplementation((_track, owner) => {
    signal = owner;
    return new Promise(done => { resolve = done; });
  });
  const apply = vi.spyOn(videoCodec, "applyVideoCodecPreference").mockReturnValue(true);
  const video = remoteTrack("video"), stream = remoteStream("relay-codec", [video]);
  let frames = 0;
  pc.receivers = [{ track: video, getStats: async () => decodedReport(frames) } as RTCRtpReceiver];
  try {
    state.pairs.push({ id: "downstream", peerId: "y", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: "relay", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] });
    media.update("a", state);
    await receiveScreen(fixture, stream);
    const downstream = RoomPeerConnection.instances[1];
    expect(probe).not.toHaveBeenCalled();
    expect(downstream.senders).toEqual([]);
    expect(RoomAudio.instances).toHaveLength(1);
    expect(RoomAudio.instances[0].srcObject?.getTracks()).toEqual([video]);
    expect(RoomAudio.instances[0].play).toHaveBeenCalledOnce();
    frames = 1;
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    expect(downstream.senders).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
    resolve("h264"); await Promise.resolve();
    const sender = downstream.senders[0];
    expect(sender.track).toBe(lastClone(video));
    expect(apply).toHaveBeenLastCalledWith(expect.anything(), { primary: "h264", vp8Fallback: true });
    state.publications[0].paused = true; media.update("a", state);
    expect(downstream.senders).toEqual([sender]);
    expect(sender.track).toBe(lastClone(video));
    expect(apply).toHaveBeenCalledTimes(1);
    state.pairs.push({ id: "new-downstream", peerId: "z", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: "new-relay", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] });
    media.update("a", state);
    expect(apply).toHaveBeenLastCalledWith(expect.anything(), { primary: "h264", vp8Fallback: true });
    expect(probe).toHaveBeenCalledOnce();
  } finally {
    media.reset(); session.close();
    expect(signal.aborted).toBe(true);
    expect(video.stop).not.toHaveBeenCalled();
  }
});

test.each(["pause", "retire"])("a %s fences a relay's late codec proof without stopping its input", async outcome => {
  const fixture = await screenFixture();
  const { media, session, state, pc } = fixture;
  const pending: Array<{ signal: AbortSignal; resolve(codec: "h264"): void }> = [];
  vi.spyOn(codecPreflight, "preferredVideoCodecForTrack").mockImplementation((_track, signal) =>
    new Promise(resolve => { pending.push({ signal, resolve }); }));
  vi.spyOn(videoCodec, "applyVideoCodecPreference").mockReturnValue(true);
  const video = remoteTrack("video"), stream = remoteStream("late-codec", [video]);
  let frames = 1;
  pc.receivers = [{ track: video, getStats: async () => decodedReport(frames++) } as RTCRtpReceiver];
  try {
    state.pairs.push({ id: "downstream", peerId: "y", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: "relay", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] });
    media.update("a", state);
    await receiveScreen(fixture, stream);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const downstream = RoomPeerConnection.instances[1];
    if (outcome === "pause") state.publications[0].paused = true;
    else state.pairs[0].incoming = [];
    media.update("a", state);
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve("h264"); await Promise.resolve();
    expect(downstream.senders).toEqual([]);
    if (outcome === "pause") {
      state.publications[0].paused = false; frames++;
      media.update("a", state);
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      pending[1].resolve("h264"); await Promise.resolve();
      expect(downstream.senders.map(sender => sender.track)).toEqual([lastClone(video)]);
    }
    expect(video.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("a relay applies the accepted source ceiling to its retained sender without replacing audio or encoder policy", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc } = fixture;
  const video = remoteTrack("video"), audio = remoteTrack("audio");
  const stream = remoteStream("source-ceiling", [video, audio]);
  pc.receivers = [{ track: video, getStats: async () => decodedReport(1) } as RTCRtpReceiver];
  try {
    state.pairs.push({ id: "downstream", peerId: "y", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: "relay", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] });
    media.update("a", state);
    await receiveScreen(fixture, stream);
    const downstream = RoomPeerConnection.instances[1];
    await vi.waitFor(() => expect(downstream.senders).toHaveLength(2));
    const [picture, sound] = downstream.senders;
    await vi.waitFor(() => expect(picture.getParameters().encodings[0]).toMatchObject({ maxBitrate: 5_000_000, maxFramerate: 30 }));
    expect(picture.getParameters().degradationPreference).toBe("balanced");
    expect(picture.track).toBe(lastClone(video));
    state.publications[0] = { ...state.publications[0], kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: {
      ceiling: { resolution: { width: 1920, height: 1080 }, maxFramerate: 60, maxBitrate: 8_000_000 },
      degradationPreference: "maintain-framerate",
    } };
    media.update("a", state);
    await vi.waitFor(() => expect(picture.getParameters().encodings[0]).toMatchObject({ maxBitrate: 8_000_000, maxFramerate: 60 }));
    expect(picture.getParameters().degradationPreference).toBe("maintain-framerate");
    expect(sound.getParameters().encodings[0].maxBitrate).toBe(128_000);
    expect(downstream.senders).toEqual([picture, sound]);
    expect(video.stop).not.toHaveBeenCalled(); expect(audio.stop).not.toHaveBeenCalled();
    expect(downstream.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("a relay updates senders when audio joins and leaves the same remote screen stream", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc } = fixture;
  const video = remoteTrack("video");
  const audio = remoteTrack("audio");
  const tracks = [video], stream = remoteStream("screen-stream", tracks);
  let frames = 1;
  pc.receivers = [{ track: video, getStats: async () => decodedReport(frames++) } as RTCRtpReceiver];
  try {
    state.pairs.push({ id: "downstream", peerId: "y", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: "screen-downstream", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }] });
    media.update("a", state);
    const downstream = RoomPeerConnection.instances[1];
    await receiveScreen(fixture, stream);
    await vi.waitFor(() => expect(downstream.senders.map(sender => sender.track)).toEqual([lastClone(video)]));
    const videoOnlyConsumer = RoomAudio.instances[0];
    expect(videoOnlyConsumer.srcObject?.getTracks()).toEqual([video]);
    const videoSender = downstream.senders[0];
    const binding = videoSender.stream;
    expect(binding.id).not.toBe(stream.id);
    tracks.push(audio);
    pc.ontrack?.({ streams: [stream] });
    expect(downstream.senders.map(sender => sender.track)).toEqual([lastClone(video), audio]);
    const withSound = RoomAudio.instances.at(-1)!;
    expect(withSound.srcObject?.getTracks()).toEqual([video, audio]);
    expect(videoOnlyConsumer.pause).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(downstream.senders[1].getParameters().encodings[0].maxBitrate).toBe(128_000));
    expect(downstream.senders[0]).toBe(videoSender);
    // Removing a remote track does not emit ontrack; the SDP replay republishes its stream.
    tracks.pop();
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "audio-removed" },
      tracks: [{ flowId: "screen-flow", streamId: stream.id }] });
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("audio-removed"));
    expect(downstream.senders.map(sender => sender.track)).toEqual([lastClone(video)]);
    expect(RoomAudio.instances.at(-1)!.srcObject?.getTracks()).toEqual([video]);
    expect(withSound.pause).toHaveBeenCalledOnce();
    expect(downstream.senders[0]).toBe(videoSender);
    expect(binding.getTracks()).toEqual([video]);
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "source-paused" }, tracks: [] });
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("source-paused"));
    expect(downstream.senders).toEqual([]);
    expect(binding.getTracks()).toEqual([]);
    await receiveScreen(fixture, stream);
    await vi.waitFor(() => expect(downstream.senders).toHaveLength(1));
    expect(downstream.senders[0].stream).toBe(binding);
    state.pairs[1].outgoing = [{ id: "renewed-screen-downstream", publicationId: "screen", selected: true, inputFlowId: "screen-flow" }];
    media.update("a", state);
    await vi.waitFor(() => expect(downstream.senders.map(sender => sender.track)).toEqual([lastClone(video)]));
    expect(downstream.senders[0]).toBe(videoSender);
    expect(downstream.senders[0].stream).toBe(binding);
    expect(binding.getTracks()).toEqual([video]);
    expect(downstream.getTransceivers()).toHaveLength(2); // Video plus the retired source-audio slot.
    expect(video.stop).not.toHaveBeenCalled(); expect(audio.stop).not.toHaveBeenCalled();
    expect(downstream.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("channel publications share one pool across Browser children, while Native layers and audio keep ordinary senders", async () => {
  const { session, media, state, sent, pc } = await setupRoomMedia();
  const pool = channelEncodingFixture(), first = pool.source(), second = pool.source(), sound = remoteTrack("audio");
  const profile = QUALITY_PROFILES["1080p30"], disposed = vi.spyOn(BrowserEncodingPool.prototype, "dispose");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.publications = ["first-screen", "second-screen"].map(id => ({ audience: [], id, roomId: "first", sessionId: "a", userId: "self",
    kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(profile), paused: false }));
  state.pairs[0].outgoing = state.publications.map(publication => ({ id: `${publication.id}-out`, publicationId: publication.id,
    selected: true, inputFlowId: null }));
  state.pairs.push({ id: "browser-child", peerId: "y", canReceiveVideoLayers: false, rooms: [], incoming: [],
    outgoing: [{ id: "same-source-child", publicationId: "first-screen", selected: true, inputFlowId: null }] },
  { id: "native-child", peerId: "x", canReceiveVideoLayers: true, rooms: [], incoming: [],
    outgoing: [{ id: "layered-child", publicationId: "first-screen", selected: true, inputFlowId: null }] });
  try {
    media.setLocal("first-screen", remoteStream("first", [first, sound]), profile);
    media.setLocal("second-screen", remoteStream("second", [second]), profile);
    media.update("a", state);
    expect(pool.members).toHaveLength(3);
    expect(new Set(pool.members.map(member => member.pool)).size).toBe(1);
    expect(pool.members.map(member => member.source)).toEqual([first, second, first]);
    expect(pool.claimed).toHaveLength(3); // Claimed before any negotiation/microtask.
    const [firstSender, audio, secondSender] = pc.senders;
    expect(audio.track).toBe(sound);
    expect(firstSender.track).not.toBe(first); expect(secondSender.track).not.toBe(second);
    const native = RoomPeerConnection.instances[2].senders;
    const nativeVideo = native[0].track!;
    expect(nativeVideo).not.toBe(first);
    expect(nativeVideo.getSettings()).toEqual(first.getSettings());
    expect(native[1].track).toBe(sound);
    expect(native[0].getParameters().encodings.map(encoding => encoding.rid)).toEqual(["q", "h"]);

    const ordinary = pool.source();
    media.setLocal("ordinary", remoteStream("ordinary", [ordinary]), profile);
    state.publications.push({ ...state.publications[0], id: "ordinary" });
    state.pairs[0].outgoing.push({ id: "ordinary-out", publicationId: "ordinary", selected: true, inputFlowId: null });
    pool.rejectNextClaim();
    media.update("a", state);
    expect(pc.senders.at(-1)!.track).not.toBe(ordinary);
    expect(pc.senders.at(-1)!.track.getSettings()).toEqual(ordinary.getSettings());
    expect(pool.members).toHaveLength(3);
    expect(pool.claimed).toHaveLength(4);
    expect(pool.carriers[3].stop).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("Channel encoding pool unavailable for sender", { flowId: "ordinary-out" }, expect.any(DOMException));

    const member = pool.members[0];
    await expect(member.configure()).resolves.toBe(true);
    expect(firstSender.track).toBe(member.encoded.track);
    media.update("a", state); media.update("a", state);
    expect(pool.members).toHaveLength(3);
    expect(pool.claimed).toHaveLength(4); // Unchanged demand does not retry the optional claim.
    expect(firstSender.stream.getTracks()).toEqual([first, sound]);
    state.publications[0].paused = true;
    media.update("a", state);
    expect(member.encoded.track.enabled).toBe(false);
    expect(member.handle.setPaused).toHaveBeenLastCalledWith(true);
    expect(first.enabled).toBe(true);
    expect(pool.members[1].handle.setPaused).toHaveBeenLastCalledWith(false);

    const oldPool = member.pool;
    state.pairs = state.pairs.filter(pair => pair.id !== "native-child");
    media.update("a", state);
    expect(nativeVideo.stop).toHaveBeenCalledOnce();
    for (const source of [first, second, sound]) expect(source.stop).not.toHaveBeenCalled();
    media.reset();
    expect(disposed.mock.contexts).toContain(oldPool);
    for (const member of pool.members) expect(member.handle.dispose).toHaveBeenCalledOnce();
    for (const carrier of pool.carriers) expect(carrier.stop).toHaveBeenCalled();
    const fresh = pool.source();
    state.pairs = [{ ...state.pairs[0], outgoing: [state.pairs[0].outgoing[0]] }];
    state.publications[0].paused = false;
    media.setLocal("first-screen", remoteStream("fresh", [fresh]), profile);
    media.update("a", state);
    expect(pool.members.at(-1)!.pool).not.toBe(oldPool);
    expect(pool.members.at(-1)!.source).toBe(fresh);
    expect(sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
  } finally { media.reset(); session.close(); }
});

test("pooled carriers retain the logical source and pending offer across replacement, rollback and ordinary fallback", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const pool = channelEncodingFixture(), videoPool = new BrowserEncodingPool();
  const signals: ChannelSignal[] = [], failed = vi.fn(), outgoingFailed = vi.fn();
  const transport = new ChannelTransport({ polite: true, iceServers: [], videoPool, send: value => signals.push(value),
    receive() {}, connected() {}, base() {}, failed, outgoingFailed });
  const pc = RoomPeerConnection.instances[0], first = pool.source(), next = pool.source(), voice = remoteTrack("audio");
  const profile = QUALITY_PROFILES["1080p30"];
  const outputs = new Map([
    ["screen", { kind: "screen" as const, stream: remoteStream("first", [first]), profile }],
    ["voice", { kind: "voice" as const, stream: remoteStream("voice", [voice]), profile }],
  ]);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    transport.setOutgoing(outputs);
    const [sender, audio] = pc.senders, initial = sender.track, firstMember = pool.members[0];
    pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(signals.some(value => value.description?.type === "offer")).toBe(true));
    const offer = signals.find(value => value.description?.type === "offer")!;
    await expect(firstMember.configure()).resolves.toBe(true);
    const carrier = sender.track;
    expect(initial.stop).toHaveBeenCalledOnce();
    expect(carrier).toBe(firstMember.encoded.track);

    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const replace = vi.spyOn(sender, "replaceTrack").mockImplementationOnce(async track => { await wait; sender.track = track; });
    outputs.set("screen", { kind: "screen", stream: remoteStream("next", [next]), profile });
    transport.setOutgoing(outputs);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    transport.signal({ exchangeId: offer.exchangeId, description: { type: "answer", sdp: "answer" }, tracks: [] });
    expect(firstMember.handle.dispose).not.toHaveBeenCalled();
    expect(carrier.stop).not.toHaveBeenCalled();
    expect(sender.stream.getTracks()).toEqual([first]);
    finish();
    await vi.waitFor(() => expect(pc.signalingState).toBe("stable"));
    expect(pool.members).toHaveLength(2);
    expect(pool.claimed).toHaveLength(1); // The connection-lifetime encoded writer survives source replacement.
    expect(pool.members[1].source).toBe(next);
    expect(sender.stream.getTracks()).toEqual([next]);
    expect(firstMember.handle.dispose).toHaveBeenCalledOnce();
    expect(carrier.stop).not.toHaveBeenCalled();
    await expect(firstMember.configure()).resolves.toBe(false);
    firstMember.fatal();
    expect(outgoingFailed).not.toHaveBeenCalled();

    const member = pool.members[1], ordinary = sender.track;
    vi.spyOn(sender, "setParameters").mockRejectedValueOnce(new Error("carrier configuration refused"));
    await expect(member.configure()).resolves.toBe(false);
    expect(sender.track).toBe(ordinary);
    expect(ordinary.stop).not.toHaveBeenCalled();
    await expect(member.configure()).resolves.toBe(true);
    expect(ordinary.stop).toHaveBeenCalledOnce();
    member.carrier = false; // Existing pool's producer-failure/codec-fallback callback.
    await expect(member.configure()).resolves.toBe(true);
    member.encoded.passthrough(member.requestKey);
    const restored = sender.track;
    expect(restored).not.toBe(carrier); expect(restored).not.toBe(next);
    expect(restored.getSettings()).toEqual(next.getSettings());
    transport.setOutgoing(outputs);
    expect(pool.members).toHaveLength(2);

    const candidate = pool.source();
    outputs.set("candidate", { kind: "screen", stream: remoteStream("candidate", [candidate]), profile });
    transport.setOutgoing(outputs);
    vi.spyOn(pc, "setLocalDescription").mockRejectedValueOnce(new DOMException("refused new offer", "OperationError"));
    pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(outgoingFailed).toHaveBeenCalledWith("candidate"));
    expect(pc.senders).toEqual([sender, audio]);
    expect(sender.track).toBe(restored);
    expect(restored.stop).not.toHaveBeenCalled();
    expect(pool.members[2].handle.dispose).toHaveBeenCalledOnce();
    expect(pool.carriers[1].stop).not.toHaveBeenCalled(); // Physical encoded pipe retires with the PC.
    expect(failed).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(first.stop).not.toHaveBeenCalled(); expect(next.stop).not.toHaveBeenCalled(); expect(voice.stop).not.toHaveBeenCalled();
  } finally { transport.close(); videoPool.dispose(); }
  for (const track of [...pool.clones, ...pool.carriers]) expect(track.stop).toHaveBeenCalled();
});

test.each(["carrier", "source"])("retiring an in-flight %s releases its pending wait and preserves sibling senders", async operation => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const pool = channelEncodingFixture(), videoPool = new BrowserEncodingPool(), source = pool.source();
  const failed = vi.fn(), outgoingFailed = vi.fn();
  const transport = new ChannelTransport({ polite: true, iceServers: [], videoPool, send() {},
    receive() {}, connected() {}, base() {}, failed, outgoingFailed });
  const pc = RoomPeerConnection.instances[0], profile = QUALITY_PROFILES["1080p30"];
  const output = { kind: "screen" as const, stream: remoteStream("source", [source]), profile };
  const outputs = new Map([["first", output], ["sibling", output]]);
  try {
    transport.setOutgoing(outputs);
    const [sender, sibling] = pc.senders, [retiring, healthy] = pool.members;
    vi.spyOn(sender, "replaceTrack").mockImplementationOnce(() => new Promise<void>(() => {}));
    let pending: Promise<boolean>;
    if (operation === "carrier") pending = retiring.configure();
    else {
      outputs.set("first", { ...output, stream: remoteStream("replacement", [pool.source()]) });
      transport.setOutgoing(outputs);
      pending = healthy.configure();
    }
    await vi.waitFor(() => expect(sender.replaceTrack).toHaveBeenCalledOnce());
    outputs.delete("first");
    transport.setOutgoing(outputs);
    outputs.set("first", output); // A new binding with the same public flow key.
    transport.setOutgoing(outputs);
    expect(retiring.handle.dispose).toHaveBeenCalledOnce();
    expect(retiring.encoded.track.stop).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe(operation === "source");
    await vi.waitFor(() => expect(pc.senders).toHaveLength(2));
    const successor = pc.senders.find(value => value !== sibling)!;
    expect(successor).toBe(sender);
    expect(pool.members[2].encoded).toBe(retiring.encoded);
    if (operation === "carrier") await expect(healthy.configure()).resolves.toBe(true);
    await retiring.requestKey(); retiring.fatal();
    expect(pc.senders).toEqual([sibling, successor]);
    expect(healthy.handle.dispose).not.toHaveBeenCalled();
    expect(pool.members[2].handle.dispose).not.toHaveBeenCalled();
    expect(successor.track.stop).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled(); expect(outgoingFailed).not.toHaveBeenCalled();
  } finally { transport.close(); videoPool.dispose(); }
  for (const track of [...pool.clones, ...pool.carriers]) expect(track.stop).toHaveBeenCalled();
});

test("source tracks replace serially on the existing physical pair, senders and flow stream binding", async () => {
  const { session, media, state, sent, pc } = await setupRoomMedia();
  const oldVideo = remoteTrack("video"), oldAudio = remoteTrack("audio");
  const nextVideo = remoteTrack("video"), nextAudio = remoteTrack("audio");
  const finalVideo = remoteTrack("video"), finalAudio = remoteTrack("audio");
  try {
    state.publications = [{ audience: [], id: "screen", roomId: "first", sessionId: "a", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }];
    media.setLocal("screen", remoteStream("old", [oldVideo, oldAudio]));
    state.pairs[0].outgoing = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    media.update("a", state);
    const [videoSender, audioSender] = pc.senders, binding = videoSender.stream;
    let finish!: () => void;
    const paused = new Promise<void>(resolve => { finish = resolve; });
    const replace = vi.spyOn(videoSender, "replaceTrack").mockImplementationOnce(async track => {
      await paused; videoSender.track = track;
    });
    media.setLocal("screen", remoteStream("next", [nextVideo, nextAudio]));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    media.setLocal("screen", remoteStream("final", [finalVideo, finalAudio]));
    expect(videoSender.track).toBe(lastClone(oldVideo));
    expect(audioSender.track).toBe(oldAudio);
    finish();
    await vi.waitFor(() => expect(pc.senders.map(sender => sender.track)).toEqual([lastClone(finalVideo), finalAudio]));
    expect(pc.senders).toEqual([videoSender, audioSender]);
    expect(videoSender.stream).toBe(binding);
    expect(binding.getTracks()).toEqual([finalVideo, finalAudio]);
    media.setLocal("screen", remoteStream("camera-video-only", [finalVideo]));
    expect(pc.senders).toEqual([videoSender]);
    expect(binding.getTracks()).toEqual([finalVideo]);
    expect(RoomPeerConnection.instances).toHaveLength(1);
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
    for (const track of [oldVideo, oldAudio, nextVideo, nextAudio, finalVideo, finalAudio]) expect(track.stop).not.toHaveBeenCalled();
    const clones = vi.mocked(finalVideo.clone).mock.calls.length;
    state.pairs[0].outgoing = [];
    media.update("a", state);
    state.pairs[0].outgoing = [{ id: "cancelled-rebind", publicationId: "screen", selected: true, inputFlowId: null }];
    media.update("a", state);
    media.reset(); // A queued slot rebind cannot acquire a clone after immediate close.
    expect(finalVideo.clone).toHaveBeenCalledTimes(clones);
  } finally { media.reset(); session.close(); }
});

test("a superseded source replacement failure cannot retire the latest source on the same flow", async () => {
  const { session, media, state, sent, pc } = await setupRoomMedia();
  const oldVideo = remoteTrack("video"), oldAudio = remoteTrack("audio");
  const nextVideo = remoteTrack("video"), nextAudio = remoteTrack("audio");
  const finalVideo = remoteTrack("video"), finalAudio = remoteTrack("audio");
  let finish!: () => void;
  const paused = new Promise<void>(resolve => { finish = resolve; });
  try {
    state.publications = [{ audience: [], id: "screen", roomId: "first", sessionId: "a", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }];
    media.setLocal("screen", remoteStream("old", [oldVideo, oldAudio]));
    state.pairs[0].outgoing = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    media.update("a", state);
    const [videoSender, audioSender] = pc.senders;
    const replace = vi.spyOn(videoSender, "replaceTrack").mockImplementationOnce(async () => {
      await paused;
      throw new Error("superseded source was rejected");
    });
    media.setLocal("screen", remoteStream("next", [nextVideo, nextAudio]));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    media.setLocal("screen", remoteStream("final", [finalVideo, finalAudio]));
    finish();
    await vi.waitFor(() => expect(pc.senders.map(sender => sender.track)).toEqual([lastClone(finalVideo), finalAudio]));
    expect(pc.senders).toEqual([videoSender, audioSender]);
    expect(RoomPeerConnection.instances).toHaveLength(1);
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
  } finally { finish(); media.reset(); session.close(); }
});

test("live picture settings apply to the same capture and senders, and a refused sender restores the old profile", async () => {
  const { session, media, state, sent, pc } = await setupRoomMedia(true);
  const video = Object.assign(remoteTrack("video"), {
    getCapabilities: () => ({ width: { min: 1, max: 3840 }, height: { min: 1, max: 2160 }, frameRate: { min: 1, max: 60 } }),
    getSettings: () => ({ width: 1920, height: 1080 }),
    applyConstraints: vi.fn(async (_constraints: MediaTrackConstraints) => {}),
  });
  const audio = remoteTrack("audio"), profile = QUALITY_PROFILES["1080p30"];
  try {
    state.publications = [{ audience: [], id: "screen", roomId: "first", sessionId: "a", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }];
    state.pairs[0].outgoing = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    media.setLocal("screen", remoteStream("source", [video, audio]), profile);
    media.update("a", state);
    const [sender, audioSender] = pc.senders;
    await vi.waitFor(() => expect(sender.getParameters().degradationPreference).toBe(profile.degradationPreference));
    const next = QUALITY_PROFILES["1080p60"];
    await media.configureLocal("screen", next);
    expect(video.applyConstraints).toHaveBeenLastCalledWith({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 60, max: 60 } });
    expect(sender.getParameters().encodings.map(value => [value.maxBitrate, value.maxFramerate])).toEqual([[2_000_000, 60], [8_000_000, 60]]);
    expect(pc.senders).toEqual([sender, audioSender]);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    const audioBefore = audioSender.getParameters();

    vi.spyOn(sender, "setParameters").mockRejectedValueOnce(new DOMException("unsupported profile", "OperationError"));
    await expect(media.configureLocal("screen", QUALITY_PROFILES["720p30"])).rejects.toThrow("unsupported profile");
    expect(video.applyConstraints).toHaveBeenLastCalledWith({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 60, max: 60 } });
    expect(sender.getParameters().encodings.map(value => [value.maxBitrate, value.maxFramerate])).toEqual([[2_000_000, 60], [8_000_000, 60]]);
    expect(audioSender.getParameters()).toEqual(audioBefore);

    vi.spyOn(sender, "setParameters").mockResolvedValueOnce();
    await expect(media.configureLocal("screen", QUALITY_PROFILES["720p30"])).rejects.toThrow("capture_quality_unsupported");
    expect(pc.senders).toEqual([sender, audioSender]);
    expect(RoomPeerConnection.instances).toHaveLength(1);
    expect(pc.close).not.toHaveBeenCalled();
    expect(video.stop).not.toHaveBeenCalled(); expect(audio.stop).not.toHaveBeenCalled();
    expect(sent.some(command => command.type === "flow_state" && command.state === "failed")).toBe(false);
  } finally { media.reset(); session.close(); }
});

test.each([false, true])("source replacement rescales the retained video sender and layer state (layered=%s)", async layered => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const failed = vi.fn(), outgoingFailed = vi.fn();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const transport = new ChannelTransport({ polite: true, iceServers: [], canReceiveVideoLayers: layered,
    send() {}, receive() {}, connected() {}, base() {}, failed, outgoingFailed });
  const pc = RoomPeerConnection.instances[0];
  const add = vi.spyOn(pc, "addTransceiver");
  const profile = QUALITY_PROFILES["1080p30"];
  const track = (width: number, height: number) => Object.assign(remoteTrack("video"), {
    getSettings: () => ({ width, height }),
  });
  const publish = (video: MediaStreamTrack) => transport.setOutgoing(new Map([
    ["screen-flow", { kind: "screen", stream: remoteStream("source", [video]), profile }],
  ]));
  try {
    publish(track(1920, 1080));
    const sender = pc.senders[0], binding = sender.stream;
    await vi.waitFor(() => expect(sender.getParameters().degradationPreference).toBe(profile.degradationPreference));
    const parameters = sender.getParameters();
    expect(parameters.encodings.map(encoding => encoding.rid)).toEqual(layered ? ["q", "h"] : [undefined]);
    parameters.encodings.forEach((encoding, index) => { encoding.active = index % 2 === 1; });
    parameters.codecs = [{ payloadType: 96, mimeType: "video/VP8", clockRate: 90_000 }];
    await sender.setParameters(parameters);
    const retained = parameters.encodings.map(({ scaleResolutionDownBy: _, ...encoding }) => encoding);
    for (const [width, height, expected] of [[3840, 2160, layered ? [4, 2] : [2]], [1280, 720, layered ? [2, 1] : [1]]] as const) {
      const video = track(width, height);
      publish(video);
      await vi.waitFor(() => expect(sender.getParameters().encodings.map(encoding => encoding.scaleResolutionDownBy)).toEqual(expected));
      expect(pc.senders).toEqual([sender]);
      expect(sender.track).toBe(lastClone(video));
      expect(sender.stream).toBe(binding);
      expect(binding.getTracks()).toEqual([video]);
      expect(sender.getParameters().encodings.map(({ scaleResolutionDownBy: _, ...encoding }) => encoding)).toEqual(retained);
      expect(sender.getParameters().codecs).toEqual(parameters.codecs);
    }
    // A rejected parameter adjustment warns without retiring a successful replacement.
    const rejected = new Error("parameter adjustment rejected");
    vi.spyOn(sender, "setParameters").mockRejectedValueOnce(rejected);
    const video = track(3840, 2160);
    publish(video);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("Channel source quality parameters could not be applied", { flowId: "screen-flow" }, rejected));
    await vi.waitFor(() => expect(binding.getTracks()).toEqual([video]));
    expect(sender.track).toBe(lastClone(video));
    expect(pc.senders).toEqual([sender]);
    expect(add).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(outgoingFailed).not.toHaveBeenCalled();
    expect(pc.close).not.toHaveBeenCalled();
  } finally { transport.close(); }
});

test.each(["new", "source", "audio", "ended"])("sender rejection retires only its failed %s work without affecting healthy outputs", async mode => {
  const replacing = mode !== "new";
  const survives = mode === "audio";
  const { session, media, state, sent, pc } = await setupRoomMedia();
  const oldVideo = remoteTrack("video"), video = mode === "audio" ? oldVideo : remoteTrack("video"), rejectedAudio = remoteTrack("audio");
  const kept = remoteTrack("audio"), following = remoteTrack("audio");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    pc.connected(); pc.channels[0].open();
    state.publications = [
      { audience: [], id: "screen", roomId: "first", sessionId: "a", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false },
      ...["kept", "following"].map(id => ({ audience: [], id, roomId: "first", sessionId: "a", userId: "self", kind: "voice" as const, paused: false })),
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
    const oldBinding = pc.senders.find(sender => sender.track === lastClone(oldVideo))?.stream;
    if (mode === "ended") {
      Object.defineProperty(oldVideo, "readyState", { value: "ended" });
      Object.defineProperty(lastClone(oldVideo), "readyState", { value: "ended" });
    }
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
    if (mode === "source" || mode === "ended") await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(pc.senders.map(sender => sender.track)).toEqual(survives ? [lastClone(oldVideo), kept, following] : [kept, following]);
    expect(pc.senders.find(sender => sender.track === kept)).toBe(keptSender);
    expect(oldBinding?.getTracks() ?? []).toEqual(survives ? [oldVideo] : []);
    const failedBinding = add.mock.calls.find(([track]) => track === rejectedAudio)![1];
    expect(failedBinding.getTracks()).toEqual(survives ? [oldVideo] : []);
    expect(sent.filter(command => command.type === "flow_state")).toEqual(survives ? [] : [
      { type: "flow_state", flowId: "screen-output", pairId: "pair", state: "failed" },
    ]);
    if (mode === "source" || mode === "ended") expect(warning).toHaveBeenCalledWith("Channel source replacement failed", { flowId: "screen-output" }, expect.any(DOMException));
    else expect(warning).toHaveBeenCalledWith("Channel media sender attach failed", { flowId: "screen-output", kind: "audio" }, expect.any(DOMException));
    if (!survives) {
      const attempts = add.mock.calls.length;
      media.update("a", state); media.update("a", state);
      expect(add).toHaveBeenCalledTimes(attempts);
    }
    state.pairs[0].outgoing.shift(); media.update("a", state);
    state.pairs[0].outgoing.push({ id: "renewed-screen-output", publicationId: "screen", selected: true, inputFlowId: null });
    add.mockImplementation(attach);
    media.update("a", state);
    await vi.waitFor(() => expect(pc.senders.map(sender => sender.track)).toEqual(expect.arrayContaining([kept, following, lastClone(video), rejectedAudio])));
    expect(pc.senders).toHaveLength(4);
    expect(pc.senders.find(sender => sender.track === lastClone(video))?.stream).toBe(failedBinding);
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();
    for (const track of [oldVideo, video, rejectedAudio, kept, following]) expect(track.stop).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test.each(["ended", "removetrack"])("a still-declared screen fails when its video is %s", async ending => {
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
    } else {
      tracks.pop();
      stream.dispatchEvent(new Event("removetrack"));
    }
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", state: "decoded" },
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", state: "failed" },
    ]);
    video.dispatchEvent(new Event("ended")); stream.dispatchEvent(new Event("removetrack"));
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(2);
    sent.length = 0;
    media.resync();
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", state: "failed" },
    ]);
    expect(video.stop).not.toHaveBeenCalled(); expect(pc.close).not.toHaveBeenCalled();
  } finally { media.reset(); session.close(); }
});

test("an announced screen withdrawal remaps the same flow without failing its physical pair", async () => {
  const fixture = await screenFixture();
  const { media, session, state, pc, sent, changed } = fixture;
  state.pairs[0].rooms = [];
  media.update("a", state);
  const old = remoteTrack("video"), next = remoteTrack("video");
  const oldStream = remoteStream("old", [old]), nextStream = remoteStream("new", [next]);
  let resolve!: (report: RTCStatsReport) => void;
  const pending = new Promise<RTCStatsReport>(done => { resolve = done; });
  try {
    pc.receivers = [{ track: old, getStats: async () => decodedReport(5) } as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    await vi.waitFor(() => expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1));
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "withdrawn" }, tracks: [] });
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("withdrawn"));
    expect(changed.mock.lastCall?.[1].has("screen")).toBe(false);
    expect(sent.filter(command => command.type === "flow_state")).toEqual([
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", state: "decoded" },
    ]);
    Object.defineProperty(old, "readyState", { value: "ended" }); old.dispatchEvent(new Event("ended"));
    oldStream.dispatchEvent(new Event("removetrack"));
    media.update("a", state);
    pc.receivers = [{ track: next, getStats: () => pending } as RTCRtpReceiver];
    await receiveScreen(fixture, nextStream);
    expect(sent.filter(command => command.type === "flow_state")).toHaveLength(1);
    resolve(decodedReport(1));
    await vi.waitFor(() => expect(sent.filter(command => command.type === "flow_state")).toHaveLength(2));
    expect(sent.filter(command => command.type === "flow_state" && command.state === "failed")).toEqual([]);
    expect(changed.mock.lastCall?.[1].get("screen")?.[0].stream).toBe(nextStream);
    expect(RoomPeerConnection.instances).toEqual([pc]);
    expect(pc.close).not.toHaveBeenCalled();
    expect(old.stop).not.toHaveBeenCalled(); expect(next.stop).not.toHaveBeenCalled();
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
  const { session, media, state, sent, pc } = await setupRoomMedia();
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
    media.update("a", state);
    expect(pc.channels).toHaveLength(3);
    const replacement = pc.channels[2];
    expect(replacement.label).toBe("piik-file");
    replacement.open();
    await media.sendData("z", "chunk", new Uint8Array([5]));
    bulk.onclose?.();
    await media.sendData("z", "chunk", new Uint8Array([6]));
    expect(replacement.send.mock.calls).toEqual([[new Uint8Array([5])], [new Uint8Array([6])]]);
    await media.sendData("z", "control", "still-open-after-replacement");
    expect(control.send).toHaveBeenLastCalledWith("still-open-after-replacement");
    expect(RoomPeerConnection.instances).toEqual([pc]);
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
    initializeRuntime: async () => {},
    FileDelivery: class { start() { return "[]"; } update() { return "[]"; } next_deadline() { return undefined; } cancel = cancel; free() {} },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async () => ({ createWritable: async () => ({ abort }) }), removeEntry,
  }) }) } });
  const files = new ChannelAttachments(async command => { if (command.type === "file_receive" && command.enabled) throw new Error("forbidden"); }, async () => {});
  files.update("session", { domainId: "domain", userId: "user" }, [], [], []);
  const key = { roomId: "room", messageSeq: 1, attachmentId: crypto.randomUUID() };
  const attachment = { id: key.attachmentId, name: "file", size: 1, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  try {
    await expect(files.download(key, attachment)).rejects.toThrow("forbidden");
    expect(cancel).toHaveBeenCalledWith(JSON.stringify(key));
    expect(abort).toHaveBeenCalledOnce(); expect(removeEntry).toHaveBeenCalledOnce();
    expect(files.status(key)).toEqual({ busy: false, error: "forbidden" });
  } finally { files.reset(); }
});

test.each(["initial", "resume"])("a stale %s file admission cannot retire a replacement download", async origin => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  const { readFile } = await import("node:fs/promises");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust, initializeRuntime: async () => {} } as never);
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("optional_cache_unavailable"));
  const source = "00000000-0000-0000-0000-000000000001", receiver = "00000000-0000-0000-0000-000000000002";
  const key = { roomId: "room", messageSeq: 1, attachmentId: "00000000-0000-0000-0000-000000000003" };
  const bytes = Uint8Array.from([1, 2, 3]), hash = new rust.AttachmentHash();
  hash.update(bytes);
  const attachment = { id: key.attachmentId, name: "owned.bin", size: bytes.length, mediaType: "application/octet-stream" as const, sha256: hash.finish() };
  const plan = { ...key, attachment, sourceId: source, upstream: source, downstream: [], receiving: true };
  const write = vi.fn(async (_value: unknown) => {}), aborts: ReturnType<typeof vi.fn>[] = [];
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async () => {
      const abort = vi.fn(async () => {}); aborts.push(abort);
      return { createWritable: async () => ({ write, close: async () => {}, abort }), getFile: async () => new File([bytes], "owned.bin") };
    }, removeEntry: async () => {},
  }) }) } });
  let enabled = 0, disabled = 0, rejectOld!: (error: Error) => void, acceptNew!: () => void;
  const pulls: string[] = [];
  const files = new ChannelAttachments(async command => {
    if (command.type !== "file_receive") return;
    if (command.enabled) {
      enabled += 1;
      if (enabled === 1 && origin === "initial") await new Promise<void>((_, reject) => { rejectOld = reject; });
      else if (enabled === 2) await new Promise<void>(resolve => { acceptNew = resolve; });
    } else if (++disabled === 2 && origin === "resume") await new Promise<void>((_, reject) => { rejectOld = reject; });
  }, async (_peer, kind, data, allowed) => {
    expect(allowed()).toBe(true);
    if (kind === "control" && JSON.parse(data as string).type === "pull") pulls.push(data as string);
  });
  const upstream = new rust.FileDelivery(source);
  upstream.update(JSON.stringify([{ ...plan, upstream: null, downstream: [receiver], receiving: false }]), JSON.stringify([[receiver, ["room"]]]), 0n);
  files.update(receiver, { domainId: "domain", userId: "user" }, [plan], [{ id: "room", authorized: true, available: true }] as never, [{ peerId: source, rooms: ["room"] }]);
  const oldAbort = new AbortController(), newAbort = new AbortController();
  const first = files.content(key, attachment, oldAbort.signal);
  void first.catch(() => {});
  try {
    await vi.waitFor(() => expect(enabled).toBe(1));
    oldAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    // A resumed projection can still contain the cancelled receive demand.
    if (origin === "resume") files.resume();
    const next = files.content(key, attachment, newAbort.signal);
    void next.catch(() => {});
    await vi.waitFor(() => expect(enabled).toBe(2));
    rejectOld(new Error("request_timeout"));
    acceptNew();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(aborts[0]).toHaveBeenCalledOnce();
    expect(aborts[1]).not.toHaveBeenCalled();
    // The real shared Rust source generates the response and the receiver
    // must write and verify it; the fixture does not synthesize delivery effects.
    const reads = JSON.parse(upstream.control(receiver, pulls.at(-1)!, 0n));
    for (const read of reads) if (read.type === "read") {
      const chunks = JSON.parse(upstream.read_result(JSON.stringify(read.key), BigInt(read.offset), read.requestId, bytes));
      for (const chunk of chunks) if (chunk.type === "send_chunk") files.data(source, "chunk", Uint8Array.from(chunk.frame));
    }
    await expect(next).resolves.toMatchObject({ size: bytes.length });
    expect(write).toHaveBeenCalledOnce();
    expect(aborts[1]).not.toHaveBeenCalled();
  } finally { newAbort.abort(); files.reset(); upstream.free(); }
});

test.each([true, false])("a verified download survives optional retention (stored=%s) and cleans only its temporary file", async stored => {
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  const { session } = await setup();
  const rooms = session.getSnapshot().state!.channel.rooms;
  session.close();
  const temporary = new File(["done"], "temporary"), durable = new File(["done"], "durable");
  const key = { roomId: "first", messageSeq: 1, attachmentId: crypto.randomUUID() };
  const attachment = { id: key.attachmentId, name: "download.bin", size: temporary.size, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  const close = vi.fn(async () => {}), removeEntry = vi.fn(async () => {});
  const retain = vi.spyOn(FileStore.prototype, "retain");
  if (stored) retain.mockResolvedValue({ file: durable, evicted: [] });
  else retain.mockRejectedValue(new DOMException("Full", "QuotaExceededError"));
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ initializeRuntime: async () => {},
    FileDelivery: class {
      start() { return "[]"; } update() { return "[]"; } next_deadline() { return undefined; } cancel() { return "[]"; } free() {}
      control() { return JSON.stringify([{ type: "complete", key }]); }
    },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async () => ({ createWritable: async () => ({ close, abort: async () => {} }), getFile: async () => temporary }), removeEntry,
  }) }) } });
  const command = vi.fn(async () => {});
  const files = new ChannelAttachments(command, async () => {});
  vi.spyOn(files, "limits").mockResolvedValue({ maxFileBytes: 100, maxInlineImageBytes: 65536, maxAttachmentsPerMessage: 8, maxRetainedBytes: 20, maxRetainedFiles: 2 });
  files.update("session", { domainId: "domain", userId: "user" }, [], rooms, []);
  try {
    const receiving = files.content(key, attachment, new AbortController().signal);
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ type: "file_receive", ...key, enabled: true }));
    expect(retain).not.toHaveBeenCalled();
    files.data("peer", "control", "verified-complete");
    await expect(receiving).resolves.toBe(stored ? durable : temporary);
    expect(close).toHaveBeenCalledOnce(); expect(retain).toHaveBeenCalledOnce();
    expect(removeEntry).toHaveBeenCalledTimes(stored ? 1 : 0);
    expect(command).toHaveBeenCalledWith({ type: "file_offer", ...key, sha256: attachment.sha256, available: true });
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
    state.publications = ["screen", "failed", "voice-0", "voice-1"].map(id => ({ audience: [],
      id, roomId: "first", sessionId: "a", userId: "self", paused: false,
      ...(id.startsWith("voice") ? { kind: "voice" as const } : { kind: "screen" as const, source: { kind: "screen" as const, name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]) }),
    }));
    media.setLocal("screen", remoteStream("picture", [video]));
    media.setLocal("failed", remoteStream("unavailable-picture", [failedVideo]));
    voices.forEach((track, index) => media.setLocal(`voice-${index}`, remoteStream(`voice-${index}`, [track])));
    state.pairs[0].outgoing = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    state.pairs.push({ id: "other", peerId: "zz", canReceiveVideoLayers: false, rooms: ["second"], incoming: [], outgoing: voices.map((_, index) => ({
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

    const companion = pc.getTransceivers().find(transceiver => transceiver.receiver.track.kind === "audio")!.sender;
    const add = vi.spyOn(companion, "replaceTrack");
    if (mode === "attach") add.mockRejectedValueOnce(new DOMException("audio still unavailable", "OperationError"));
    if (mode === "pair") state.pairs.pop(); else state.pairs[1].outgoing.shift();
    media.update("a", state);
    await exchange("pair", pc, false);
    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenLastCalledWith(audio);
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
    expect(pc.senders.map(sender => sender.track)).toEqual([lastClone(video), audio]);
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
  const exchange = async (trigger = true) => {
    if (trigger) pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0].some(signal => signal.description?.type === "offer")).toBe(true));
    const offer = sent[0].find(signal => signal.description?.type === "offer")!;
    right.signal(offer);
    await vi.waitFor(() => expect(sent[1].some(signal => signal.exchangeId === offer.exchangeId)).toBe(true));
    left.signal(sent[1].find(signal => signal.exchangeId === offer.exchangeId)!);
    await vi.waitFor(() => expect(pc.signalingState).toBe("stable"));
    sent[0].length = 0; sent[1].length = 0;
  };
  let releasePending: (() => void) | undefined;
  try {
    if (mode !== "channel") { left.setRooms(["room"]); right.setRooms(["room"]); }
    left.setOutgoing(outputs);
    if (mode !== "initial") await exchange();
    if (mode === "pending") {
      outputs.set("confirmed", { kind: "screen", stream: remoteStream("confirmed", [remoteTrack("video")]) });
      left.setOutgoing(outputs);
      pc.onnegotiationneeded?.();
      await vi.waitFor(() => expect(sent[0].some(signal => signal.description?.type === "offer")).toBe(true));
      const offer = sent[0].find(signal => signal.description?.type === "offer")!;
      right.signal(offer);
      await vi.waitFor(() => expect(sent[1].some(signal => signal.exchangeId === offer.exchangeId)).toBe(true));
      const answer = sent[1].find(signal => signal.exchangeId === offer.exchangeId)!;
      releasePending = () => left.signal(answer);
      outputs.set("candidate", { kind: "screen", stream: remoteStream("later-than-offer", [next]) });
      left.setOutgoing(outputs);
      sent[0].length = 0; sent[1].length = 0;
    }
    pc.connected(); remote.connected();
    for (const channel of pc.channels) channel.open();
    const established = pc.senders.filter(sender => sender.track !== lastClone(next)), wrapper = established[0].stream;
    if (mode === "audio") {
      outputs.set("screen", { kind: "screen", stream: remoteStream("with-audio", [picture, next]) });
    } else if (mode === "source") {
      outputs.set("screen", { kind: "screen", stream: remoteStream("withdrawn", []) });
      left.setOutgoing(outputs); // Only an actually detached sender can be reused.
      Object.defineProperty(next, "id", { value: picture.id });
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
    releasePending?.();
    let lateSender: typeof pc.senders[number] | undefined;
    if (mode === "channel") {
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
      left.setRooms(["room"]);
      for (const channel of pc.channels) channel.open();
      reject();
    }
    if (mode === "late") {
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
      lateSender = pc.senders.find(sender => sender.track === lastClone(next))!;
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
      expect(pc.senders.map(sender => sender.track)).toEqual([lastClone(picture), voice]);
      expect(sent[0]).toEqual([]);
      outputs.delete("voice"); // A real resource release permits the refused audio binding to be tried again.
      left.setOutgoing(outputs);
      await exchange(false);
      expect(pc.senders.map(sender => sender.track)).toEqual([lastClone(picture), next]);
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
    expect(pc.senders.some(sender => sender.track === lastClone(following))).toBe(true);
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
    await vi.waitFor(() => expect(sent[0].some(signal => signal.description?.type === "offer" && signal.exchangeId !== offer.exchangeId)).toBe(true));
    const replacement = sent[0].find(signal => signal.description?.type === "offer" && signal.exchangeId !== offer.exchangeId)!;
    expect(replacement.tracks).toEqual([{ flowId: "replacement-flow", streamId: offer.tracks![0].streamId }]);
    b.signal(replacement);
    await vi.waitFor(() => expect(sent[1].some(signal => signal.description?.type === "answer" && signal.exchangeId === replacement.exchangeId)).toBe(true));
    a.signal(sent[1].find(signal => signal.exchangeId === replacement.exchangeId)!);
    await vi.waitFor(() => expect(pcA.signalingState).toBe("stable"));
    a.signal(answer);
    a.signal({ resync: true }); // Stable transports have no pending offer to replay.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(remoteA).toHaveBeenCalledTimes(2);
    expect(remoteB).toHaveBeenCalledTimes(2);
    expect(failed.every(callback => callback.mock.calls.length === 0)).toBe(true);
    expect(pcA.close).not.toHaveBeenCalled(); expect(pcB.close).not.toHaveBeenCalled();
    expect(RoomPeerConnection.instances).toHaveLength(2);
  } finally { transports.forEach(transport => transport.close()); }
});

test.each([true, false])("an offer received during local offer creation follows queued collision policy: polite=%s", async polite => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const sent: ChannelSignal[] = [], failed = vi.fn();
  const transport = new ChannelTransport({ polite, iceServers: [], send: payload => sent.push(payload),
    receive() {}, connected() {}, base() {}, failed });
  const pc = RoomPeerConnection.instances[0], exchangeId = crypto.randomUUID();
  let finish!: (value: RTCSessionDescriptionInit) => void;
  const creating = vi.spyOn(pc, "createOffer").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const remote = vi.spyOn(pc, "setRemoteDescription");
  try {
    pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce());
    transport.signal({ exchangeId, description: { type: "offer", sdp: "remote-offer" }, tracks: [] });
    expect(remote).not.toHaveBeenCalled();
    finish({ type: "offer", sdp: "local-offer" });
    await vi.waitFor(() => expect(sent.some(value => value.description?.type === "offer")).toBe(true));
    if (polite) await vi.waitFor(() => expect(sent.some(value => value.exchangeId === exchangeId && value.description?.type === "answer")).toBe(true));
    else {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(remote).not.toHaveBeenCalled();
      expect(pc.signalingState).toBe("have-local-offer");
    }
    expect(failed).not.toHaveBeenCalled();
  } finally { transport.close(); }
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

test.each(["connected", "disconnected", "failed", "deadline"] as const)("a resumed welcome resyncs only the surviving %s transport", async mode => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const { session, socket } = await setup();
  vi.useFakeTimers();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.pairs = ["kept", "removed"].map(id => ({ id, peerId: "z", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [] }));
    socket.receive({ type: "state", state });
    const [kept, removed] = RoomPeerConnection.instances;
    const failed = mode === "failed" || mode === "deadline";
    if (mode !== "connected" && mode !== "deadline") { kept.connected(); kept.channels[0].open(); }
    removed.connected(); removed.channels[0].open();
    if (mode === "deadline") vi.advanceTimersByTime(19000);
    socket.close();
    if (mode === "connected") { kept.connected(); kept.channels[0].open(); }
    if (mode === "disconnected" || mode === "failed") { kept.connectionState = mode; kept.onconnectionstatechange?.(); }
    if (mode === "deadline") vi.advanceTimersByTime(1000);
    if (failed) { removed.connectionState = "failed"; removed.onconnectionstatechange?.(); }
    expect(socket.sent.filter(command => command.type === "link_state" && command.state === "failed")).toEqual([]);
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    state.pairs.pop();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    await vi.waitFor(() => expect(resumed.sent.filter(command => command.type === "signal")).toEqual(failed ? [] : [
      { type: "signal", pairId: "kept", payload: { resync: true } },
    ]));
    expect(resumed.sent.filter(command => command.type === "link_state" && command.state === "failed")).toEqual(failed ? [
      { type: "link_state", pairId: "kept", state: "failed" },
    ] : []);
    expect(resumed.sent.filter(command => command.type === "base_state")).toEqual(mode === "connected" ? [
      { type: "base_state", pairId: "kept", roomId: "first", ready: true },
    ] : []);
    expect(kept.close).toHaveBeenCalledTimes(failed ? 1 : 0);
    expect(removed.close).toHaveBeenCalledOnce();
    expect(RoomPeerConnection.instances).toHaveLength(2);
    expect(kept.channels).toHaveLength(2);
  } finally { session.close(); }
});

test("source replacement releases unmapped streams and ignores their late track events", async () => {
  RoomPeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const receive = vi.fn(), send = vi.fn();
  const transport = new ChannelTransport({ polite: true, iceServers: [], send, receive, connected: () => {}, base: () => {}, failed: vi.fn() });
  const pc = RoomPeerConnection.instances[0], stop = vi.fn();
  const stream = (id: string) => {
    const track = { stop };
    return { id, getTracks: () => [track] } as unknown as MediaStream;
  };
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
    pc.receivers = [{ track: fresh.getTracks()[0] } as RTCRtpReceiver];
    offer([["current-flow", current]]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    receive.mockClear();
    offer([["rebound-flow", fresh], ["current-flow", current]]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    expect(receive.mock.calls).toEqual([["current-flow", current], ["rebound-flow", fresh]]);
    expect(stop).not.toHaveBeenCalled();
  } finally { transport.close(); }
});

test("physical data channels can precede room leases without admitting retired work", async () => {
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  const base = vi.fn(), data = vi.fn(), failed = vi.fn(), dataState = vi.fn();
  const options = { iceServers: [], send() {}, receive() {}, connected() {}, base, data, failed, dataState };
  const mediaOnly = new ChannelTransport({ ...options, polite: false });
  mediaOnly.setRooms([]);
  expect(RoomPeerConnection.instances.at(-1)!.channels).toHaveLength(0);
  mediaOnly.close(); dataState.mockClear();
  const transport = new ChannelTransport({ ...options, polite: true });
  const pc = RoomPeerConnection.instances.at(-1)!;
  const incoming = pc.ondatachannel!;
  const arrive = () => {
    const channels = [new RoomDataChannel("piik-room", { ordered: true }), new RoomDataChannel("piik-file", { ordered: true })];
    for (const channel of channels) incoming({ channel });
    return channels;
  };
  try {
    pc.connected(); transport.setRooms([]);
    expect(dataState).toHaveBeenLastCalledWith(false);
    const [control, bulk] = arrive();
    transport.setRooms([]); transport.setRooms([]);
    expect([control.readyState, bulk.readyState]).toEqual(["connecting", "connecting"]);
    control.open(); bulk.open();
    control.onmessage?.({ data: "before admission" });
    await expect(transport.sendData("control", "before admission")).rejects.toThrow("peer_data_unavailable");
    expect(data).not.toHaveBeenCalled(); expect(base).not.toHaveBeenCalled();
    transport.setRooms(["room"]);
    expect(transport.isBaseReady()).toBe(true);
    control.onmessage?.({ data: "current room" });
    await transport.sendData("control", "current room");
    expect(data).toHaveBeenLastCalledWith("control", "current room");
    expect(control.send).toHaveBeenLastCalledWith("current room");

    bulk.bufferedAmount = 65536;
    const pending = expect(transport.sendData("chunk", new Uint8Array([1]))).rejects.toThrow("peer_data_unavailable");
    await Promise.resolve();
    const oldClose = control.onclose;
    transport.setRooms([]);
    await pending;
    expect([control.readyState, bulk.readyState]).toEqual(["closed", "closed"]);
    const [nextControl, nextBulk] = arrive();
    transport.setRooms([]); transport.setRooms(["room"]);
    nextControl.open(); nextBulk.open(); oldClose?.();
    expect(transport.isBaseReady()).toBe(true);
    nextControl.close();
    expect(base).toHaveBeenLastCalledWith(false);
    const [afterFailure, afterFailureBulk] = arrive();
    afterFailure.open(); afterFailureBulk.open();
    data.mockClear(); base.mockClear();
    afterFailure.onmessage?.({ data: "retired room" });
    transport.setRooms(["room"]);
    expect(transport.isBaseReady()).toBe(false);
    await expect(transport.sendData("control", "retired room")).rejects.toThrow("peer_data_unavailable");
    expect(data).not.toHaveBeenCalled(); expect(base).not.toHaveBeenCalled();
    transport.setRooms(["room", "added"]);
    expect(transport.isBaseReady()).toBe(true);
    await transport.sendData("control", "new admission");
    expect(afterFailure.send).toHaveBeenLastCalledWith("new admission");
    const duplicate = new RoomDataChannel("piik-room", { ordered: true }); incoming({ channel: duplicate });
    expect(duplicate.readyState).toBe("closed");
    expect(pc.close).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    afterFailure.close();
    const pendingAfterFailure = arrive();
    transport.close();
    expect([afterFailure.readyState, afterFailureBulk.readyState]).toEqual(["closed", "closed"]);
    expect(pendingAfterFailure.map(channel => channel.readyState)).toEqual(["closed", "closed"]);
    const lateInput = new RoomDataChannel("piik-input", { ordered: true }); incoming({ channel: lateInput });
    expect(lateInput.readyState).toBe("closed");
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
    sent.length = 0;
    media.resync();
    await vi.waitFor(() => expect(sent.filter(command => command.type === "base_state")).toEqual([
      { type: "base_state", pairId: "pair", roomId: "first", ready: false },
    ]));
    state.pairs[0].rooms.push("second");
    media.update("a", state);
    expect(pc.channels).toHaveLength(4);
    expect(pc.channels.slice(0, 2).map(channel => channel.readyState)).toEqual(["closed", "closed"]);
    const [control, bulk] = pc.channels.slice(2);
    control.open(); bulk.open();
    await media.sendData("z", "control", "recovered");
    await media.sendData("z", "chunk", new Uint8Array([1]));
    expect(control.send).toHaveBeenLastCalledWith("recovered");
    expect(bulk.send).toHaveBeenLastCalledWith(new Uint8Array([1]));
    expect(RoomPeerConnection.instances).toEqual([pc]);
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

test("a base deadline settles missing-channel sends while polite screen media stays connected", async () => {
  vi.useFakeTimers();
  const { session, media, state, sent, pc } = await setupRoomMedia(false, "zz");
  const video = remoteTrack("video"), stream = remoteStream("picture", [video]);
  const outcomes: string[] = [];
  const send = (kind: "control" | "chunk") => media.sendData("z", kind, kind === "control" ? "history" : new Uint8Array([1]))
    .then(() => { outcomes.push(`${kind}:sent`); }, (error: Error) => { outcomes.push(`${kind}:${error.message}`); });
  try {
    state.publications = [{ audience: [], id: "screen", roomId: "first", sessionId: "zz", userId: "self", kind: "screen", source: { kind: "screen", name: null }, title: null,
      videoSettings: screenVideoSettings(QUALITY_PROFILES["720p30"]), paused: false }];
    state.pairs[0].outgoing = [{ id: "screen-flow", publicationId: "screen", selected: true, inputFlowId: null }];
    media.setLocal("screen", stream, QUALITY_PROFILES["720p30"]);
    media.update("zz", state);
    pc.connected();
    expect(pc.channels).toHaveLength(0);
    expect(pc.senders).toHaveLength(1);
    const sender = pc.senders[0];
    const control = send("control"), chunk = send("chunk");
    await vi.advanceTimersByTimeAsync(20000);
    expect(sent).toContainEqual({ type: "base_state", pairId: "pair", roomId: "first", ready: false });
    expect(pc.close).not.toHaveBeenCalled();
    expect(pc.senders).toEqual([sender]);
    expect(video.stop).not.toHaveBeenCalled();
    expect([...outcomes].sort()).toEqual(["chunk:peer_data_unavailable", "control:peer_data_unavailable"]);
    await Promise.all([control, chunk]);
    const afterFailure = send("control");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.at(-1)).toBe("control:peer_data_unavailable");
    await afterFailure;
  } finally { media.reset(); session.close(); }
});

test("browsing keeps watched-room reading and resumes the offline selection without ending subscriptions", async () => {
  const { session, socket } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.publications = [{ audience: [], id: "screen", roomId: "first", sessionId: "other", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }];
    socket.receive({ type: "state", state });
    const watching = session.watch("screen");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await watching;
    state.subscriptions = ["screen"];
    socket.receive({ type: "state", state });
    session.browse("second");
    const second = socket.sent.at(-1)!;
    expect(second).toMatchObject({ type: "browse", roomId: "second", active: true });
    expect(socket.sent.some(command => command.type === "browse" && command.active === false)).toBe(false);
    socket.receive({ type: "ack", requestId: second.requestId });
    await vi.waitFor(() => expect(session.getSnapshot().interactionsByRoom.get("second")?.getSnapshot().ready).toBe(true));
    expect(socket.sent.some(command => command.type === "browse" && command.roomId === "first" && command.active === false)).toBe(false);
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    socket.close();
    const count = socket.sent.length;
    session.browse("first");
    expect(socket.sent).toHaveLength(count);
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    state.channel.rooms.forEach(room => { room.reading = room.id === "second"; });
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    const first = resumed.sent.findLast(command => command.type === "browse" && command.roomId === "first" && command.active)!;
    expect(first).toMatchObject({ type: "browse", roomId: "first", active: true });
    expect(resumed.sent.some(command => command.type === "browse" && command.active === false)).toBe(false);
    resumed.receive({ type: "ack", requestId: first.requestId });
    await vi.waitFor(() => expect(resumed.sent.at(-1)).toEqual({ type: "browse", roomId: "second", active: false }));
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    expect(resumed.sent.some(command => ["unpublish", "voice"].includes(String(command.type))
      || command.type === "subscribe" && command.enabled === false)).toBe(false);
  } finally { session.close(); }
});

test("relay overrides persist per room only after acceptance and accompany read admission", async () => {
  const { session, socket } = await setup();
  const values = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  const preferences = () => JSON.parse(values.get("piik:room-preferences:v1") ?? "{}").relayCapacityByRoom;
  try {
    const stopping = session.setRelayOverride("first", 0);
    const first = socket.sent.at(-1)!;
    expect(first).toMatchObject({ type: "relay_capacity", roomId: "first", capacity: 0 });
    expect(preferences()).toBeUndefined();
    socket.receive({ type: "room_reply", roomId: "first", requestId: first.requestId, result: { type: "done" } });
    await stopping;
    expect(preferences()).toEqual({ "domain/first": 0 });

    const rejected = session.setRelayOverride("first", null);
    const refusal = expect(rejected).rejects.toThrow("forbidden");
    socket.receive({ type: "room_reply", roomId: "first", requestId: socket.sent.at(-1)!.requestId,
      result: { type: "error", code: "forbidden" } });
    await refusal;
    expect(preferences()).toEqual({ "domain/first": 0 });

    const state = structuredClone(session.getSnapshot().state!);
    socket.close(); session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    expect(resumed.sent.some(command => command.type === "relay_capacity")).toBe(false);
    const browse = resumed.sent.findLast(command => command.type === "browse" && command.active)!;
    expect(browse).toMatchObject({ roomId: "first", relayCapacity: 0 });
    resumed.receive({ type: "ack", requestId: browse.requestId });

    const resetting = session.setRelayOverride("first", null);
    resumed.receive({ type: "room_reply", roomId: "first", requestId: resumed.sent.at(-1)!.requestId, result: { type: "done" } });
    await resetting;
    expect(preferences()).toEqual({});
  } finally { session.close(); }
});

test("live chat overlays follow each watched room and never replay loaded history", async () => {
  const { session, socket, peer } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.publications = [{ audience: [], id: "screen", roomId: "first", sessionId: "other", userId: "friend", kind: "screen", source: { kind: "screen", name: null }, title: null,
      videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }];
    socket.receive({ type: "state", state });
    const watching = session.watch("screen");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await watching;
    state.subscriptions = ["screen"];
    socket.receive({ type: "state", state });
    const first = session.getSnapshot().interactionsByRoom.get("first")!;
    session.browse("second");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    peer.page(await peer.next(), [], false, null);
    await vi.waitFor(() => expect(session.getSnapshot().interactionsByRoom.get("second")?.getSnapshot().ready).toBe(true));
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:second")).toBe(false));
    const second = session.getSnapshot().interactionsByRoom.get("second")!;
    first.setOverlayEnabled(true); second.setOverlayEnabled(true);
    const stopFirst = first.showOverlay(), stopSecond = second.showOverlay();
    const firstMessage = { ...message(1), time: Date.now(), text: "First room" };
    const secondMessage = { ...message(2), time: Date.now(), text: "Second room" };
    peer.live(firstMessage, "first"); peer.live(firstMessage, "first");
    peer.live(secondMessage, "second");
    expect(first.getSnapshot().overlayMessages.map(value => value.id)).toEqual([firstMessage.id]);
    expect(second.getSnapshot().overlayMessages.map(value => value.id)).toEqual([secondMessage.id]);
    const latest = session.loadLatestHistory("second");
    peer.page(await peer.next(), [{ ...message(3), time: Date.now() }], false);
    await latest;
    expect(second.getSnapshot().overlayMessages.map(value => value.id)).toEqual([secondMessage.id]);
    const longMessage = { ...message(4), time: Date.now(), text: `A multiline message\n${"界🙂".repeat(180)}` };
    peer.live(longMessage, "second");
    const summary = second.getSnapshot().messages.find(value => value.id === longMessage.id)!.payload;
    expect(summary.kind).toBe("chat");
    if (summary.kind === "chat") {
      expect(Array.from(summary.text)).toHaveLength(280);
      expect(summary.text).not.toContain("\n");
      expect(summary.text.endsWith("…")).toBe(true);
    }
    expect(session.getSnapshot().messagesByRoom.second.find(value => value.id === longMessage.id)?.text).toBe(longMessage.text);
    const unwatching = session.unwatch("screen");
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await unwatching;
    state.subscriptions = [];
    socket.receive({ type: "state", state });
    await vi.waitFor(() => expect(session.getSnapshot().interactionsByRoom.has("first")).toBe(false));
    expect(first.getSnapshot().overlayMessages).toEqual([]);
    expect(second.getSnapshot().ready).toBe(true);
    stopFirst(); stopSecond();
  } finally { session.close(); }
});

test.each(["before", "after"])("rapid browsing retires unprojected intents only after the selected room is ready (old reply %s)", async order => {
  const { session, socket, peer } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms.forEach(room => { room.reading = false; });
    state.channel.rooms.push({ ...state.channel.rooms[1], id: "third", name: "third" });
    socket.receive({ type: "state", state });
    const start = socket.sent.length;
    session.browse("second");
    const second = socket.sent.at(-1)!;
    session.browse("third");
    const third = socket.sent.at(-1)!;
    expect(socket.sent.slice(start)).toEqual([
      expect.objectContaining({ type: "browse", roomId: "second", active: true }),
      expect.objectContaining({ type: "browse", roomId: "third", active: true }),
    ]);
    if (order === "before") {
      socket.receive({ type: "ack", requestId: second.requestId });
      await Promise.resolve();
      expect(socket.sent.slice(start)).toHaveLength(2);
      expect(peer.sent).toEqual([]);
    }
    socket.receive({ type: "room_reply", roomId: "third", requestId: third.requestId, result: { type: "done" } });
    const history = await peer.next();
    expect(history).toMatchObject({ type: "history", roomId: "third" });
    const interaction = session.getSnapshot().interactionsByRoom.get("third");
    if (order === "after") {
      peer.reply(history, { type: "error", code: "storage_failed" });
      await vi.waitFor(() => expect(session.getSnapshot().error).toBe("storage_failed"));
      expect(interaction).toBeDefined();
      expect(session.getSnapshot().interactionsByRoom.get("third")).toBe(interaction);
      const count = socket.sent.length;
      session.browse("third");
      expect(socket.sent).toHaveLength(count);
      expect(session.getSnapshot().historyByRoom.third).toBeUndefined();
      const loading = session.loadLatestHistory("third"), latest = await peer.next();
      peer.page(latest, [message(1)], false, 1);
      await loading;
      expect(session.getSnapshot().historyByRoom.third).toMatchObject({ atLatest: true, hasMore: false });
      expect(session.getSnapshot().messagesByRoom.third).toEqual([message(1)]);
      expect(session.getSnapshot().interactionsByRoom.get("third")).toBe(interaction);
    } else peer.page(history, [], false, null);
    expect(socket.sent.slice(start + 2)).toEqual([
      { type: "browse", roomId: "first", active: false },
      { type: "browse", roomId: "second", active: false },
    ]);
    if (order === "after") socket.receive({ type: "ack", requestId: second.requestId });
    await Promise.resolve();
    expect(peer.sent).toHaveLength(order === "after" ? 2 : 1);
    expect(socket.sent.some(command => command.type === "browse" && command.roomId === "third" && command.active === false)).toBe(false);
  } finally { session.close(); }
});

test.each(["error", "unavailable", "unauthorized"])("failed browse acquisition releases old read intent without reviving late replies (%s)", async failure => {
  const { session, socket, peer } = await setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    const start = socket.sent.length;
    session.browse("second");
    const second = socket.sent.at(-1)!;
    expect(socket.sent.slice(start)).toEqual([expect.objectContaining({ type: "browse", roomId: "second", active: true })]);
    if (failure === "error") socket.receive({ type: "error", requestId: second.requestId, code: "room_forbidden" });
    else {
      if (failure === "unavailable") state.channel.rooms[1].available = false;
      else state.channel.rooms[1].authorized = false;
      socket.receive({ type: "state", state });
    }
    await vi.waitFor(() => expect(socket.sent.slice(start)).toContainEqual({ type: "browse", roomId: "first", active: false }));
    if (failure === "error") expect(socket.sent.at(-1)).toEqual({ type: "browse", roomId: "second", active: false });
    socket.receive({ type: "ack", requestId: second.requestId });
    await Promise.resolve();
    expect(peer.sent).toEqual([]);
    session.browse("first");
    const first = socket.sent.at(-1)!;
    socket.receive({ type: "ack", requestId: first.requestId });
    const history = await peer.next();
    expect(history.roomId).toBe("first");
    peer.page(history, [], false, null);
    if (failure === "unavailable") {
      const beforeResume = socket.sent.length;
      state.channel.rooms[1].available = true;
      state.channel.rooms[1].reading = true;
      socket.receive({ type: "state", state });
      await vi.waitFor(() => expect(socket.sent.slice(beforeResume)).toEqual([{ type: "browse", roomId: "second", active: false }]));
    }
  } finally { session.close(); }
});

test("reconnect retires unprojected old read intents only after the selected read is ready", async () => {
  const { session, socket, peer } = await setup();
  try {
    session.browse("second");
    const second = socket.sent.at(-1)!;
    const state = structuredClone(session.getSnapshot().state!);
    expect(state.channel.rooms[1].reading).toBe(false);
    socket.close();
    session.browse("first");
    session.reconnect();
    const resumed = ChannelSocket.current;
    await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    const first = resumed.sent.at(-1)!;
    expect(first).toMatchObject({ type: "browse", roomId: "first", active: true });
    expect(resumed.sent.some(command => command.type === "browse" && command.active === false)).toBe(false);
    socket.receive({ type: "ack", requestId: second.requestId });
    expect(peer.sent).toEqual([]);
    resumed.receive({ type: "ack", requestId: first.requestId });
    const history = await peer.next();
    expect(history.roomId).toBe("first");
    peer.page(history, [], false, null);
    expect(resumed.sent.at(-1)).toEqual({ type: "browse", roomId: "second", active: false });
    expect(resumed.sent.some(command => command.type === "browse" && command.roomId === "first" && command.active === false)).toBe(false);
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
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await Promise.resolve();
    state.channel.rooms[1].reading = true;
    socket.receive({ type: "state", state });
    const beforeResume = socket.sent.length;
    state.channel.rooms[0].available = true;
    socket.receive({ type: "state", state });
    await vi.waitFor(() => expect(socket.sent.slice(beforeResume)).toEqual([{ type: "browse", roomId: "first", active: false }]));
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
      { audience: [], id: "voice-a", roomId: "first", sessionId: "z", userId: "other", kind: "voice", paused: false },
      { audience: [], id: "voice-b", roomId: "first", sessionId: "a", userId: "self", kind: "voice", paused: false },
    ];
    state.pairs[0].incoming = [{ id: "voice-a-in", publicationId: "voice-a", selected: true, inputFlowId: null }];
    state.pairs[0].outgoing = [{ id: "voice-b-out", publicationId: "voice-b", selected: true, inputFlowId: null }];
    state.pairs.push({ id: "downstream", peerId: "y", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: "voice-a-out", publicationId: "voice-a", selected: true, inputFlowId: "voice-a-in" }] });
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
    expect(consumer.tagName).toBe("AUDIO");
    expect(consumer.muted && consumer.hidden && consumer.autoplay).toBe(true);
    expect(consumer.srcObject?.getTracks()).toEqual([aTrack]);
    expect(consumer.play).toHaveBeenCalledOnce();
    state.pairs.push({ id: "another-child", peerId: "x", canReceiveVideoLayers: false, rooms: ["first"], incoming: [], outgoing: [{ id: "voice-a-another-out", publicationId: "voice-a", selected: true, inputFlowId: "voice-a-in" }] });
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


test("history timeout remains explicit until a Domain retry, independently of peer readiness", async () => {
  vi.useFakeTimers();
  const { session, socket, peer } = await setup(1000, false);
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].delivery!.nextHops = {};
    socket.receive({ type: "state", state });
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.getSnapshot().error).toBe("request_timeout");
    state.channel.rooms[0].delivery!.nextHops = { host: "unused-peer" };
    socket.receive({ type: "state", state });
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.sent).toHaveLength(1);
    const loading = session.loadLatestHistory("first");
    await vi.advanceTimersByTimeAsync(0);
    peer.page(peer.sent.at(-1)!, [message(7)]);
    await loading;
    expect(session.getSnapshot().messagesByRoom.first.map(value => value.seq)).toEqual([7]);
    expect(session.getSnapshot().error).toBeNull();
  } finally { session.close(); }
});
test("browse admission gates Domain history and reconnect cancels the old socket before refreshing", async () => {
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
    expect(session.getSnapshot().error).toBeNull();
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
    expect(await peer.next()).toMatchObject({ type: "history", roomId: "second" });
    expect(peer.sent).toHaveLength(3);
    session.reconnect();
    await canceled;
    delivery.nextHops = { host: "host" };
    const resumed = ChannelSocket.current; await resumed.onopen?.();
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    expect(peer.sent).toHaveLength(3);
    const browse = resumed.sent.findLast(command => command.type === "browse" && command.active)!;
    resumed.receive({ type: "ack", requestId: browse.requestId });
    expect(await peer.next()).toMatchObject({ type: "history", roomId: "second" });
    expect(peer.sent).toHaveLength(4);
    expect(resumed.sent.some(command => command.type === "history")).toBe(false);
  } finally { session.close(); }
});

async function setupRoomBackup() {
  const policy = JSON.stringify({ id: "first", creatorId: "self", name: "First", icon: "couch", access: "public", hidden: false });
  const row = { ...message(1), nonce: "sent-once" };
  const rows = () => (async function* () { yield row; })();
  const snapshot = { policy, get rows() { return rows(); }, close: vi.fn(async () => {}) };
  const stage = { policy, get rows() { return rows(); }, append: vi.fn(async () => {}), replace: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const host = {
    roomId: "first", summary: () => ({ id: "first", name: "First", icon: "couch", creatorId: "self", access: "public", hidden: false, hasPassword: false }),
    bind: vi.fn(async () => {}), close: vi.fn(async () => {}), snapshot: vi.fn(async () => snapshot),
  };
  const nextHost = { ...host, close: vi.fn(async () => {}), bind: vi.fn(async () => {}) };
  const open = vi.fn().mockResolvedValueOnce(host).mockResolvedValue(nextHost);
  vi.stubGlobal("indexedDB", {});
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({
    initializeRuntime: async () => {},
    attachment_limits: () => JSON.stringify({ maxFileBytes: 1024, maxInlineImageBytes: 65536, maxAttachmentsPerMessage: 8, maxRetainedBytes: 1024, maxRetainedFiles: 8 }),
    BrowserRoomHost: { storedPolicies: async () => [policy], open, stage: vi.fn(async () => stage) },
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const context = await setup();
  await vi.waitFor(() => expect(context.socket.sent.some(command => command.type === "host_register")).toBe(true));
  const register = context.socket.sent.find(command => command.type === "host_register")!;
  const state = structuredClone(context.session.getSnapshot().state!);
  state.channel.rooms[0].delivery = { hostSessionId: "endpoint", bindingId: "binding", nextHops: {} };
  context.socket.receive({ type: "state", state });
  context.socket.receive({ type: "host_bound", roomId: "first", bindingId: "binding" });
  context.socket.receive({ type: "ack", requestId: register.requestId });
  const metadata = { kind: "room" as const, version: 2 as const, domainId: "domain", policy: JSON.parse(policy), retainedFiles: [] };
  const read = vi.spyOn(backupArchive, "readBackup").mockImplementation(async (_blob, visitor) => {
    await visitor?.metadata(metadata); await visitor?.row(row); return metadata;
  });
  return { ...context, host, nextHost, snapshot, stage, row, state, metadata, open, read };
}

async function startBackupActivities({ session, socket, state }: Awaited<ReturnType<typeof setupRoomBackup>>, rooms = ["first"]) {
  const observed = new Set(socket.sent);
  const next = async (type: string) => {
    await vi.waitFor(() => expect(socket.sent.some(command => command.type === type && !observed.has(command))).toBe(true));
    const command = socket.sent.find(command => command.type === type && !observed.has(command))!;
    observed.add(command);
    return command;
  };
  const publish = async (work: Promise<unknown>) => {
    const command = await next("publish");
    const publication = publicationSchema.parse({ audience: [], ...((command.publication as { kind: string }).kind === "screen" ? { title: null } : {}), ...(command.publication as object), sessionId: "endpoint", userId: "self", paused: false });
    state.publications.push(publication);
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: command.requestId });
    await work;
    return publication.id;
  };
  const activities = new Map<string, { screen: MediaStreamTrack; voice: MediaStreamTrack; screenId: string; voiceId: string; watchedId: string }>();
  for (const roomId of rooms) {
    const screen = remoteTrack("video"), voice = remoteTrack("audio");
    const screenId = await publish(session.publish("screen", roomId, new RoomMediaStream([screen]) as unknown as MediaStream));
    const joining = session.joinVoice(roomId, false, new RoomMediaStream([voice]) as unknown as MediaStream);
    const join = await next("voice");
    state.voice.push({ roomId, sessionId: "endpoint", muted: false, deafened: false });
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: join.requestId });
    const voiceId = await publish(joining);
    const watchedId = `watched-${roomId}`;
    state.publications.push({ audience: [], id: watchedId, roomId, sessionId: "remote", userId: "other", kind: "screen", source: { kind: "screen", name: null }, title: null,
      videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false });
    socket.receive({ type: "state", state });
    const watching = session.watch(watchedId);
    const subscribe = await next("subscribe");
    state.subscriptions.push(watchedId);
    socket.receive({ type: "state", state });
    socket.receive({ type: "ack", requestId: subscribe.requestId });
    await watching;
    activities.set(roomId, { screen, voice, screenId, voiceId, watchedId });
  }
  return activities;
}

test("domain backup uses its actual service owner and validates kind before retiring the current session", async () => {
  const { session, socket } = await setup();
  const archive = new Blob(["domain-checkpoint"]), fetch = vi.fn().mockResolvedValue(new Response(archive));
  vi.stubGlobal("fetch", fetch);
  const read = vi.spyOn(backupArchive, "readBackup").mockImplementation(async (_blob, visitor) => {
    const metadata = { kind: "room" as const, version: 2 as const, domainId: "domain", policy: { id: "first", creatorId: "self", name: "First", icon: "couch", voiceBitrate: 64000, relayCapacity: 2 }, retainedFiles: [] };
    await visitor?.metadata(metadata); return metadata;
  });
  try {
    expect(await (await session.exportDomainBackup()).text()).toBe("domain-checkpoint");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("/prototype/channel/backup");
    expect(new Headers(fetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer credential");
    await expect(session.restoreDomainBackup(archive)).rejects.toThrow("expected_domain_backup");
    expect(read).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
    expect(session.getSnapshot().connection).toBe("connected"); expect(socket.readyState).toBe(1);
    const state = structuredClone(session.getSnapshot().state!); state.channel.ownerId = "another-owner";
    socket.receive({ type: "state", state });
    await expect(session.exportDomainBackup()).rejects.toThrow("forbidden"); expect(fetch).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

test("domain restore closes the old connection, admits archived keys only after HTTP commit and verifies Welcome before saving identity", async () => {
  const { session, socket } = await setup(3, false, "owner=old-key&room=old-room");
  const domainId = crypto.randomUUID(), ownerId = crypto.randomUUID();
  const metadata = { kind: "domain" as const, version: 3 as const, state: { id: domainId, ownerId, name: "Restored", icon: "couch", hostedRooms: {} }, ownerKey: "restored-owner" };
  const inspect = vi.spyOn(backupArchive, "readBackup").mockResolvedValue(metadata);
  let answer!: (response: Response) => void;
  const fetch = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(resolve => { answer = resolve; })); vi.stubGlobal("fetch", fetch);
  const saved = vi.fn(); vi.stubGlobal("localStorage", { getItem: () => null, setItem: saved });
  const state = structuredClone(session.getSnapshot().state!);
  state.channel.id = domainId; state.channel.ownerId = ownerId; state.channel.rooms = [];
  state.users = [{ id: ownerId, name: "Restored owner", version: profileVersion }]; state.sessions[0].userId = ownerId;
  try {
    const archive = new Blob(["complete-domain-zip"]);
    const restoring = session.restoreDomainBackup(archive);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(socket.readyState).toBe(3); expect(session.getSnapshot().connection).toBe("closed");
    expect(new Headers(fetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer credential");
    expect(fetch.mock.calls[0][1].method).toBe("PUT"); expect(saved).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith(archive);
    expect(fetch.mock.calls[0][1].body).toBe(archive);
    answer(new Response(JSON.stringify({ domainId })));
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const admission = ChannelSocket.current; await admission.onopen?.();
    const join = admission.sent.find(command => command.type === "join")!;
    expect(join).toMatchObject({ ownerKey: "restored-owner" });
    for (const field of ["credential", "sessionId", "roomId"]) expect(join).not.toHaveProperty(field);
    expect(saved).not.toHaveBeenCalled();
    admission.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "restored-personal-credential", sessionId: "endpoint", state });
    await expect(restoring).resolves.toEqual({ name: state.channel.name, icon: state.channel.icon });
    expect(session.getSnapshot().self?.id).toBe(ownerId); expect(session.getSnapshot().state?.channel.id).toBe(domainId);
    expect(saved).toHaveBeenCalledWith("piik.channel.prototype.credential", "restored-personal-credential");
    expect(saved.mock.calls.some(call => call[1] === metadata.ownerKey)).toBe(false);
  } finally { session.close(); }
});

test("invalid domain user preflight preserves the current connection and never uploads", async () => {
  const { session, socket } = await setup();
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  vi.spyOn(backupArchive, "readBackup").mockRejectedValue(new Error("invalid_state"));
  const before = session.getSnapshot(), close = vi.spyOn(socket, "close");
  try {
    await expect(session.restoreDomainBackup(new Blob(["invalid users.ndjson"]))).rejects.toThrow("invalid_state");
    expect(fetch).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", sessionId: before.sessionId, state: before.state });
  } finally { session.close(); }
});

test("a rejected domain replacement restarts the unchanged personal identity without importing its keys", async () => {
  const { session, socket } = await setup();
  const state = structuredClone(session.getSnapshot().state!);
  const metadata = { kind: "domain" as const, version: 3 as const, state: { id: crypto.randomUUID(), ownerId: crypto.randomUUID(), name: "Restored", icon: "couch", hostedRooms: {} }, ownerKey: "not-committed" };
  vi.spyOn(backupArchive, "readBackup").mockImplementation(async (_blob, visitor) => { await visitor?.metadata(metadata); return metadata; });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "restore_rejected" }), { status: 409 })));
  try {
    await expect(session.restoreDomainBackup(new Blob())).rejects.toThrow("restore_rejected");
    const resumed = ChannelSocket.current; expect(resumed).not.toBe(socket); await resumed.onopen?.();
    expect(resumed.sent.find(command => command.type === "join")).toMatchObject({ credential: "credential" });
    expect(resumed.sent.some(command => command.ownerKey === metadata.ownerKey)).toBe(false);
    resumed.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    expect(session.getSnapshot().self?.id).toBe("self");
    expect(session.getSnapshot().pending.has("domain-backup")).toBe(false);
  } finally { session.close(); }
});

test("domain admission does not save a Welcome whose current owner differs from the restored authority", async () => {
  const { session, socket } = await setup();
  const domainId = crypto.randomUUID(), metadata = { kind: "domain" as const, version: 3 as const,
    state: { id: domainId, ownerId: "self", name: "Restored", icon: "couch", hostedRooms: {} }, ownerKey: "restored-owner" };
  vi.spyOn(backupArchive, "readBackup").mockImplementation(async (_blob, visitor) => { await visitor?.metadata(metadata); return metadata; });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ domainId }))));
  const saved = vi.fn(); vi.stubGlobal("localStorage", { getItem: () => null, setItem: saved });
  const state = structuredClone(session.getSnapshot().state!); state.channel.id = domainId; state.channel.ownerId = "another-owner";
  try {
    const restoring = session.restoreDomainBackup(new Blob()), rejected = expect(restoring).rejects.toThrow("domain_restored_connection_failed");
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const admission = ChannelSocket.current; await admission.onopen?.();
    admission.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "not-verified", sessionId: "endpoint", state });
    await rejected; expect(saved).not.toHaveBeenCalled();
    expect(session.getSnapshot().state).toBeNull(); expect(admission.readyState).toBe(3);
    expect(session.getSnapshot().pending.has("domain-backup")).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

test("a committed domain restore with unavailable hosting keeps the restored identity for reconnect", async () => {
  const { session, socket } = await setup();
  const oldState = structuredClone(session.getSnapshot().state!);
  const domainId = crypto.randomUUID(), ownerId = crypto.randomUUID();
  const metadata = { kind: "domain" as const, version: 3 as const,
    state: { id: domainId, ownerId, name: "Restored", icon: "couch", hostedRooms: {} }, ownerKey: "restored-owner" };
  vi.spyOn(backupArchive, "readBackup").mockImplementation(async (_blob, visitor) => { await visitor?.metadata(metadata); return metadata; });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "domain_restored_connection_failed" }), { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  const saved = vi.fn(); vi.stubGlobal("localStorage", { getItem: () => null, setItem: saved });
  try {
    const restoring = session.restoreDomainBackup(new Blob());
    const failed = expect(restoring).rejects.toThrow("domain_restored_connection_failed");
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    const admission = ChannelSocket.current; await admission.onopen?.();
    expect(admission.sent.find(command => command.type === "join")).toMatchObject({ ownerKey: metadata.ownerKey });
    expect(admission.sent.find(command => command.type === "join")).not.toHaveProperty("credential");
    admission.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "old-authority", sessionId: "endpoint", state: oldState });
    await failed;
    expect(saved).not.toHaveBeenCalled();
    session.reconnect();
    const retry = ChannelSocket.current; await retry.onopen?.();
    expect(retry.sent.find(command => command.type === "join")).toMatchObject({ ownerKey: metadata.ownerKey });
    expect(retry.sent.find(command => command.type === "join")).not.toHaveProperty("credential");
    expect(fetch).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

test("room backup exports its actual Browser host snapshot, full nonce/reactions and only matching retained copies", async () => {
  const list = vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  const retain = vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("quota"));
  const { session, host, snapshot, row } = await setupRoomBackup();
  const attachment = { id: "file", name: "pixel.png", size: 3, mediaType: "image/png" as const, sha256: "a".repeat(64) };
  row.attachments.push(attachment as never);
  row.reactions = { revision: 2, counts: { wave: 2 } };
  const file = new File([new Uint8Array([1, 2, 3])], attachment.name);
  list.mockResolvedValue([
    { key: { roomId: "first", messageSeq: 77, attachmentId: "stale" }, attachment: { ...attachment, id: "stale" }, file },
  ]);
  let exported: unknown[] = [];
  const write = vi.spyOn(backupArchive, "writeBackup").mockImplementation(async (metadata, history, open) => {
    for await (const value of history!) exported.push(value);
    expect(metadata).toMatchObject({ kind: "room", version: 2, ownCredential: { userId: "self", credential: "credential" }, retainedFiles: [{ messageSeq: 1, attachment }] });
    expect(await open!({ messageSeq: 1, attachment })).toBe(file);
    return new Blob(["archive"]);
  });
  try {
    session.attachments.confirmed("first", row, [{ id: attachment.id, attachment, file }]);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    expect(await session.roomBackupAvailable("first")).toBe(true);
    expect(await session.roomBackupAvailable("second")).toBe(false);
    await expect(session.exportRoomBackup("first")).resolves.toBeInstanceOf(Blob);
    expect(exported).toEqual([row]); expect(write).toHaveBeenCalledOnce();
    expect(snapshot.close).toHaveBeenCalledOnce(); expect(host.close).not.toHaveBeenCalled();
  } finally { session.close(); }
});

test("invalid archives and failed atomic replacements keep the existing Browser host, capture, voice and watch", async () => {
  const context = await setupRoomBackup();
  const { session, socket, host, stage, read } = context;
  try {
    const activity = (await startBackupActivities(context)).get("first")!;
    const send = socket.send.bind(socket);
    vi.spyOn(socket, "send").mockImplementation(data => {
      send(data);
      const command = JSON.parse(data) as ChannelCommand & { requestId?: string };
      if (command.type === "unpublish" || command.type === "subscribe" && !command.enabled || command.type === "voice" && !command.joined)
        queueMicrotask(() => socket.receive({ type: "ack", requestId: command.requestId }));
    });
    read.mockRejectedValueOnce(new Error("backup_content_mismatch"));
    await expect(session.restoreRoomBackup(new Blob(), "first")).rejects.toThrow("backup_content_mismatch");
    expect(stage.replace).not.toHaveBeenCalled(); expect(host.close).not.toHaveBeenCalled();
    stage.replace.mockRejectedValueOnce(new Error("storage_failed"));
    await expect(session.restoreRoomBackup(new Blob(), "first")).rejects.toThrow("storage_failed");
    expect(stage.append).toHaveBeenCalledOnce(); expect(host.close).not.toHaveBeenCalled();
    expect(socket.sent.some(command => command.type === "host_stop")).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", error: null });
    expect(activity.screen.stop).not.toHaveBeenCalled();
    expect(activity.voice.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot().ownedScreens.has(activity.screenId)).toBe(true);
    expect(session.getSnapshot().state!.publications.map(publication => publication.id)).toEqual(expect.arrayContaining([activity.screenId, activity.voiceId]));
    expect(session.getSnapshot().state!.subscriptions).toContain(activity.watchedId);
    expect(session.getSnapshot().state!.voice).toContainEqual({ roomId: "first", sessionId: "endpoint", muted: false, deafened: false });
  } finally { session.close(); }
});

test("room restore rebinds before installing file copies, and optional cache failure preserves committed success", async () => {
  const context = await setupRoomBackup();
  const { session, socket, host, nextHost, stage, state, metadata, read, row } = context;
  const attachment = { id: "restored-file", name: "data", size: 2, mediaType: "application/octet-stream" as const, sha256: "b".repeat(64) };
  const file = new File([new Uint8Array([4, 5])], "data");
  metadata.retainedFiles = [{ messageSeq: 1, attachment }] as never;
  read.mockImplementationOnce(async (_blob, visitor) => {
    await visitor?.metadata(metadata); await visitor?.row({ ...row, attachments: [attachment] }); await visitor?.content(attachment.sha256, file); return metadata;
  });
  const cache = vi.spyOn(session.attachments, "restoreRetained").mockImplementation(async (roomId, files) => {
    expect(session.getSnapshot().state!.channel.rooms[0].delivery?.bindingId).toBe("restored-binding");
    expect(roomId).toBe("first"); expect(files).toEqual([{ key: { roomId: "first", messageSeq: 1, attachmentId: attachment.id }, attachment, file }]);
    return false;
  });
  try {
    const activities = await startBackupActivities(context, ["first", "second"]);
    const replaced = activities.get("first")!, sibling = activities.get("second")!;
    const restoring = session.restoreRoomBackup(new Blob(), "first");
    await vi.waitFor(() => expect(stage.replace).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(socket.sent.filter(command => command.type === "host_register")).toHaveLength(2));
    expect(host.close).toHaveBeenCalledOnce(); expect(cache).not.toHaveBeenCalled();
    expect(replaced.screen.stop).not.toHaveBeenCalled();
    expect(replaced.voice.stop).not.toHaveBeenCalled();
    const register = socket.sent.findLast(command => command.type === "host_register")!;
    socket.receive({ type: "host_bound", roomId: "first", bindingId: "restored-binding" });
    socket.receive({ type: "ack", requestId: register.requestId });
    expect(cache).not.toHaveBeenCalled();
    const fresh = structuredClone(state); fresh.channel.rooms[0].delivery!.bindingId = "restored-binding";
    fresh.publications = fresh.publications.filter(publication => publication.roomId !== "first");
    fresh.voice = fresh.voice.filter(member => member.roomId !== "first");
    fresh.subscriptions = fresh.subscriptions.filter(id => id !== replaced.watchedId);
    socket.receive({ type: "state", state: fresh });
    await vi.waitFor(() => expect(socket.sent.filter(command => command.type === "browse" && command.roomId === "first" && command.active)).toHaveLength(2));
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    await expect(restoring).resolves.toEqual({ roomId: "first", cached: false });
    expect(nextHost.bind).toHaveBeenCalledWith("restored-binding");
    expect(stage.close).toHaveBeenCalledOnce(); expect(cache).toHaveBeenCalledOnce();
    expect(replaced.screen.stop).toHaveBeenCalledOnce();
    expect(replaced.voice.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().ownedScreens.has(replaced.screenId)).toBe(false);
    expect(session.getSnapshot().state!.subscriptions).not.toContain(replaced.watchedId);
    expect(session.getSnapshot().state!.voice.some(member => member.roomId === "first")).toBe(false);
    expect(sibling.screen.stop).not.toHaveBeenCalled();
    expect(sibling.voice.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot().ownedScreens.has(sibling.screenId)).toBe(true);
    expect(session.getSnapshot().state!.publications.map(publication => publication.id)).toEqual(expect.arrayContaining([sibling.screenId, sibling.voiceId]));
    expect(session.getSnapshot().state!.subscriptions).toContain(sibling.watchedId);
    expect(session.getSnapshot().state!.voice.some(member => member.roomId === "second")).toBe(true);
  } finally { session.close(); }
});

test("room restore reports a committed replacement when its fresh registration fails", async () => {
  const { session, socket, host, stage } = await setupRoomBackup();
  try {
    const restoring = session.restoreRoomBackup(new Blob(), "first");
    const failed = expect(restoring).rejects.toThrow("room_restored_connection_failed");
    await vi.waitFor(() => expect(socket.sent.filter(command => command.type === "host_register")).toHaveLength(2));
    const request = socket.sent.findLast(command => command.type === "host_register")!;
    socket.receive({ type: "error", requestId: request.requestId, code: "room_host_conflict" });
    await failed;
    expect(stage.replace).toHaveBeenCalledOnce();
    expect(host.close).toHaveBeenCalledOnce();
    expect(stage.close).toHaveBeenCalledOnce();
    expect(session.getSnapshot().pending.has("room-backup")).toBe(false);
  } finally { session.close(); }
});

test("Native room restore preserves the explicit committed failure from its storage owner", async () => {
  const { session, socket, stage } = await setupRoomBackup();
  const hostSessionId = crypto.randomUUID();
  const state = structuredClone(session.getSnapshot().state!);
  state.channel.rooms[0].delivery!.hostSessionId = hostSessionId;
  socket.receive({ type: "state", state });
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ sessionId: hostSessionId, roomIds: ["first"] }))
    .mockResolvedValueOnce(Response.json({ error: "room_restored_connection_failed" }, { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(session.restoreRoomBackup(new Blob(), "first")).rejects.toThrow("room_restored_connection_failed");
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/prototype/channel/hosting", "/prototype/channel/rooms/backup"]);
    expect(stage.replace).not.toHaveBeenCalled();
    expect(stage.close).toHaveBeenCalledOnce();
    expect(session.getSnapshot().self?.id).toBe("self");
    expect(session.getSnapshot().pending.has("room-backup")).toBe(false);
  } finally { session.close(); }
});

test("Native backup is selected by its described live host identity, with no Browser fallback", async () => {
  const { session, socket } = await setup();
  const hostId = crypto.randomUUID(), archive = new Blob(["native-snapshot"]);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: hostId, roomIds: ["first"] })))
    .mockResolvedValueOnce(new Response(archive));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(session.attachments, "retained").mockResolvedValue([]);
  const open = vi.fn();
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ BrowserRoomHost: { open } } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const state = structuredClone(session.getSnapshot().state!); state.channel.rooms[0].delivery!.hostSessionId = hostId;
  socket.receive({ type: "state", state });
  try {
    const result = await session.exportRoomBackup("first"); expect(await result.text()).toBe("native-snapshot");
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/prototype/channel/hosting", "/prototype/channel/rooms/first/backup"]);
    expect(open).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: crypto.randomUUID(), roomIds: ["first"] })));
    await expect(session.exportRoomBackup("first")).rejects.toThrow("room_host_unavailable");
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally { session.close(); }
});

test("a late Native ownership description cannot export a replaced room binding", async () => {
  const { session, socket } = await setup();
  let answer!: (value: Response) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { answer = resolve; }));
  vi.stubGlobal("fetch", fetch);
  try {
    const exporting = session.exportRoomBackup("first"), failed = expect(exporting).rejects.toThrow("room_host_conflict");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    const state = structuredClone(session.getSnapshot().state!); state.channel.rooms[0].delivery!.bindingId = "another-binding";
    socket.receive({ type: "state", state }); answer(new Response(JSON.stringify({ sessionId: crypto.randomUUID(), roomIds: ["first"] })));
    await failed; expect(fetch).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

test("portable import validates the full archive before switching accounts and rejects an unrelated Welcome without persisting it", async () => {
  const { session, socket, stage, metadata, read } = await setupRoomBackup();
  metadata.policy = { ...metadata.policy, id: "imported", creatorId: "archived-user" };
  Object.assign(metadata, { ownCredential: { userId: "archived-user", credential: "archived-credential" } });
  const persist = vi.fn(); vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  const original = structuredClone(session.getSnapshot().state!);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ domainId: "domain", user: { id: "archived-user", name: "Archived", avatar: null, version: profileVersion } }))));
  try {
    read.mockRejectedValueOnce(new Error("backup_content_mismatch"));
    await expect(session.restoreRoomBackup(new Blob())).rejects.toThrow("backup_content_mismatch");
    expect(ChannelSocket.current.sent.some(command => command.credential === "archived-credential")).toBe(false);
    expect(socket.sent.some(command => command.type === "admit_room")).toBe(false);
    const importing = session.restoreRoomBackup(new Blob()), failed = expect(importing).rejects.toThrow("backup_identity_required");
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    expect(socket.sent.some(command => command.type === "admit_room")).toBe(false);
    expect(stage.replace).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
    const admission = ChannelSocket.current; await admission.onopen?.();
    expect(admission.sent.find(command => command.type === "join")).toMatchObject({ credential: "archived-credential" });
    expect(admission.sent.find(command => command.type === "join")).not.toHaveProperty("sessionId");
    admission.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "wrong-credential", sessionId: "endpoint", state: original });
    await failed;
    expect(persist.mock.calls.some(call => call[1] === "wrong-credential")).toBe(false);
    const restored = ChannelSocket.current; expect(restored).not.toBe(admission); await restored.onopen?.();
    expect(restored.sent.find(command => command.type === "join")).toMatchObject({ credential: "credential" });
    expect(stage.replace).not.toHaveBeenCalled();
  } finally { session.close(); }
});

test("an approved App exports only rooms positively matched to its Native session", async () => {
  vi.mocked(launchSession.isClientActivated).mockReturnValue(true);
  vi.spyOn(appLink, "discoverChannelAppHealth").mockResolvedValue({ service: "piik-channel-app", protocol: appLink.APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL, port: 8793, token: "approved" });
  const { session, socket } = await setup(); const appSocket = ChannelSocket.current;
  const nativeId = crypto.randomUUID();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: nativeId, roomIds: ["first"] })))
    .mockResolvedValueOnce(new Response(new Blob(["app-snapshot"])));
  vi.stubGlobal("fetch", fetch); vi.spyOn(session.attachments, "retained").mockResolvedValue([]);
  try {
    await appSocket.onopen?.(); appSocket.receive({ id: appSocket.sent.at(-1)!.id, result: null });
    await vi.waitFor(() => expect(session.getSnapshot().appConnected).toBe(true));
    const state = structuredClone(session.getSnapshot().state!); state.channel.ownerId = null;
    state.channel.rooms[0].delivery!.hostSessionId = nativeId; socket.receive({ type: "state", state });
    expect(await (await session.exportRoomBackup("first")).text()).toBe("app-snapshot");
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["http://127.0.0.1:8793/rooms/domain/self/hosting", "http://127.0.0.1:8793/rooms/domain/self/first/backup"]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: nativeId, roomIds: ["second"] })));
    expect(await session.roomBackupAvailable("first")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    state.channel.ownerId = "self"; socket.receive({ type: "state", state });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "hosting_unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: nativeId, roomIds: ["first"] })))
      .mockResolvedValueOnce(new Response(new Blob(["server-snapshot"])));
    expect(await (await session.exportRoomBackup("first")).text()).toBe("server-snapshot");
    expect(fetch.mock.calls.slice(-3).map(call => call[0])).toEqual([
      "http://127.0.0.1:8793/rooms/domain/self/hosting", "/prototype/channel/hosting", "/prototype/channel/rooms/first/backup",
    ]);
  } finally { session.close(); }
});

test.each(["registered", "registration-failed"])("portable import retains its verified identity across committed restore (%s)", async outcome => {
  const { session, socket, stage, metadata, nextHost, read } = await setupRoomBackup();
  metadata.policy = { ...metadata.policy, id: "imported", creatorId: "archived-user" }; stage.policy = JSON.stringify(metadata.policy);
  Object.assign(metadata, { ownCredential: { userId: "archived-user", credential: "archived-credential" } });
  const runtime = await hosting.loadRoomHosting(); vi.spyOn(runtime.BrowserRoomHost, "storedPolicies").mockResolvedValue([]);
  nextHost.summary = () => ({ id: "imported", name: "First", creatorId: "archived-user", icon: "couch", access: "public", hidden: false, hasPassword: false });
  const saved = vi.fn(); vi.stubGlobal("localStorage", { getItem: () => null, setItem: saved });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ domainId: "domain", user: { id: "archived-user", name: "Archived", avatar: null, version: profileVersion } }))));
  const cache = vi.spyOn(session.attachments, "restoreRetained").mockResolvedValue(true);
  const state = structuredClone(session.getSnapshot().state!);
  const imported = { ...state.channel.rooms[0], id: "imported", creatorId: "archived-user", name: "First", available: false, delivery: undefined };
  state.channel.rooms = [imported]; state.channel.ownerId = null; state.users = [{ id: "archived-user", name: "Archived", version: profileVersion }];
  state.sessions = [{ id: "new-endpoint", userId: "archived-user", online: true, signingKey: testSigningKey }];
  try {
    const importing = session.restoreRoomBackup(new Blob());
    const failed = outcome === "registration-failed" ? expect(importing).rejects.toThrow("room_restored_connection_failed") : null;
    await vi.waitFor(() => expect(ChannelSocket.current).not.toBe(socket));
    expect(socket.sent.some(command => command.type === "admit_room")).toBe(false);
    const admission = ChannelSocket.current; await admission.onopen?.();
    const join = admission.sent.find(command => command.type === "join")!;
    expect(join).toMatchObject({ credential: "archived-credential" });
    for (const field of ["ownerKey", "roomId", "sessionId"]) expect(join).not.toHaveProperty(field);
    expect(stage.replace).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
    admission.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "accepted-credential", sessionId: "new-endpoint",
      state: { ...state, channel: { ...state.channel, rooms: [] } } });
    await vi.waitFor(() => expect(admission.sent.some(command => command.type === "admit_room")).toBe(true));
    const admissionRequest = admission.sent.find(command => command.type === "admit_room")!;
    expect(admissionRequest.room).toMatchObject({ id: "imported", creatorId: "archived-user" });
    expect(stage.replace).not.toHaveBeenCalled();
    admission.receive({ type: "state", state });
    admission.receive({ type: "ack", requestId: admissionRequest.requestId });
    await vi.waitFor(() => expect(admission.sent.some(command => command.type === "host_register")).toBe(true));
    expect(read).toHaveBeenCalledOnce(); expect(stage.replace).toHaveBeenCalledOnce(); expect(saved).toHaveBeenCalledWith("piik.channel.prototype.credential", "accepted-credential");
    const registration = admission.sent.find(command => command.type === "host_register")!;
    if (outcome === "registration-failed") {
      admission.receive({ type: "error", requestId: registration.requestId, code: "room_host_conflict" });
      await failed;
      expect(ChannelSocket.current).toBe(admission);
      expect(session.getSnapshot().self?.id).toBe("archived-user");
      expect(saved.mock.calls.filter(call => call[0] === "piik.channel.prototype.credential").at(-1))
        .toEqual(["piik.channel.prototype.credential", "accepted-credential"]);
      expect(cache).not.toHaveBeenCalled();
      return;
    }
    admission.receive({ type: "host_bound", roomId: "imported", bindingId: "imported-binding" });
    admission.receive({ type: "ack", requestId: registration.requestId });
    const restored = structuredClone(state);
    restored.channel.rooms = [{ id: "imported", name: "First", creatorId: "archived-user", icon: "couch", access: "public", hidden: false, hasPassword: false,
      authorized: true, canManage: true, voiceBitrate: 64_000, relayCapacity: 2, relayOverride: null, participantSessionIds: [], lastMessageSeq: 0, realtimeSessionIds: [], available: true, reading: false, capabilities: { attachments: true },
      delivery: { hostSessionId: "new-endpoint", bindingId: "imported-binding", nextHops: {} } }];
    admission.receive({ type: "state", state: restored });
    await vi.waitFor(() => expect(admission.sent.some(command => command.type === "browse" && command.roomId === "imported")).toBe(true));
    const browse = admission.sent.find(command => command.type === "browse" && command.roomId === "imported")!;
    admission.receive({ type: "ack", requestId: browse.requestId });
    await expect(importing).resolves.toEqual({ roomId: "imported", cached: true }); expect(cache).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

test.each(["tail", "first"])("late bulk %s fragments from a cancelled file cannot fail its replacement download", async stale => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  const { readFile } = await import("node:fs/promises");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust, initializeRuntime: async () => {} } as never);
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("optional_cache_unavailable"));
  const source = "00000000-0000-0000-0000-000000000001", receiver = "00000000-0000-0000-0000-000000000002";
  const key = { roomId: "room", messageSeq: 1, attachmentId: "00000000-0000-0000-0000-000000000003" };
  const bytes = Uint8Array.from({ length: 20_000 }, (_, index) => index % 251), hash = new rust.AttachmentHash();
  hash.update(bytes);
  const attachment = { id: key.attachmentId, name: "owned.bin", size: bytes.length, mediaType: "application/octet-stream" as const, sha256: hash.finish() };
  const plan = { ...key, attachment, sourceId: source, upstream: source, downstream: [], receiving: true };
  const aborts: ReturnType<typeof vi.fn>[] = [];
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async () => {
      const written = new Uint8Array(bytes.length), abort = vi.fn(async () => {}); aborts.push(abort);
      return { createWritable: async () => ({
        write: async ({ position, data }: { position: number; data: Uint8Array }) => { written.set(data, position); }, close: async () => {}, abort,
      }), getFile: async () => new File([written], "owned.bin") };
    }, removeEntry: async () => {},
  }) }) } });
  const pulls: string[] = [], commands: ChannelCommand[] = [];
  const files = new ChannelAttachments(async command => { commands.push(command); }, async (_peer, kind, data, allowed) => {
    if (allowed() && kind === "control" && JSON.parse(data as string).type === "pull") pulls.push(data as string);
  });
  const upstream = new rust.FileDelivery(source);
  upstream.update(JSON.stringify([{ ...plan, upstream: null, downstream: [receiver], receiving: false }]), JSON.stringify([[receiver, ["room"]]]), 0n);
  const chunksFor = (pull: string): Uint8Array[] => {
    const effects = JSON.parse(upstream.control(receiver, pull, 0n));
    return effects.flatMap((effect: { type: string; key: typeof key; offset: number; requestId: string; frame: number[] }) => {
      const output = effect.type === "read" ? JSON.parse(upstream.read_result(JSON.stringify(effect.key), BigInt(effect.offset), effect.requestId, bytes)) : [effect];
      return output.filter((next: { type: string }) => next.type === "send_chunk").map((next: { frame: number[] }) => Uint8Array.from(next.frame));
    });
  };
  files.update(receiver, { domainId: "domain", userId: "user" }, [plan], [{ id: "room", authorized: true, available: true }] as never, [{ peerId: source, rooms: ["room"] }]);
  const old = new AbortController(), next = new AbortController();
  const first = files.content(key, attachment, old.signal); void first.catch(() => {});
  try {
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    const oldChunks = chunksFor(pulls[0]);
    expect(oldChunks.length).toBeGreaterThan(1);
    if (stale === "tail") files.data(source, "chunk", oldChunks[0]);
    old.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const replacement = files.content(key, attachment, next.signal); void replacement.catch(() => {});
    await vi.waitFor(() => expect(pulls).toHaveLength(2));
    // A retired transfer's already-queued bulk tail can follow cancellation on
    // the independent control lane, after the user has requested a fresh copy.
    files.data(source, "chunk", oldChunks[stale === "tail" ? 1 : 0]);
    for (const chunk of chunksFor(pulls[1])) files.data(source, "chunk", chunk);
    const completed = await replacement;
    expect(new Uint8Array(await completed.arrayBuffer())).toEqual(bytes);
    expect(aborts[1]).not.toHaveBeenCalled();
    expect(commands.filter(command => command.type === "file_receive" && command.enabled)).toHaveLength(2);
  } finally { next.abort(); files.reset(); upstream.free(); }
});

test("a delayed source busy error cannot fail a cancelled file's successful retry", async () => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  const { readFile } = await import("node:fs/promises");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust, initializeRuntime: async () => {} } as never);
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("optional_cache_unavailable"));
  const source = "00000000-0000-0000-0000-000000000001", receiver = "00000000-0000-0000-0000-000000000002";
  const bytes = Uint8Array.from([1, 2, 3]), hash = new rust.AttachmentHash(); hash.update(bytes);
  const attachment = { id: crypto.randomUUID(), name: "retry.bin", size: bytes.length, mediaType: "application/octet-stream" as const, sha256: hash.finish() };
  const key = { roomId: "room", messageSeq: 33, attachmentId: attachment.id };
  const plan = { ...key, attachment, sourceId: source, upstream: source, downstream: [], receiving: true };
  const upstream = new rust.FileDelivery(source);
  const blockers = Array.from({ length: 32 }, (_, index) => ({ ...plan, messageSeq: index + 1, attachment: { ...attachment, id: crypto.randomUUID() }, upstream: null, downstream: [receiver], receiving: false }));
  upstream.update(JSON.stringify([...blockers, { ...plan, upstream: null, downstream: [receiver], receiving: false }]), JSON.stringify([[receiver, ["room"]]]), 0n);
  const blockerRequests = blockers.map(() => crypto.randomUUID());
  const blockerKeys = blockers.map(blocker => ({ roomId: blocker.roomId, messageSeq: blocker.messageSeq, attachmentId: blocker.attachment.id }));
  for (const [index, blocked] of blockerKeys.entries()) {
    const reads = JSON.parse(upstream.control(receiver, JSON.stringify({ type: "pull", key: blocked, offset: 0, requestId: blockerRequests[index] }), 0n));
    expect(reads.map((effect: { type: string }) => effect.type)).toEqual(["read"]);
  }
  const written = new Uint8Array(bytes.length);
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async () => ({ createWritable: async () => ({ write: async ({ position, data }: { position: number; data: Uint8Array }) => written.set(data, position), close: async () => {}, abort: async () => {} }), getFile: async () => new File([written], "retry.bin") }), removeEntry: async () => {},
  }) }) } });
  const pulls: string[] = [], files = new ChannelAttachments(async () => {}, async (_peer, kind, data, allowed) => {
    if (allowed() && kind === "control" && JSON.parse(data as string).type === "pull") pulls.push(data as string);
  });
  files.update(receiver, { domainId: "domain", userId: "user" }, [plan], [{ id: "room", authorized: true, available: true }] as never, [{ peerId: source, rooms: ["room"] }]);
  const old = new AbortController(), next = new AbortController();
  const first = files.content(key, attachment, old.signal); void first.catch(() => {});
  try {
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    const rejected = JSON.parse(upstream.control(receiver, pulls[0], 0n));
    expect(rejected).toEqual([{ type: "send_control", peer: receiver, control: { type: "error", key, requestId: JSON.parse(pulls[0]).requestId, code: "file_transfer_busy" } }]);
    old.abort(); await expect(first).rejects.toMatchObject({ name: "AbortError" });
    upstream.control(receiver, JSON.stringify({ type: "cancel", key: blockerKeys[0], offset: 0, requestId: blockerRequests[0] }), 0n);
    const retry = files.content(key, attachment, next.signal); void retry.catch(() => {});
    await vi.waitFor(() => expect(pulls).toHaveLength(2));
    const reads = JSON.parse(upstream.control(receiver, pulls[1], 0n));
    expect(reads.map((effect: { type: string }) => effect.type)).toEqual(["read"]);
    files.data(source, "control", JSON.stringify(rejected[0].control));
    for (const read of reads) {
      const chunks = JSON.parse(upstream.read_result(JSON.stringify(read.key), BigInt(read.offset), read.requestId, bytes));
      for (const chunk of chunks) if (chunk.type === "send_chunk") files.data(source, "chunk", Uint8Array.from(chunk.frame));
    }
    expect(new Uint8Array(await (await retry).arrayBuffer())).toEqual(bytes);
  } finally { next.abort(); files.reset(); upstream.free(); }
});

test("socket ingress hydrates room pictures and rejected frames recover with a full Welcome", async () => {
  const { session, socket } = await setup(1000, false);
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.icon = "data:image/png;base64,YWJj";
    socket.receive({ type: "state", state });
    const { icon, rooms, ...channel } = state.channel;
    const compact = { ...state, channel: { ...channel, rooms: rooms.map(({ icon, ...room }) => room) },
      users: state.users.map(user => ({ ...user, name: "Updated" })),
    };
    socket.receive({ type: "state", state: compact });
    expect(session.getSnapshot().state?.users[0]).toMatchObject({ name: "Updated", version: profileVersion });
    expect(session.getSnapshot().state?.channel.icon).toBe(state.channel.icon);
    vi.useFakeTimers();
    const close = vi.spyOn(socket, "close"), invalid = structuredClone(state);
    invalid.users[0].name = "x".repeat(41);
    socket.receive({ type: "state", state: invalid });
    expect(close).toHaveBeenCalledWith();
    expect(session.getSnapshot()).toMatchObject({ connection: "reconnecting", error: "invalid_response" });
    await vi.advanceTimersByTimeAsync(1000);
    const replacement = ChannelSocket.current;
    expect(replacement).not.toBe(socket); await replacement.onopen?.();
    replacement.receive({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", error: null });
    replacement.receive({ type: "state", state: compact });
    expect(session.getSnapshot().state?.channel.icon).toBe(state.channel.icon);
    expect(session.getSnapshot().state?.users[0].name).toBe("Updated");
  } finally { session.close(); }
});

test.each([undefined, CHANNEL_PROTOCOL - 1, CHANNEL_PROTOCOL + 1])("an incompatible Domain Welcome protocol (%s) is rejected before accepting its state", async protocol => {
  const { session, socket } = await setup(1000, false);
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.name = "Must not be accepted";
    expect(socket.sent.find(command => command.type === "join")).toMatchObject({ protocol: CHANNEL_PROTOCOL });
    socket.receive({ type: "welcome", protocol, credential: "other-credential", sessionId: "other-endpoint", state });
    expect(session.getSnapshot()).toMatchObject({ connection: "closed", sessionId: null, state: null, error: "incompatible_protocol" });
    expect(socket.readyState).toBe(3);
  } finally { session.close(); }
});

test.each([{ state: "missing" }, { state: "unrecoverable" }, { state: "available", key: "private-room-key" }] as const)("reading a room invitation returns $state without rotating it", async invitation => {
  const { session, socket } = await setup();
  try {
    const reading = session.getRoomInvite("first");
    const request = socket.sent.findLast(command => command.type === "get_room_invite")!;
    expect(request).toMatchObject({ roomId: "first" });
    socket.receive({ type: "room_invite_state", roomId: "first", invitation, requestId: request.requestId });
    socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId, result: { type: "done" } });
    await expect(reading).resolves.toEqual(invitation.state === "available"
      ? { state: "available", url: "https://channel.test/__channel-preview#room=first&invite=private-room-key" } : invitation);
    expect(socket.sent.some(command => command.type === "room_invite")).toBe(false);
  } finally { session.close(); }
});

test("reopening the room invitation can read while the dismissed panel's read is pending", async () => {
  const { session, socket } = await setup();
  try {
    const dismissed = session.getRoomInvite("first").catch(error => error);
    const reopened = session.getRoomInvite("first").catch(error => error);
    const reads = socket.sent.filter(command => command.type === "get_room_invite");
    expect(reads).toHaveLength(2);
    for (const [index, key] of [[1, "current-key"], [0, "previous-read-key"]] as const) {
      socket.receive({ type: "room_invite_state", roomId: "first", invitation: { state: "available", key }, requestId: reads[index].requestId });
      socket.receive({ type: "room_reply", roomId: "first", requestId: reads[index].requestId, result: { type: "done" } });
    }
    await expect(reopened).resolves.toEqual({ state: "available", url: "https://channel.test/__channel-preview#room=first&invite=current-key" });
    await expect(dismissed).resolves.toMatchObject({ url: "https://channel.test/__channel-preview#room=first&invite=previous-read-key" });
    expect(socket.sent.some(command => command.type === "room_invite")).toBe(false);
  } finally { session.close(); }
});

test("Browser capture titles use original metadata and confirmed overrides without changing the media", async () => {
  const { session, socket } = await setup();
  const old = remoteTrack("video"), next = remoteTrack("video");
  Object.defineProperty(old, "label", { value: "  Project notes  " });
  Object.defineProperty(next, "label", { value: "Updated notes" });
  const first = remoteStream("first", [old]), second = remoteStream("second", [next]);
  const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: acquire } });
  const bind = vi.spyOn(ChannelMedia.prototype, "setLocal");
  try {
    const starting = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const request = socket.sent.at(-1)!;
    const publication = request.publication as { id: string; roomId: string; kind: "screen"; source: ScreenSource; videoSettings: VideoSettings };
    expect(publication.source).toEqual({ kind: "screen", name: "Project notes" });
    expect(publication).not.toHaveProperty("title");
    socket.receive({ type: "ack", requestId: request.requestId }); await starting;
    let state = { ...session.getSnapshot().state!, publications: [{ ...publication, audience: [], paused: false, title: null as string | null, sessionId: "endpoint", userId: "self" }] };
    socket.receive({ type: "state", state });
    const bindings = bind.mock.calls.length;
    await expect(session.setScreenTitle(publication.id, "x".repeat(65))).rejects.toThrow("invalid_title");
    expect(channelErrorPresentation("invalid_title", key => en[key]).message).toBe("The title cannot exceed 64 characters.");
    expect(channelErrorPresentation("invalid_title", key => zh[key]).message).toBe("标题不能超过 64 个字符。");
    const editing = session.setScreenTitle(publication.id, "  Weekly review  ");
    const edit = socket.sent.at(-1)!;
    expect(edit).toMatchObject({ type: "set_title", publicationId: publication.id, title: "Weekly review" });
    expect(session.getSnapshot().state!.publications[0].title).toBeNull();
    state.publications[0].title = "Weekly review";
    socket.receive({ type: "state", state }); socket.receive({ type: "ack", requestId: edit.requestId }); await editing;
    expect(bind.mock.calls).toHaveLength(bindings);
    expect(old.stop).not.toHaveBeenCalled();
    const replacing = session.startScreen("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("transfer_source"));
    expect(socket.sent.filter(command => command.type === "publish")).toHaveLength(1);
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("publish"));
    const update = socket.sent.at(-1)!;
    expect(update.publication).toMatchObject({ id: publication.id, source: { kind: "screen", name: "Updated notes" } });
    expect(update.publication).not.toHaveProperty("title");
    expect(session.getSnapshot().streams.get(publication.id)).toBe(second);
    const rejected = expect(replacing).rejects.toThrow("room_unavailable");
    socket.receive({ type: "error", requestId: update.requestId, code: "room_unavailable" }); await rejected;
    expect(session.getSnapshot().streams.get(publication.id)).toBe(second);
    expect(next.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot().state!.publications[0].title).toBe("Weekly review");
    expect(session.getSnapshot().error).toBe("room_unavailable");
    const clearing = session.setScreenTitle(publication.id, "   ");
    expect(socket.sent.at(-1)).toMatchObject({ type: "set_title", title: null });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await clearing;
    expect(session.getSnapshot().error).toBe("room_unavailable");
    expect(bind.mock.calls).toHaveLength(bindings + 1);
    state = { ...state, publications: [{ ...state.publications[0], sessionId: "other-endpoint" }] };
    socket.receive({ type: "state", state });
    await expect(session.setScreenTitle(publication.id, "Not mine")).rejects.toThrow("not_publication_owner");
  } finally { session.close(); }
});

test("reply navigation loads its own bounded history window and can return to latest", async () => {
  const { session, peer } = await setup(3);
  try {
    await peer.history([message(50), message(51), message(52)]);
    const loading = session.loadMessage("first", 2);
    const request = await peer.next();
    expect(request).toMatchObject({ type: "history", roomId: "first", before: 3 });
    peer.page(request, [message(1), message(2)], false, 1);
    await loading;
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.seq)).toEqual([1, 2]);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(false);
    const newer = session.loadMessage("first", 50);
    const newerRequest = await peer.next();
    await expect(session.loadMessage("first", 51)).rejects.toThrow("operation_pending");
    const secondPage = session.loadLatestHistory("second");
    peer.page(await peer.next(), [message(1), message(2), message(3)]);
    await secondPage;
    const secondJump = session.loadMessage("second", 70);
    const secondRequest = await peer.next();
    peer.page(newerRequest, [message(48), message(49), message(50)], true, 1);
    await expect(newer).resolves.toBeUndefined();
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.seq)).toEqual([48, 49, 50]);
    peer.page(secondRequest, [message(68), message(69), message(70)], true, 1);
    await secondJump;
    expect(session.getSnapshot().messagesByRoom.second.map(message => message.seq)).toEqual([68, 69, 70]);
    await peer.history([message(50), message(51), message(52)]);
    expect(session.getSnapshot().messagesByRoom.first.map(message => message.seq)).toEqual([50, 51, 52]);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(true);
  } finally { session.close(); }
});

test("image-heavy reading windows stay bounded while older records remain reachable", async () => {
  const { session, peer } = await setup(1000);
  const bytes = Buffer.alloc(64 * 1024).toString("base64");
  const picture = (seq: number) => ({ ...message(seq), inlineImages: { image: {
    data: bytes, mediaType: "image/png" as const, original: true, width: 640, height: 480,
  } } });
  try {
    for (let seq = 1; seq <= 60; seq++) peer.live(picture(seq));
    const current = session.getSnapshot().messagesByRoom.first;
    expect(current.at(-1)?.seq).toBe(60);
    expect(current[0].seq).toBeGreaterThan(1);
    expect(current.reduce((size, row) => size + new TextEncoder().encode(JSON.stringify(row)).length, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(session.getSnapshot().historyByRoom.first.hasMore).toBe(true);
    const loading = session.loadHistory("first");
    const request = await peer.next();
    expect(request).toMatchObject({ before: current[0].seq });
    peer.page(request, [picture(current[0].seq - 2), picture(current[0].seq - 1)], true, 1);
    await loading;
    const earlier = session.getSnapshot().messagesByRoom.first;
    expect(earlier[0].seq).toBe(current[0].seq - 2);
    expect(earlier.at(-1)!.seq).toBeLessThan(60);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(false);
    expect(earlier.reduce((size, row) => size + new TextEncoder().encode(JSON.stringify(row)).length, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
  } finally { session.close(); }
});

test("read markers stay personal and do not turn background room activity into reading", async () => {
  const { session, socket } = await setup(1000, false, "");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
  const state = structuredClone(session.getSnapshot().state!);
  const key = `piik.channel.read.${state.channel.id}.${session.getSnapshot().self!.id}`;
  try {
    session.refreshReadMarkers();
    state.channel.rooms[0].lastMessageSeq = 5;
    state.channel.rooms[1].lastMessageSeq = 8;
    const sent = socket.sent.length;
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().readByRoom).toEqual({ first: 0, second: 0 });
    expect(socket.sent.slice(sent).some(command => command.type === "browse")).toBe(false);
    session.markRead("first", 2);
    expect(session.getSnapshot().readByRoom).toEqual({ first: 2, second: 0 });
    session.markRead("first", 99);
    expect(JSON.parse(storage.get(key)!)).toEqual({ first: 5, second: 0 });
    storage.set(key, JSON.stringify({ first: 5, second: 4 }));
    session.refreshReadMarkers();
    expect(session.getSnapshot().readByRoom.second).toBe(4);
    state.channel.rooms[0].lastMessageSeq = 1;
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().readByRoom.first).toBe(1);
    state.channel.id = "another-site";
    socket.receive({ type: "state", state });
    expect(session.getSnapshot().readByRoom).toEqual({ first: 1, second: 8 });
    expect(JSON.parse(storage.get(key)!)).toEqual({ first: 1, second: 4 });
  } finally { session.close(); }
});

test.each([
  ["screen:0:0", null], ["window:123:0", null], ["screen:-1:0:s", null],
  ["web-contents-media-stream://0123456789ABCDEF0123456789ABCDEF", null],
  ["current-web-contents-media-stream://0123456789ABCDEF0123456789ABCDEF", null],
  ["screen: Project notes", "screen: Project notes"],
  ["😀".repeat(40), "😀".repeat(32)],
] as const)("Browser publication metadata treats producer label %s as bounded text", async (label, name) => {
  const { session, socket } = await setup();
  const track = remoteTrack("video");
  Object.defineProperty(track, "label", { value: label });
  try {
    const publishing = session.publish("screen", "first", remoteStream("source", [track]));
    expect(socket.sent.at(-1)).toMatchObject({ publication: { source: { kind: "screen", name } } });
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await publishing;
  } finally { session.close(); }
});


test("screen buffering follows current and replaced receivers, late source audio, candidates and automatic reset", async () => {
  const status = vi.fn();
  const fixture = await screenFixture({ target: null, changed: status });
  const { media, pc, session, state } = fixture;
  const video = remoteTrack("video"), tracks = [video];
  const stream = remoteStream("buffered-screen", tracks);
  const receiver = (track: MediaStreamTrack) => ({ track, jitterBufferTarget: null as number | null, getStats: async () => decodedReport(0) });
  const first = receiver(video);
  pc.receivers = [first as unknown as RTCRtpReceiver];
  try {
    await receiveScreen(fixture, stream);
    media.setScreenBufferTarget(300);
    expect(first.jitterBufferTarget).toBe(300);
    const audio = remoteTrack("audio"), companion = receiver(audio);
    tracks.push(audio); pc.receivers.push(companion as unknown as RTCRtpReceiver);
    pc.ontrack?.({ streams: [stream] });
    expect(companion.jitterBufferTarget).toBe(300);
    state.pairs[0].incoming[0].selected = false;
    media.update("a", state);
    const replacement = receiver(remoteTrack("video"));
    pc.receivers = [replacement as unknown as RTCRtpReceiver];
    await receiveScreen(fixture, remoteStream("replacement-screen", [replacement.track]));
    expect(replacement.jitterBufferTarget).toBe(300);
    media.setScreenBufferTarget(null);
    expect(replacement.jitterBufferTarget).toBeNull();
    expect(status).toHaveBeenLastCalledWith("supported");
  } finally { media.reset(); session.close(); }
});

test("room voice restores a reused screen audio receiver to automatic without adopting screen buffering", async () => {
  const fixture = await screenFixture({ target: 300, changed: vi.fn() });
  const { media, pc, state, session } = fixture;
  const audio = remoteTrack("audio");
  const receiver = { track: audio, jitterBufferTarget: 300, getStats: async () => decodedReport(0) };
  pc.receivers = [receiver as unknown as RTCRtpReceiver];
  state.publications[0] = { ...state.publications[0], kind: "voice" } as typeof state.publications[number];
  media.update("a", state);
  try {
    await receiveScreen(fixture, remoteStream("voice-reused", [audio]));
    expect(receiver.jitterBufferTarget).toBeNull();
    media.setScreenBufferTarget(1000);
    expect(receiver.jitterBufferTarget).toBeNull();
  } finally { media.reset(); session.close(); }
});

test("optional screen buffering reports unsupported and rejected assignments without failing media", async () => {
  const status = vi.fn();
  const fixture = await screenFixture({ target: 300, changed: status });
  const { media, pc, session } = fixture;
  try {
    expect(status).toHaveBeenLastCalledWith(null);
    const video = remoteTrack("video");
    const receiver = { track: video, getStats: async () => decodedReport(0) };
    pc.receivers = [receiver as unknown as RTCRtpReceiver];
    await receiveScreen(fixture, remoteStream("unsupported-buffer", [video]));
    expect(status).toHaveBeenLastCalledWith("unsupported");
    Object.defineProperty(receiver, "jitterBufferTarget", { configurable: true, get: () => null, set: () => { throw new Error("rejected"); } });
    expect(() => media.setScreenBufferTarget(400)).not.toThrow();
    expect(status).toHaveBeenLastCalledWith("failed");
    media.setScreenBufferTarget(null);
    expect(status).toHaveBeenLastCalledWith("supported");
    expect(pc.connectionState).toBe("connected");
  } finally { media.reset(); session.close(); }
});
