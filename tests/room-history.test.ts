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

const image = { data: "AAAA", mediaType: "image/png" as const, original: false, width: 1, height: 1 };
const photo = (seq: number) => ({
  ...message(seq, "@reader"), mentions: [{ userId: "reader", start: 0, end: 7 }],
  attachments: [{ id: "pic", name: "photo.png", size: 3, sha256: "1".repeat(64), mediaType: image.mediaType }],
  inlineImages: { pic: image },
});

test("a page saved before media cleanup cannot restore old images", () => {
  const history = new RoomHistory();
  const prior = photo(2), later = photo(3);
  const { inlineImages: _images, ...clean } = prior;
  const reactions = { revision: 1, counts: { heart: 1 } };
  history.openPage("latest", { bindingId: binding, replace: false });
  merge(history, "latest", end([prior], null, 1, true));
  history.dropPage("latest");
  history.openPage("older", { bindingId: binding, before: 2, replace: false });
  history.applyReactions(binding, reactionSnapshot(2, reactions.revision, reactions.counts));
  history.clearMedia(2);
  expect(history.messages).toEqual([{ ...clean, reactions }]);
  history.clearMedia(1);
  merge(history, "older", end([photo(1)], 2, 1));
  expect(history.messages?.[0].inlineImages).toBeUndefined();
  expect(history.messages?.[1]).toEqual({ ...clean, reactions });
  for (const live of [true, false]) {
    history.receiveMessage(prior, live, historyWindow);
    expect(history.messages?.[1]).toEqual({ ...clean, reactions });
  }
  history.receiveMessage(later, true, historyWindow);
  expect(history.messages?.[2]).toEqual(later);
  history.resetWindow();
  expect(history.visible(prior)).toEqual(clean);
  expect(new RoomHistory().visible(prior)).toEqual(prior);
});

test("a split refresh uses the writer's current renditions after a missed cleanup", () => {
  const history = new RoomHistory();
  history.openPage("latest", { bindingId: binding, replace: false });
  merge(history, "latest", end([photo(1), photo(2)], null, 1));
  history.dropPage("latest");
  const refresh = { from: 1, through: 2, latest: true, window: [] as ChannelMessage[] };
  const clean = [photo(1), photo(2)].map(({ inlineImages: _images, ...row }) => row);
  history.openPage("refresh", { bindingId: binding, replace: false, refresh });
  expect(merge(history, "refresh", end([clean[1]], null, 1, true))).toBe(false);
  history.dropPage("refresh");
  history.openPage("rest", { bindingId: binding, before: 2, replace: true, refresh });
  expect(merge(history, "rest", end([clean[0]], 2, 1))).toBe(true);
  expect(history.messages).toEqual(clean);
});
