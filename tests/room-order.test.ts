import { afterEach, expect, test, vi } from "vitest";
import { moveRoom, moveRoomWithinAvailability, orderedRooms, readRoomOrder, roomAvailabilityGroups, roomOrderKey } from "../src/client/channel/room-order";
import type { ChannelRoom } from "../src/client/channel/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelRoomListItem } from "../src/client/channel/components/ChannelRoomListItem";
import { ChannelRoomEntry } from "../src/client/channel/components/ChannelRoomEntry";
import type { ChannelController } from "../src/client/channel/types";
import { setCopy } from "../src/client/ui/copy";

afterEach(() => vi.unstubAllGlobals());
test("room order is personal, keeps offline rooms, and appends newly available directory entries", () => {
  const rooms = ["a", "b", "c"].map(id => ({ id, available: id !== "b" }) as ChannelRoom);
  const key = roomOrderKey("site-a", "user-a")!;
  const saved = new Map([[key, JSON.stringify(["b", "retired", "a", "b"])]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null });
  expect(orderedRooms(rooms, readRoomOrder(key)).map(room => room.id)).toEqual(["b", "a", "c"]);
  expect(readRoomOrder(roomOrderKey("site-b", "user-a"))).toEqual([]);
  expect(readRoomOrder(roomOrderKey("site-a", "user-b"))).toEqual([]);
  const renamed = rooms.map(room => ({ ...room, name: room.id === "b" ? "Renamed" : room.id }));
  expect(orderedRooms(renamed, readRoomOrder(key)).map(room => room.id)).toEqual(["b", "a", "c"]);
  const recreated = [...renamed.filter(room => room.id !== "b"), { id: "new-b", name: "Renamed", available: true } as ChannelRoom];
  expect(orderedRooms(recreated, readRoomOrder(key)).map(room => room.id)).toEqual(["a", "c", "new-b"]);
  expect(moveRoom(["b", "a", "c"], "b", "c")).toEqual(["a", "c", "b"]);
  expect(moveRoom(["a", "c", "b"], "b", "a")).toEqual(["b", "a", "c"]);
  expect(moveRoom(["a", "b"], "unknown", "b")).toEqual(["a", "b"]);
  saved.set(key, '{"a":1}'); expect(readRoomOrder(key)).toEqual([]);
});

test("availability groups keep personal order within each group after a host returns", () => {
  const rooms = ["a", "b", "c", "d", "e"].map(id => ({ id, available: id !== "b" && id !== "d" }) as ChannelRoom);
  const groups = (ordered: readonly ChannelRoom[]) => roomAvailabilityGroups(ordered).map(group => group.rooms.map(room => room.id));
  expect(groups(rooms)).toEqual([["a", "c", "e"], ["b", "d"]]);
  const onlineMove = moveRoomWithinAvailability(rooms, true, "e", "a")!;
  expect(onlineMove).toEqual({ ids: ["e", "b", "a", "d", "c"], position: 1, total: 3 });
  const offlineMove = moveRoomWithinAvailability(orderedRooms(rooms, onlineMove.ids), false, "b", "d")!;
  expect(groups(orderedRooms(rooms, offlineMove.ids))).toEqual([["e", "a", "c"], ["d", "b"]]);
  rooms[1].available = true;
  expect(groups(orderedRooms(rooms, offlineMove.ids))).toEqual([["e", "a", "b", "c"], ["d"]]);
  rooms[3].available = true;
  expect(groups(orderedRooms(rooms, offlineMove.ids))).toEqual([["e", "d", "a", "b", "c"]]);
});

test("a move cannot use a room from outside the group where it started", () => {
  const rooms = ["a", "b", "c"].map(id => ({ id, available: id !== "c" }) as ChannelRoom);
  expect(moveRoomWithinAvailability(rooms, true, "a", "c")).toBeUndefined();
  expect(moveRoomWithinAvailability(rooms, true, "a", "missing")).toBeUndefined();
  expect(moveRoomWithinAvailability(rooms, true, "missing", "b")).toBeUndefined();
  rooms[0].available = false;
  rooms[1].available = false;
  expect(moveRoomWithinAvailability(rooms, true, "a", "b")).toBeUndefined();
});

test("room navigation and private entry use host availability, not the creator's endpoint presence", () => {
  setCopy({ lang: "en" });
  const room = { id: "room", name: "Retained room", creatorId: "owner", icon: "couch", access: "private", hasPassword: true,
    authorized: false, canManage: false, available: true, fileActivity: [], participantSessionIds: [], lastMessageSeq: 0,
    hidden: false, voiceBitrate: 64000, relayCapacity: 2, relayOverride: null, reading: false, capabilities: { attachments: true } } as ChannelRoom;
  const channel = { connection: "connected", pending: new Set(), readByRoom: {}, ownedScreens: new Set(), profiles: new Map(),
    state: { channel: { rooms: [room] }, users: [], sessions: [
      { id: "owner-browser", userId: "owner", online: false }, { id: "owner-app", userId: "owner", online: false },
    ], publications: [], voice: [], watchActivities: [], subscriptions: [], watchSubscriptions: [] } } as unknown as ChannelController;
  const list = () => renderToStaticMarkup(createElement(ChannelRoomListItem, { channel, room, selected: true, settingsOpen: false, onSelect() {}, onManage() {} }));
  const entry = () => renderToStaticMarkup(createElement(ChannelRoomEntry, { channel, room }));
  expect(list()).not.toContain('data-offline');
  expect(entry().match(/<input\b[^>]*>/)?.[0]).not.toContain('disabled');
  expect(entry()).toContain('Enter its password');
  channel.state!.sessions[0].online = true; // A different endpoint's presence cannot revive an unavailable host.
  room.available = false;
  expect(list()).toContain('data-offline="true"');
  expect(list()).toContain('aria-label="Retained room"');
  expect(entry()).toContain('room is temporarily offline');
  expect(entry().match(/<input\b[^>]*>/)?.[0]).toContain('disabled');
});
