import { expect, test } from "vitest";
import { RoomHistory } from "../src/client/channel/room-history";
import type { ChannelMessage } from "../src/client/channel/protocol";

const binding = "binding-1", historyWindow = 1000;
function message(seq: number, text = ""): ChannelMessage & { reactions: { revision: number; counts: Record<string, number> } } {
  return { id: `message-${seq}`, seq, time: seq, userId: "reader", attachments: [], text, reactions: { revision: 0, counts: {} } };
}
const reactionSnapshot = (seq: number, revision: number, counts: Record<string, number> = {}) =>
  ({ messageId: `message-${seq}`, messageSeq: seq, revision, counts });
const end = (messages: ReturnType<typeof message>[], before: number | null, oldestSeq: number | null = null, hasMore = false) =>
  ({ type: "history_page" as const, messages, hasMore, oldestSeq, before });
function merge(history: RoomHistory, requestId: string, record: ReturnType<typeof end>): boolean {
  const page = history.completePage(requestId, record);
  expect(page).toBeDefined();
  return history.mergePage(page!, historyWindow);
}

test("a removal reaches a pending history read and redacts a reply to the removed message", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false, latestThrough: 0 });
  const reply = { ...message(2), reply: { seq: 1, userId: "reader", text: "quoted", notify: false } };
  history.receiveMessage(message(1), true, historyWindow);
  history.receiveMessage(reply, true, historyWindow);
  const removed = history.remove(0, [1], historyWindow);
  expect([removed(1), removed(2)]).toEqual([true, false]);
  expect(merge(history, "latest", end([message(1), reply], null))).toBe(true);
  expect(history.messages).toEqual([message(2)]);
  expect(history.visible(message(1))).toBeUndefined();
});

test("a live reaction preceding the page keeps its newer revision and current binding", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  history.applyReactions(binding, reactionSnapshot(1, 2, { heart: 2 }));
  history.applyReactions(binding, reactionSnapshot(1, 1, { heart: 1 }));
  history.applyReactions("other-binding", reactionSnapshot(1, 9, { heart: 9 }));
  expect(merge(history, "latest", end([message(1)], null, 1))).toBe(true);
  expect(history.messages).toEqual([{ ...message(1), reactions: { revision: 2, counts: { heart: 2 } } }]);
  expect(history.paging).toEqual({ hasMore: false, before: 1, atLatest: true });
  const window = history.messages;
  history.applyReactions(binding, reactionSnapshot(1, 1, { heart: 1 }));
  expect(history.messages).toBe(window);
  history.applyReactions(binding, reactionSnapshot(1, 3, { heart: 3 }));
  expect(history.messages?.[0].reactions).toEqual({ revision: 3, counts: { heart: 3 } });
});

test("a live message arriving while an older page loads stays in the latest window", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  merge(history, "latest", end([message(3), message(4)], null, 1, true));
  history.dropPage("latest");
  history.openPage("older", { bindingId: binding, before: 3, replace: false });
  expect(history.receiveMessage(message(5), true, historyWindow)).toBe(true);
  expect(history.messages?.map(row => row.seq)).toEqual([3, 4, 5]);
  merge(history, "older", end([message(1), message(2)], 3, 1));
  expect(history.messages?.map(row => row.seq)).toEqual([1, 2, 3, 4, 5]);
});

test("a historical jump does not follow new live messages", () => {
  const history = new RoomHistory();
  history.openPage("jump", { bindingId: binding, before: 3, replace: true });
  merge(history, "jump", end([message(1), message(2)], 3, 1));
  history.dropPage("jump");
  expect(history.paging?.atLatest).toBe(false);
  expect(history.receiveMessage(message(6), true, historyWindow)).toBe(false);
  expect(history.messages?.map(row => row.seq)).toEqual([1, 2]);
});

test("a retired request cannot expose its late page", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  history.dropPage("latest");
  expect(history.completePage("latest", end([message(1)], null))).toBeUndefined();
  expect(history.messages).toBeUndefined();
});

test("resetting the window keeps removal markers", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  merge(history, "latest", end([message(1), message(2)], null, 1));
  history.remove(1, [], historyWindow);
  history.resetWindow();
  expect(history.messages).toBeUndefined();
  expect(history.paging).toBeUndefined();
  expect(history.changes).toEqual({ clearedThrough: 1, deleted: new Set() });
  expect(history.visible(message(1))).toBeUndefined();
  expect(history.visible(message(2))).toEqual(message(2));
});
