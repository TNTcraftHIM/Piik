import { afterEach, expect, test, vi } from "vitest";
import { ChannelSession } from "../src/client/channel/session";
import * as hosting from "../src/client/channel/hosting";
import { ChannelMedia } from "../src/client/channel/media";
import { ChannelTransport } from "../src/client/channel/transport";
import { signalSchema, type ChannelCommand, type ChannelSignal } from "../src/client/channel/protocol";

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
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate = null;
  onnegotiationneeded: (() => void) | null = null;
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
    a.setOutgoing(new Map([["voice", stream("original")]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0]).toHaveLength(1));
    const offer = structuredClone(sent[0].shift()!);
    let withheldAnswer: ChannelSignal | undefined;
    if (lost === "answer") {
      b.setOutgoing(new Map([["reverse", stream("revoked-reverse")]]));
      b.signal(offer);
      await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
      withheldAnswer = sent[1].shift(); // The peer applied the offer, but its answer was lost.
      b.setOutgoing(new Map());
    }
    // A later demand must not rewrite the manifest of the offer already in flight.
    a.setOutgoing(new Map([["voice", stream("replacement")]]));
    if (lost === "offer") {
      b.resync(); // Only the receiving peer reconnects; it cannot know A has an offer.
      await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
      a.signal(sent[1].shift()!);
    } else a.resync(); // Only the peer that missed the answer reconnects.
    await vi.waitFor(() => expect(sent[0].some(signal => signal.description)).toBe(true));
    const replay = sent[0].find(signal => signal.description)!;
    expect(replay).toEqual({ ...offer, tracks: [] });
    expect(offer.tracks).toEqual([{ publicationId: "voice", streamId: "original" }]);
    b.signal(replay);
    await vi.waitFor(() => expect(sent[1].some(signal => signal.description?.type === "answer")).toBe(true));
    const answer = sent[1].find(signal => signal.description?.type === "answer")!;
    expect(answer.exchangeId).toBe(offer.exchangeId);
    expect(answer.tracks).toEqual([]);
    if (withheldAnswer) expect(withheldAnswer.tracks).toEqual([{ publicationId: "reverse", streamId: "revoked-reverse" }]);
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
    a.setOutgoing(new Map([["voice", stream("old")]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0]).toHaveLength(1));
    const oldOffer = sent[0].shift()!;
    b.signal(oldOffer);
    await vi.waitFor(() => expect(sent[1]).toHaveLength(1));
    const oldAnswer = sent[1].shift()!;
    a.signal(oldAnswer);
    await vi.waitFor(() => expect(pcA.signalingState).toBe("stable"));
    a.setOutgoing(new Map([["voice", stream("new")]]));
    pcA.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent[0].some(signal => signal.description)).toBe(true));
    const newOffer = sent[0].find(signal => signal.description)!;
    expect(newOffer.exchangeId).not.toBe(oldOffer.exchangeId);
    expect(newOffer.tracks).toEqual([{ publicationId: "voice", streamId: "new" }]);
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
  const { session, socket } = setup();
  try {
    const state = structuredClone(session.getSnapshot().state!);
    state.pairs = ["kept", "removed"].map(id => ({ id, peerId: "z", rooms: ["first"], incoming: [], outgoing: [] }));
    socket.receive({ type: "state", state });
    const [kept, removed] = RoomPeerConnection.instances;
    kept.connected(); kept.channels[0].open();
    socket.close(); session.reconnect();
    const resumed = ChannelSocket.current;
    resumed.onopen?.();
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
  const offer = (streams: MediaStream[]) => transport.signal({
    exchangeId: crypto.randomUUID(), description: { type: "offer", sdp: "source update" },
    tracks: streams.map(stream => ({ publicationId: "voice", streamId: stream.id })),
  });
  try {
    offer([old]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    pc.ontrack?.({ streams: [old] });
    expect(receive).toHaveBeenLastCalledWith("voice", old);
    offer([current]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    pc.ontrack?.({ streams: [current] });
    pc.ontrack?.({ streams: [old] }); // A retired source event must not repopulate the cache.
    receive.mockClear();
    offer([old, current]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(receive.mock.calls).toEqual([["voice", current]]);
    const fresh = stream(old.id);
    pc.ontrack?.({ streams: [fresh] });
    expect(receive).toHaveBeenLastCalledWith("voice", fresh);
    expect(stop).not.toHaveBeenCalled();
  } finally { transport.close(); }
});

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
    media.signal("pair", { exchangeId: "incoming-exchange", description: { type: "offer", sdp: "fixture" }, tracks: [{ publicationId: "voice-a", streamId: incoming.id }] });
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
