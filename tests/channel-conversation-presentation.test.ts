import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelConversation as ConversationView } from "../src/client/channel/components/ChannelConversation";
import type { ChannelMessage } from "../src/client/channel/protocol";
import { setCopy } from "../src/client/ui/copy";

function historyMarkup(times: number[]) {
  setCopy({ lang: "en" });
  const messages: ChannelMessage[] = times.map((time, index) => ({ id: `message-${index}`, seq: index + 1,
    userId: "author", text: `Message ${index + 1}`, time, attachments: [] }));
  return renderToStaticMarkup(createElement(ConversationView, {
    domainId: "site", roomId: "room", roomName: "Room", messages, users: [], profiles: new Map(),
    queryProfiles: async () => ({ profiles: [], total: 0, nextCursor: null }), selfUserId: "self", canSend: true,
    sending: false, hidden: false, available: true, attachments: {} as never, attachmentsAvailable: false,
    history: { hasMore: false, atLatest: true }, loadingHistory: false, onHistory: async () => {},
    onLatest: async () => {}, onSend: async () => {}, interaction: null,
  }));
}

test("the first loaded day has an absolute date and message metadata exposes the full timestamp", () => {
  const date = new Date(2020, 0, 1, 20, 0, 12);
  const html = historyMarkup([date.getTime(), date.getTime() + 30_000]);
  expect(html.match(/class="c3-message-date"/g)).toHaveLength(1);
  expect(html).toContain(date.toLocaleDateString("en", { dateStyle: "long" }));
  const timestamp = date.toLocaleString("en", { dateStyle: "long", timeStyle: "long" });
  expect(html).toContain(`title="${timestamp}" aria-label="${timestamp}"`);
  expect(html).toContain('c3-message c3-reaction-message is-continuation');
  const continuation = html.split('is-continuation')[1];
  expect(continuation).toContain('<div class="visually-hidden"><strong>');
  expect(continuation).toContain(new Date(date.getTime() + 30_000).toISOString());
});

test("same-author messages break at local midnight, while a UTC date boundary alone does not", () => {
  const previousZone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const midnight = [new Date(2020, 0, 1, 23, 59, 30).getTime(), new Date(2020, 0, 2, 0, 0, 30).getTime()];
    expect(historyMarkup(midnight).match(/class="c3-message-date"/g)).toHaveLength(2);
    expect(historyMarkup(midnight)).not.toContain('is-continuation');
    const utcMidnight = [Date.parse("2020-01-02T23:59:30Z"), Date.parse("2020-01-03T00:00:30Z")];
    expect(historyMarkup(utcMidnight).match(/class="c3-message-date"/g)).toHaveLength(1);
    expect(historyMarkup(utcMidnight)).toContain('is-continuation');
  } finally {
    if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
  }
});

test("prepending history keeps one divider per local day", () => {
  const first = new Date(2020, 0, 1, 20).getTime(), earlier = new Date(2019, 11, 31, 20).getTime();
  expect(historyMarkup([first, first + 30_000]).match(/class="c3-message-date"/g)).toHaveLength(1);
  expect(historyMarkup([first - 30_000, first, first + 30_000]).match(/class="c3-message-date"/g)).toHaveLength(1);
  expect(historyMarkup([earlier, first, first + 30_000]).match(/class="c3-message-date"/g)).toHaveLength(2);
});
