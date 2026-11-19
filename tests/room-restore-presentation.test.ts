import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RoomRestoreResult } from "../src/client/channel/components/BackupControls";
import { ChannelSettingsError } from "../src/client/channel/components/ChannelSettingsDialog";
import { currentLang, t } from "../src/client/ui/copy";

test("an unconfirmed room restore offers closing and checking the room list", () => {
  const lang = currentLang();
  const html = renderToStaticMarkup(createElement(RoomRestoreResult, { message: t(lang, "channel.error.roomRestoreUnconfirmed"), unconfirmed: true, onClose() {} }));
  expect(html).toContain(t(lang, "channel.error.roomRestoreUnconfirmed"));
  expect(html).toContain(t(lang, "room.action.close"));
  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).not.toContain(t(lang, "room.create.reconnect"));
});

test("a confirmed commit followed by a failed reconnect reports that room data was restored", () => {
  const html = renderToStaticMarkup(createElement(ChannelSettingsError, { error: "room_restored_connection_failed" }));
  expect(html).toContain(t(currentLang(), "channel.error.roomRestoredConnectionFailed"));
  expect(html).not.toContain(t(currentLang(), "channel.error.roomRestoreUnconfirmed"));
});
