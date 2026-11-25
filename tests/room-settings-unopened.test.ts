import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { ChannelRoomSettingsDialog } from "../src/client/channel/components/ChannelRoomControls";
import type { ChannelRoom } from "../src/client/channel/protocol";
import type { ChannelController } from "../src/client/channel/types";
import { setCopy, t } from "../src/client/ui/copy";

vi.mock("../src/client/channel/components/ChannelSettingsDialog", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/client/channel/components/ChannelSettingsDialog")>();
  return { ...actual, ChannelSettingsDialog: ({ children }: { children: ReactNode }) => createElement("div", null, children) };
});

test("room settings give the reason a room could not open here in place of offline", () => {
  setCopy({ lang: "en" });
  const room = { id: "room", name: "Own room", creatorId: "self", icon: "couch", access: "public", hasPassword: false,
    authorized: false, canManage: true, available: false, fileActivity: [], participantSessionIds: [], lastMessageSeq: 0,
    hidden: false, voiceBitrate: 64000, relayCapacity: 2, relayOverride: null, reading: false, capabilities: { attachments: true } } as ChannelRoom;
  const settings = (roomOpenFailures: ChannelController["roomOpenFailures"]) => renderToStaticMarkup(createElement(ChannelRoomSettingsDialog, {
    channel: { connection: "connected", pending: new Set(), profiles: new Map(), messagesByRoom: {}, roomOpenFailures,
      state: { channel: { rooms: [room] }, users: [] } } as unknown as ChannelController, room, onClose() {},
  }));
  const offline = t("en", "room.settings.offlineManager");
  expect(settings(new Map())).toContain(offline);
  expect(settings(new Map([["other", "unreadable"]]))).toContain(offline);
  const unreadable = settings(new Map([["room", "unreadable"]]));
  expect(unreadable).toContain(t("en", "room.unopened.unreadable"));
  expect(unreadable).not.toContain(offline);
  expect(settings(new Map([["room", "unsupported_version"]]))).toContain(t("en", "channel.error.unsupportedStorageVersion"));
});
