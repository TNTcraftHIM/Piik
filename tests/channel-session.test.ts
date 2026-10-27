import { afterEach, expect, test, vi } from "vitest";
import { ChannelSession } from "../src/client/channel/session";
import * as hosting from "../src/client/channel/hosting";
import { ChannelMedia } from "../src/client/channel/media";
import type { ChannelCommand } from "../src/client/channel/protocol";

class ChannelSocket {
  static OPEN = 1;
  static current: ChannelSocket;
  readyState = ChannelSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  constructor(_url: URL) { ChannelSocket.current = this; }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  receive(event: object): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(window = 1000) {
  vi.stubGlobal("location", new URL("https://channel.test/__channel-preview"));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("WebSocket", ChannelSocket);
  const session = new ChannelSession();
  session.start();
  const socket = ChannelSocket.current;
  socket.onopen?.();
  socket.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state: {
    channel: { id: "domain", name: "Friends", ownerId: "self", historyWindow: window,
      rooms: ["first", "second"].map(id => ({ id, name: id, creatorId: "self", access: "public",
        hidden: false, hasPassword: false, authorized: true, canManage: true,
        available: true, reading: id === "first", capabilities: { attachments: true } })), roles: [] },
    users: [{ id: "self", name: "Me", roles: [] }], sessions: [{ id: "endpoint", userId: "self", online: true }],
    publications: [], voice: [], subscriptions: [], pairs: [], iceServers: [],
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
    createRoomPolicy: async input => JSON.stringify(input),
    BrowserRoomHost: {
      open: async (_database, policy) => { host.roomId = (JSON.parse(policy) as { id: string }).id; return host; },
      storedPolicies: async () => [],
    },
  });
  const { session, socket } = setup();
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
  const { session, socket } = setup();
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

test("a separate directory storage error does not fail a committed room request", async () => {
  const { session, socket } = setup();
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
  const { session, socket } = setup();
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

test("merges live messages and original confirmations once in room order within the latest window", () => {
  const { session, socket } = setup(2);
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

test("pages beyond a full window without live messages interrupting reading, then returns to latest", async () => {
  const { session, socket } = setup(3);
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
  const { session, socket } = setup(1);
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

class RoomDataChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly label: string, readonly options: RTCDataChannelInit) {}
  open() { this.readyState = "open"; this.onopen?.(); }
  close() { if (this.readyState === "closed") return; this.readyState = "closed"; this.onclose?.(); }
}
class RoomPeerConnection {
  static instances: RoomPeerConnection[] = [];
  connectionState = "new";
  signalingState = "stable";
  localDescription = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate = null;
  onnegotiationneeded = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RoomDataChannel }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  channels: RoomDataChannel[] = [];
  senders: Array<{ track: MediaStreamTrack }> = [];
  close = vi.fn(() => { this.connectionState = "closed"; });
  constructor() { RoomPeerConnection.instances.push(this); }
  createDataChannel(label: string, options: RTCDataChannelInit) {
    const channel = new RoomDataChannel(label, options); this.channels.push(channel); return channel;
  }
  addTrack(track: MediaStreamTrack) { const sender = { track }; this.senders.push(sender); return sender; }
  removeTrack(sender: { track: MediaStreamTrack }) { this.senders.splice(this.senders.indexOf(sender), 1); }
  getReceivers() { return []; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; }
  async setLocalDescription() {}
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

function setupRoomMedia() {
  RoomPeerConnection.instances = [];
  RoomAudio.instances = [];
  vi.stubGlobal("RTCPeerConnection", RoomPeerConnection);
  vi.stubGlobal("Audio", RoomAudio);
  vi.stubGlobal("MediaStream", class {
    constructor(private tracks: MediaStreamTrack[]) {}
    getTracks() { return this.tracks; }
  });
  vi.stubGlobal("document", { body: { append: vi.fn() } });
  const { session, socket } = setup();
  const state = structuredClone(session.getSnapshot().state!);
  const sent: ChannelCommand[] = [];
  const media = new ChannelMedia(command => sent.push(command), () => {});
  state.pairs = [{ id: "pair", peerId: "z", rooms: ["first"], incoming: [], outgoing: [] }];
  media.update("a", state);
  return { session, socket, media, state, sent, pc: RoomPeerConnection.instances[0] };
}

test("base proof waits for open data and connected transport; removing leases preserves media", () => {
  const { session, media, state, sent, pc } = setupRoomMedia();
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
    state.pairs[0].outgoing = ["screen"];
    media.update("a", state);
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.filter(command => command.type === "base_state" && !command.ready)).toEqual([]);
    state.pairs = [];
    media.update("a", state);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(sent.filter(command => command.type === "base_state" && !command.ready)).toEqual([]);
  } finally { media.reset(); session.close(); }
});

test("data failure retires only the base attempt and does not retry unchanged demand", () => {
  const { session, media, state, sent, pc } = setupRoomMedia();
  try {
    pc.connected(); pc.channels[0].open(); pc.channels[0].close();
    expect(sent.at(-1)).toEqual({ type: "base_state", pairId: "pair", roomId: "first", ready: false });
    media.update("a", state); media.update("a", state);
    expect(pc.channels).toHaveLength(1);
    expect(pc.close).not.toHaveBeenCalled();
    expect(sent.some(command => command.type === "link_state" && command.state === "failed")).toBe(false);
    state.pairs[0].rooms.push("second");
    media.update("a", state);
    expect(pc.channels).toHaveLength(2);
  } finally { media.reset(); session.close(); }
});

test("transient transport loss retains base leases and proves new leases after recovery", () => {
  const { session, media, state, sent, pc } = setupRoomMedia();
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

test("connected media keeps its PC when the base channel exceeds the existing preparation deadline", () => {
  vi.useFakeTimers();
  const { session, media, state, sent, pc } = setupRoomMedia();
  try {
    pc.connected();
    vi.advanceTimersByTime(19999);
    expect(sent.some(command => command.type === "base_state")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: "base_state", pairId: "pair", roomId: "first", ready: false });
    expect(pc.close).not.toHaveBeenCalled();
    media.update("a", state);
    expect(pc.channels).toHaveLength(1);
    vi.advanceTimersByTime(20000);
    expect(sent.filter(command => command.type === "base_state")).toHaveLength(1);
  } finally { media.reset(); session.close(); }
});

test("browsing retires only reading and resumes the offline selection without ending subscriptions", async () => {
  const { session, socket } = setup();
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
    expect(socket.sent.slice(-2)).toEqual([{ type: "browse", roomId: "first", active: false }, { type: "browse", roomId: "second", active: true }]);
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    socket.close();
    const count = socket.sent.length;
    session.browse("first");
    expect(socket.sent).toHaveLength(count);
    session.reconnect();
    const resumed = ChannelSocket.current;
    resumed.onopen?.();
    state.channel.rooms.forEach(room => { room.reading = room.id === "second"; });
    resumed.receive({ type: "welcome", credential: "credential", sessionId: "endpoint", state });
    expect(resumed.sent.slice(-2)).toEqual([{ type: "browse", roomId: "second", active: false }, { type: "browse", roomId: "first", active: true }]);
    expect(session.getSnapshot().state?.subscriptions).toEqual(["screen"]);
    expect(resumed.sent.some(command => ["unpublish", "subscribe", "voice"].includes(String(command.type)))).toBe(false);
  } finally { session.close(); }
});

test("rapid browsing retires the previous intent before its reading projection arrives", () => {
  const { session, socket } = setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms.forEach(room => { room.reading = false; });
    socket.receive({ type: "state", state });
    session.browse("first");
    session.browse("second");
    expect(socket.sent.slice(-3)).toEqual([
      { type: "browse", roomId: "first", active: true },
      { type: "browse", roomId: "first", active: false },
      { type: "browse", roomId: "second", active: true },
    ]);
  } finally { session.close(); }
});

test("a resumed room owner retires reading left behind by an offline room switch", () => {
  const { session, socket } = setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.channel.rooms[0].available = false;
    socket.receive({ type: "state", state });
    const beforeSwitch = socket.sent.length;
    session.browse("second");
    expect(socket.sent.slice(beforeSwitch)).toEqual([{ type: "browse", roomId: "second", active: true }]);
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
  const { session, media, state, pc } = setupRoomMedia();
  const aTrack = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  const bTrack = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  const voice = (id: string, track: MediaStreamTrack) => ({ id, getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }) as unknown as MediaStream;
  const incoming = voice("a-stream", aTrack), local = voice("b-stream", bTrack);
  try {
    pc.connected(); pc.channels[0].open();
    state.pairs[0].incoming = ["voice-a"];
    state.pairs[0].outgoing = ["voice-b"];
    state.pairs.push({ id: "downstream", peerId: "y", rooms: ["first"], incoming: [], outgoing: ["voice-a"] });
    media.setLocal("voice-b", local);
    media.update("a", state);
    const downstream = RoomPeerConnection.instances[1];
    downstream.connected(); downstream.channels[0].open();
    media.signal("pair", { description: { type: "offer", sdp: "fixture" }, tracks: [{ publicationId: "voice-a", streamId: incoming.id }] });
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
    state.pairs.push({ id: "another-child", peerId: "x", rooms: ["first"], incoming: [], outgoing: ["voice-a"] });
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
