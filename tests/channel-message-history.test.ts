import { expect, test } from "vitest";
import { historyProfileIds, readingWindow } from "../src/client/channel/message-history";
import type { ChannelMessage } from "../src/client/channel/protocol";

function message(seq: number, text = ""): ChannelMessage {
  return { id: String(seq), seq, time: seq, userId: "reader", attachments: [], text };
}

test("history tracks live profiles for each retained page and excludes archived identities", () => {
  const quote = { seq: 1, userId: "author", text: "earlier", notify: true };
  const row = { ...message(2), reply: quote, mentions: [{ userId: "reader", start: 0, end: 1 }] };
  const page = [row, message(3)];
  const ids = historyProfileIds(page);
  expect(ids).toEqual(["reader", "author"]);
  expect(historyProfileIds(page)).toBe(ids);
  expect(historyProfileIds([{ ...row, archivedAuthorName: "Archive", reply: { ...quote, archivedAuthorName: "Archive" } }]))
    .toEqual(["reader"]);
});

test("history byte limits count image data and use the replacement row when its text changes", () => {
  const preview = { mediaType: "image/png" as const, original: false, width: 1, height: 1 };
  const first = message(1), last = { ...message(2), inlineImages: {
    a: { ...preview, data: "Aa9+/w==" }, b: { ...preview, data: '🌙"\\\n' },
  } };
  const size = (row: ChannelMessage) => new TextEncoder().encode(JSON.stringify(row)).length;
  const budget = 4 * 1024 * 1024;
  const full = { ...last, text: "a".repeat(budget - size(first) - size(last)) };
  expect(readingWindow([first, full], 2, true)).toHaveLength(2);
  const changed = { ...full, text: full.text + "a" };
  expect(readingWindow([first, changed], 2, true)).toEqual([changed]);
  expect(readingWindow([first, changed], 2, false)).toEqual([first]);
});
