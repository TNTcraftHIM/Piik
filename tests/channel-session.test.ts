import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/conversation";
import { ChannelSession } from "../src/client/channel/session";
import * as hosting from "../src/client/channel/hosting";
import { ChannelMedia } from "../src/client/channel/media";
import { ChannelTransport } from "../src/client/channel/transport";
import { ChannelAttachments } from "../src/client/channel/attachments";
import { signalSchema, type ChannelCommand, type ChannelSignal, type ConversationReply } from "../src/client/channel/protocol";

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
  vi.spyOn(ChannelConversation.prototype, "initialize").mockResolvedValue(testSigningKey);
  vi.stubGlobal("MediaStream", RoomMediaStream);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(window = 1000) {
  vi.stubGlobal("location", new URL("https://channel.test/__channel-preview"));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("WebSocket", ChannelSocket);
  const session = new ChannelSession();
  session.start();
  const socket = ChannelSocket.current;
  await socket.onopen?.();
  socket.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state: {
    channel: { id: "domain", name: "Friends", ownerId: "self", historyWindow: window,
      rooms: ["first", "second"].map(id => ({ id, name: id, creatorId: "self", access: "public",
        hidden: false, hasPassword: false, authorized: true, canManage: true,
        available: true, reading: id === "first", capabilities: { attachments: true } })), roles: [] },
    users: [{ id: "self", name: "Me", roles: [] }], sessions: [{ id: "endpoint", userId: "self", online: true, signingKey: testSigningKey }],
    publications: [], voice: [], subscriptions: [], files: [], pairs: [], iceServers: [],
  } });
  return { session, socket };
}

const message = (seq: number) => ({ id: `message-${seq}`, seq, userId: "self", text: `Hello ${seq}`, time: seq, attachments: [] });

test("host binding precedes its first input and a failed binding retires that host", async () => {
  const host = {
    roomId: "",
    summary: () => ({ id: host.roomId, name: "Hosted", creatorId: "self", access: "public" as const, hidden: false, hasPassword: false }),
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
    const creating = session.createRoom({ name: "Hosted", access: "public", hidden: false });
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

test("room replies settle only the request belonging to that room", async () => {
  const { session, socket } = await setup();
  try {
    let settled = false;
    const sending = session.sendMessage("first", "Hello").then(() => { settled = true; });
    const request = socket.sent.at(-1)!;
    socket.receive({ type: "room_reply", roomId: "second", requestId: request.requestId, result: { type: "done" } });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(1), requestId: request.requestId });
    socket.receive({ type: "room_reply", roomId: "first", requestId: request.requestId,
      result: { type: "history", result: { type: "sent", message: message(1), inserted: true }, browse: false } });
    await sending;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1)]);
    const reading = session.loadLatestHistory("first");
    const rejected = expect(reading).rejects.toThrow("room_host_offline");
    socket.receive({ type: "room_reply", roomId: "first", requestId: socket.sent.at(-1)!.requestId,
      result: { type: "error", code: "room_host_offline" } });
    await rejected;
  } finally { session.close(); }
});

test.each([
  ["missing record", [2]],
  ["duplicate sequence", [2, 2]],
] as const)("an incomplete peer history page (%s) preserves messages and permits a complete retry", async (_fault, sequences) => {
  const { session, socket } = await setup();
  let reply!: (record: ConversationReply["record"]) => void;
  const send = vi.spyOn(ChannelConversation.prototype, "send").mockImplementation(async function (this: ChannelConversation, command, requestId) {
    const options = (this as unknown as { options: { reply(value: ConversationReply): void } }).options;
    reply = record => options.reply({ roomId: command.roomId, bindingId: "binding", sender: "host",
      recipient: "endpoint", requestId, record });
  });
  try {
    socket.receive({ type: "history", roomId: "first", messages: [message(1)], hasMore: false, oldestSeq: 1 });
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].delivery = { hostSessionId: "host", bindingId: "binding", nextHops: { host: "host" } };
    state.sessions.push({ id: "host", userId: "self", online: true, signingKey: testSigningKey });
    socket.receive({ type: "state", state });
    const existing = session.getSnapshot().messagesByRoom.first;
    const incomplete = session.loadLatestHistory("first");
    const rejected = expect(incomplete).rejects.toThrow("incomplete_history");
    expect(send).not.toHaveBeenCalled();
    const browse = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    socket.receive({ type: "ack", requestId: browse.requestId });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    for (const seq of sequences) reply({ type: "history_message", message: message(seq) });
    reply({ type: "history_end", count: 2, hasMore: false, oldestSeq: 2, before: null });
    await rejected;
    expect(session.getSnapshot().messagesByRoom.first).toBe(existing);
    expect(existing).toEqual([message(1)]);

    const complete = session.loadLatestHistory("first");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    reply({ type: "history_message", message: message(2) });
    reply({ type: "history_message", message: message(3) });
    expect(session.getSnapshot().messagesByRoom.first).toBe(existing);
    reply({ type: "history_end", count: 2, hasMore: false, oldestSeq: 2, before: null });
    await complete;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(2), message(3)]);
  } finally { session.close(); }
});

