import { afterEach, expect, test, vi } from "vitest";
import { ChannelSession } from "../src/client/channel/session";

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

afterEach(() => { vi.unstubAllGlobals(); });

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
        hidden: false, hasPassword: false, authorized: true, canManage: true })), roles: [] },
    users: [{ id: "self", name: "Me", roles: [] }], sessions: [{ id: "endpoint", userId: "self", online: true }],
    publications: [], voice: [], subscriptions: [], pairs: [], iceServers: [],
  } });
  return { session, socket };
}

const message = (seq: number) => ({ id: `message-${seq}`, seq, userId: "self", text: `Hello ${seq}`, time: seq, attachments: [] });

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
