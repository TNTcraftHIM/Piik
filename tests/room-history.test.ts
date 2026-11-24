import { expect, test } from "vitest";
import { RoomHistory } from "../src/client/channel/room-history";
import type { ChannelMessage } from "../src/client/channel/protocol";

const binding = "binding-1";
const historyWindow = 1000;

function message(seq: number, text = ""): ChannelMessage {
  return { id: `message-${seq}`, seq, time: seq, userId: "reader", attachments: [], text };
}
const reactionSnapshot = (seq: number, revision: number, counts: Record<string, number> = {}) =>
  ({ messageId: `message-${seq}`, messageSeq: seq, revision, counts });
const end = (count: number, before: number | null, oldestSeq: number | null = null, hasMore = false) =>
  ({ type: "history_end" as const, count, hasMore, oldestSeq, before });

/** Feeds a page's records the way a writer sends them: a snapshot, then the message. */
function deliver(history: RoomHistory, requestId: string, rows: ChannelMessage[]): void {
  for (const row of rows) {
    expect(history.applyReactions(binding, reactionSnapshot(row.seq, 0))).toEqual([]);
    expect(history.addMessage(requestId, row)).toBe(true);
  }
}

function merge(history: RoomHistory, requestId: string, record: ReturnType<typeof end>): boolean {
  const page = history.completePage(requestId, record);
  expect(page).toBeDefined();
  return history.mergePage(page!, historyWindow);
}

test("a removal reaches a page under assembly and redacts a reply to the removed message", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false, latestThrough: 0 });
  const reply = { ...message(2), reply: { seq: 1, userId: "reader", text: "quoted", notify: false } };
  expect(history.receiveMessage(message(1), true, historyWindow)).toBe(true);
  expect(history.receiveMessage(reply, true, historyWindow)).toBe(true);

  const removed = history.remove(0, [1], historyWindow);
  expect([removed(1), removed(2)]).toEqual([true, false]);
  expect(history.changes).toEqual({ clearedThrough: 0, deleted: new Set([1]) });
  const confirmed = { ...message(2), reactions: { revision: 0, counts: {} } };
  expect(history.messages).toEqual([confirmed]);

  expect(merge(history, "latest", end(0, null))).toBe(true);
  expect(history.messages).toEqual([confirmed]);
  expect(history.visible(message(1))).toBeUndefined();
});

test("a reaction snapshot that precedes its history message is merged at page end and the newer revision wins", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  expect(history.applyReactions(binding, reactionSnapshot(1, 2, { heart: 2 }))).toEqual([]);
  expect(history.applyReactions(binding, reactionSnapshot(1, 1, { heart: 1 }))).toEqual([]);
  expect(history.applyReactions("other-binding", reactionSnapshot(1, 9, { heart: 9 }))).toEqual([]);
  expect(history.addMessage("latest", message(1))).toBe(true);

  expect(merge(history, "latest", end(1, null, 1))).toBe(true);
  expect(history.messages).toEqual([{ ...message(1), reactions: { revision: 2, counts: { heart: 2 } } }]);
  expect(history.paging).toEqual({ hasMore: false, before: 1, atLatest: true });

  const window = history.messages;
  history.applyReactions(binding, reactionSnapshot(1, 1, { heart: 1 }));
  expect(history.messages).toBe(window);
  history.applyReactions(binding, reactionSnapshot(1, 3, { heart: 3 }));
  expect(history.messages?.[0].reactions).toEqual({ revision: 3, counts: { heart: 3 } });
});

test("a live message arriving while an older page loads joins that page and the latest window", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  deliver(history, "latest", [message(3), message(4)]);
  expect(merge(history, "latest", end(2, null, 1, true))).toBe(true);
  history.dropPage("latest");

  history.openPage("older", { bindingId: binding, before: 3, replace: false });
  expect(history.receiveMessage(message(5), true, historyWindow)).toBe(true);
  expect(history.messages?.map(row => row.seq)).toEqual([3, 4, 5]);
  deliver(history, "older", [message(1), message(2)]);
  expect(merge(history, "older", end(2, 3, 1))).toBe(true);
  expect(history.messages?.map(row => row.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(history.paging).toEqual({ hasMore: false, before: 1, atLatest: true });
});

test("a live message leaves a window that a jump moved away from the latest", () => {
  const history = new RoomHistory();
  history.openPage("jump", { bindingId: binding, before: 3, replace: true });
  deliver(history, "jump", [message(1), message(2)]);
  expect(merge(history, "jump", end(2, 3, 1))).toBe(true);
  expect(history.paging?.atLatest).toBe(false);
  history.dropPage("jump");

  expect(history.receiveMessage(message(6), true, historyWindow)).toBe(false);
  expect(history.messages?.map(row => row.seq)).toEqual([1, 2]);
});

test("a page whose records do not match its end record is incomplete", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  deliver(history, "latest", [message(1)]);
  expect(history.addMessage("latest", message(1))).toBe(false);
  expect(history.completePage("latest", end(2, null))).toBeUndefined();

  history.openPage("unreacted", { bindingId: binding, replace: false });
  expect(history.addMessage("unreacted", message(1))).toBe(true);
  expect(history.completePage("unreacted", end(1, null))).toBeUndefined();
  expect(history.addMessage("unknown", message(1))).toBe(false);
});

test("resetting the window keeps removal markers", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  deliver(history, "latest", [message(1), message(2)]);
  expect(merge(history, "latest", end(2, null, 1))).toBe(true);
  history.remove(1, [], historyWindow);

  history.resetWindow();
  expect(history.messages).toBeUndefined();
  expect(history.paging).toBeUndefined();
  expect(history.changes).toEqual({ clearedThrough: 1, deleted: new Set() });
  expect(history.visible(message(1))).toBeUndefined();
  expect(history.visible(message(2))).toEqual(message(2));
});