test("a separate directory storage error does not fail a committed room request", async () => {
  const { session, socket } = await setup();
  try {
    const updating = session.updateRoom("first", { name: "Saved", access: "public", hidden: false });
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

test("confirms a send after browsing another room while only ack completes its request", async () => {
  const { session, socket } = await setup();
  try {
    session.browse("second");
    let settled = false;
    const sending = session.sendMessage("first", "Hello 1").then(() => { settled = true; });
    void sending.catch(() => {});
    const request = socket.sent.findLast(command => command.type === "chat")!;
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(1), requestId: request.requestId });
    await Promise.resolve();
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1)]);
    expect(session.getSnapshot().messagesByRoom.second).toBeUndefined();
    expect(settled).toBe(false);
    expect(session.getSnapshot().pending.has("chat:first")).toBe(true);
    socket.receive({ type: "ack", requestId: request.requestId });
    await sending;
    expect(settled).toBe(true);
    expect(session.getSnapshot().pending.has("chat:first")).toBe(false);
  } finally { session.close(); }
});

test("merges live messages and original confirmations once in room order within the latest window", async () => {
  const { session, socket } = await setup(2);
  try {
    socket.receive({ type: "history", roomId: "first", messages: [message(3), message(4)], hasMore: true, oldestSeq: 1 });
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(1) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(3), message(4)]);
    socket.receive({ type: "message", roomId: "first", message: message(6) });
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(6) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(4), message(6)]);
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(5) });
    socket.receive({ type: "message", roomId: "first", message: message(5) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(5), message(6)]);
  } finally { session.close(); }
});

test.each([
  ["empty", [], null],
  ["older", [message(1)], 1],
] as const)("a delayed %s history page preserves a newer live message", async (_page, messages, oldestSeq) => {
  const { session, socket } = await setup();
  try {
    const loading = session.loadLatestHistory("first");
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("history"));
    const request = socket.sent.at(-1)!;
    socket.receive({ type: "message", roomId: "first", message: message(2) });
    socket.receive({ type: "history", roomId: "first", messages, hasMore: false, oldestSeq });
    socket.receive({ type: "ack", requestId: request.requestId });
    await loading;
    expect(session.getSnapshot().messagesByRoom.first).toEqual([...messages, message(2)]);
  } finally { session.close(); }
});

test("pages beyond a full window without live messages interrupting reading, then returns to latest", async () => {
  const { session, socket } = await setup(3);
  try {
    socket.receive({ type: "history", roomId: "first", messages: [message(8), message(9)], hasMore: true, oldestSeq: 1 });
    socket.receive({ type: "history", roomId: "first", messages: [message(7)], before: 8, hasMore: true, oldestSeq: 1 });
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(true);
    for (const first of [4, 1]) {
      const loading = session.loadHistory("first");
      void loading.catch(() => {});
      const request = socket.sent.at(-1)!;
      expect(request.before).toBe(first + 3);
      socket.receive({ type: "history", roomId: "first", before: request.before,
        messages: [message(first), message(first + 1), message(first + 2)], hasMore: first > 1, oldestSeq: 1 });
      socket.receive({ type: "ack", requestId: request.requestId });
      await loading;
      expect(session.getSnapshot().messagesByRoom.first).toEqual([message(first), message(first + 1), message(first + 2)]);
      expect(session.getSnapshot().historyByRoom.first).toMatchObject({ before: first, atLatest: false });
    }
    socket.receive({ type: "message", roomId: "first", message: message(10) });
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(4) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1), message(2), message(3)]);
    const latest = session.loadLatestHistory("first");
    void latest.catch(() => {});
    const request = socket.sent.at(-1)!;
    expect(request).not.toHaveProperty("before");
    socket.receive({ type: "history", roomId: "first", messages: [message(9), message(10), message(11)], hasMore: true, oldestSeq: 1 });
    socket.receive({ type: "ack", requestId: request.requestId });
    await latest;
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(true);
    socket.receive({ type: "message", roomId: "first", message: message(12) });
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(12) });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(10), message(11), message(12)]);
  } finally { session.close(); }
});

test("a confirmed send returns a historical reader to latest without failing the send when history fails", async () => {
  const { session, socket } = await setup(1);
  try {
    socket.receive({ type: "history", roomId: "first", messages: [message(2)], hasMore: true, oldestSeq: 1 });
    socket.receive({ type: "history", roomId: "first", messages: [message(1)], before: 2, hasMore: false, oldestSeq: 1 });
    const sending = session.sendMessage("first", "Hello 3");
    void sending.catch(() => {});
    const request = socket.sent.at(-1)!;
    socket.receive({ type: "message_confirmed", roomId: "first", message: message(3), requestId: request.requestId });
    socket.receive({ type: "ack", requestId: request.requestId });
    await sending;
    const latest = socket.sent.at(-1)!;
    expect(latest.type).toBe("history");
    expect(latest).not.toHaveProperty("before");
    socket.receive({ type: "error", code: "storage_failed", requestId: latest.requestId });
    await vi.waitFor(() => expect(session.getSnapshot().error).toBe("storage_failed"));
    expect(session.getSnapshot().pending.has("chat:first")).toBe(false);
    expect(session.getSnapshot().historyByRoom.first.atLatest).toBe(false);
  } finally { session.close(); }
});

test("a confirmed file becomes a session source while its sender reads an older history window", async () => {
  const { session, socket } = await setup(1);
  const file = new File(["saved"], "note.txt"), id = crypto.randomUUID();
  const attachment = { id, name: file.name, size: file.size, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  vi.spyOn(session.attachments, "describe").mockResolvedValue([{ id, file, attachment }]);
  try {
    socket.receive({ type: "history", roomId: "first", messages: [message(2)], hasMore: true, oldestSeq: 1 });
    socket.receive({ type: "history", roomId: "first", messages: [message(1)], before: 2, hasMore: false, oldestSeq: 1 });
    const sending = session.sendMessage("first", "file", [{ id, file }]);
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("chat"));
    const request = socket.sent.at(-1)!;
    expect(request.attachments).toEqual([attachment]);
    socket.receive({ type: "message_confirmed", roomId: "first", requestId: request.requestId, message: { ...message(3), attachments: [attachment] } });
    expect(session.getSnapshot().messagesByRoom.first).toEqual([message(1)]);
    expect(socket.sent.at(-1)).toMatchObject({ type: "file_offer", roomId: "first", messageSeq: 3, attachmentId: id, available: true });
    await expect(session.attachments.content({ roomId: "first", messageSeq: 3, attachmentId: id }, attachment, new AbortController().signal)).resolves.toBe(file);
    socket.receive({ type: "ack", requestId: request.requestId });
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
  senders: Array<{ track: MediaStreamTrack; stream: MediaStream }> = [];
  receivers: RTCRtpReceiver[] = [];
  getStats = vi.fn(async (): Promise<RTCStatsReport> => new Map() as RTCStatsReport);
  close = vi.fn(() => { this.connectionState = "closed"; });
  constructor() { super(); RoomPeerConnection.instances.push(this); }
  createDataChannel(label: string, options: RTCDataChannelInit) {
    const channel = new RoomDataChannel(label, options); this.channels.push(channel); return channel;
  }
  addTrack(track: MediaStreamTrack, stream: MediaStream) { const sender = { track, stream }; this.senders.push(sender); return sender; }
  removeTrack(sender: { track: MediaStreamTrack; stream: MediaStream }) { this.senders.splice(this.senders.indexOf(sender), 1); }
  getReceivers() { return this.receivers; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (description.type === "answer" && this.signalingState !== "have-local-offer") throw new Error("answer without pending offer");
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
  async setLocalDescription() {
    const type = this.signalingState === "have-remote-offer" ? "answer" : "offer";
    const value = { type, sdp: `${type}-${this.channels.length}-${this.senders.length}` } as RTCSessionDescriptionInit;
    this.localDescription = { ...value, toJSON: () => ({ ...value }) };
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
  }
  connected() { this.connectionState = "connected"; this.onconnectionstatechange?.(); }
}

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
  const media = new ChannelMedia(command => sent.push(command), () => {});
  state.pairs = [{ id: "pair", peerId: "z", rooms: ["first"], incoming: [], outgoing: [] }];
  media.update("a", state);
  return { session, socket, media, state, sent, pc: RoomPeerConnection.instances[0] };
}

const decodedReport = (framesDecoded: number) => new Map([["video", {
  id: "video", type: "inbound-rtp", kind: "video", framesDecoded,
}]]) as unknown as RTCStatsReport;

async function screenFixture() {
  const fixture = await setupRoomMedia();
  fixture.state.publications = [{ id: "screen", roomId: "first", sessionId: "z", userId: "other", kind: "screen", muted: false }];
  fixture.state.pairs[0].incoming = [{ id: "screen-flow", publicationId: "screen" }];
  fixture.media.update("a", fixture.state);
  fixture.pc.connected();
  return fixture;
}

const remoteTrack = (kind: "audio" | "video") => Object.assign(new EventTarget(), {
  kind, readyState: "live", stop: vi.fn(),
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
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", ready: true },
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
      outgoing: [{ id: "screen-downstream", publicationId: "screen" }] });
    media.update("a", state);
    const downstream = RoomPeerConnection.instances[1];
    pc.receivers = [{ track: oldVideo, getStats: () => pending } as unknown as RTCRtpReceiver];
    await receiveScreen(fixture, oldStream);
    const lateCleanup = listeners.mock.calls.find(([type]) => type === "removetrack")![1] as EventListener;
    state.pairs[0].incoming = [];
    media.update("a", state);
    state.pairs[0].incoming = [{ id: "replacement-flow", publicationId: "screen" }];
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
      { type: "flow_state", flowId: "replacement-flow", pairId: "pair", ready: true },
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
    expect(sent.filter(command => command.type === "flow_state" && command.ready)).toHaveLength(sample.ready ? 1 : 0);
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();
    if (!sample.ready) {
      frames++;
      await vi.advanceTimersByTimeAsync(100);
      expect(sent.filter(command => command.type === "flow_state" && command.ready)).toHaveLength(1);
    }
    await receiveScreen(fixture, stream);
    expect(pc.getStats).toHaveBeenCalledOnce();
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
    state.pairs.push({ id: "downstream", peerId: "y", rooms: ["first"], incoming: [], outgoing: [{ id: "screen-downstream", publicationId: "screen" }] });
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
    expect(downstream.senders[0]).toBe(videoSender);
    // Removing a remote track does not emit ontrack; the SDP replay republishes its stream.
    tracks.pop();
    media.signal("pair", { exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "audio-removed" },
      tracks: [{ flowId: "screen-flow", streamId: stream.id }] });
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe("audio-removed"));
    expect(downstream.senders.map(sender => sender.track)).toEqual([video]);
    expect(downstream.senders[0]).toBe(videoSender);
    expect(binding.getTracks()).toEqual([video]);
    state.pairs[0].incoming = [];
    media.update("a", state);
    expect(downstream.senders).toEqual([]);
    expect(binding.getTracks()).toEqual([]);
    state.pairs[0].incoming = [{ id: "resumed-screen-flow", publicationId: "screen" }];
    media.update("a", state);
    await receiveScreen(fixture, stream);
    expect(downstream.senders[0].stream).toBe(binding);
    state.pairs[1].outgoing = [{ id: "renewed-screen-downstream", publicationId: "screen" }];
    media.update("a", state);
    expect(downstream.senders.map(sender => sender.track)).toEqual([video]);
    expect(downstream.senders[0].stream.id).not.toBe(binding.id);
    expect(binding.getTracks()).toEqual([]);
    expect(video.stop).not.toHaveBeenCalled(); expect(audio.stop).not.toHaveBeenCalled();
    expect(downstream.close).not.toHaveBeenCalled();
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
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", ready: true },
      { type: "flow_state", flowId: "screen-flow", pairId: "pair", ready: false },
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
    expect(sent.filter(command => command.type === "flow_state" && !command.ready)).toEqual([]);
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
    a.setOutgoing(new Map([["voice-flow", stream("original")]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0]).toHaveLength(1));
    const offer = structuredClone(sent[0].shift()!);
    let withheldAnswer: ChannelSignal | undefined;
    if (lost === "answer") {
      b.setOutgoing(new Map([["reverse-flow", stream("revoked-reverse")]]));
      b.signal(offer);
      await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
      withheldAnswer = sent[1].shift(); // The peer applied the offer, but its answer was lost.
      b.setOutgoing(new Map());
    }
    // A later demand must not rewrite the manifest of the offer already in flight.
    a.setOutgoing(new Map([["replacement-flow", stream("replacement")]]));
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
    a.setOutgoing(new Map([["voice-flow", stream("old")]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0]).toHaveLength(1));
    const oldOffer = sent[0].shift()!;
    b.signal(oldOffer);
    await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
    const oldAnswer = sent[1].shift()!;
    a.signal(oldAnswer);
    await vi.waitFor(() => expect(pcA.signalingState).toBe("stable"));
    a.setOutgoing(new Map([["voice-flow", stream("new")]]));
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
    state.pairs[0].outgoing = [{ id: "screen-outgoing", publicationId: "screen" }];
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
    state.publications = [{ id: "voice-a", roomId: "first", sessionId: "z", userId: "other", kind: "voice", muted: false }];
    state.pairs[0].incoming = [{ id: "voice-a-in", publicationId: "voice-a" }];
    state.pairs[0].outgoing = [{ id: "voice-b-out", publicationId: "voice-b" }];
    state.pairs.push({ id: "downstream", peerId: "y", rooms: ["first"], incoming: [], outgoing: [{ id: "voice-a-out", publicationId: "voice-a" }] });
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
    state.pairs.push({ id: "another-child", peerId: "x", rooms: ["first"], incoming: [], outgoing: [{ id: "voice-a-another-out", publicationId: "voice-a" }] });
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


test("browse acknowledgement loads only the current room once and reconnect refreshes its history", async () => {
  const { session, socket } = await setup();
  try {
    const first = socket.sent.findLast(command => command.type === "browse" && command.active)!;
    session.browse("first");
    expect(socket.sent.filter(command => command.type === "browse" && command.active)).toHaveLength(1);
    expect(socket.sent.some(command => command.type === "history")).toBe(false);
    session.browse("second");
    const second = socket.sent.at(-1)!;
    socket.receive({ type: "ack", requestId: first.requestId }); await Promise.resolve();
    expect(socket.sent.some(command => command.type === "history")).toBe(false);
    socket.receive({ type: "room_reply", roomId: "second", requestId: second.requestId, result: { type: "done" } });
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "history", roomId: "second" }));
    const history = socket.sent.at(-1)!;
    expect(history).toMatchObject({ type: "history", roomId: "second" });
    session.browse("second");
    expect(socket.sent.filter(command => command.type === "history")).toHaveLength(1);
    socket.receive({ type: "history", roomId: "second", messages: [message(5)], hasMore: true, oldestSeq: 1 });
    socket.receive({ type: "room_reply", roomId: "second", requestId: history.requestId, result: { type: "done" } });
    await vi.waitFor(() => expect(session.getSnapshot().pending.has("history:second")).toBe(false));
    const older = session.loadHistory("second");
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "history", roomId: "second", before: 5 }));
    socket.receive({ type: "ack", requestId: socket.sent.at(-1)!.requestId }); await older;
    const state = structuredClone(session.getSnapshot().state!);
    session.reconnect();
    const resumed = ChannelSocket.current; await resumed.onopen?.();
    resumed.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state });
    const browse = resumed.sent.findLast(command => command.type === "browse" && command.active)!;
    resumed.receive({ type: "ack", requestId: browse.requestId });
    await vi.waitFor(() => expect(resumed.sent.filter(command => command.type === "history")).toEqual([expect.objectContaining({ type: "history", roomId: "second" })]));
  } finally { session.close(); }
});
