import { afterEach, expect, test, vi } from "vitest";
import { RoomReadMarkers } from "../src/client/channel/read-markers";

afterEach(() => vi.unstubAllGlobals());

test.each([true, false])("a stale tab cannot undo a restored read cursor (storage event first: %s)", eventFirst => {
  const key = "piik.channel.read.site.reader";
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => storage.set(name, value),
  });
  const owner = new RoomReadMarkers();
  const staleTab = new RoomReadMarkers();
  const room = (id: string, bindingId: string, lastMessageSeq: number) => ({
    id, authorized: true, available: true, lastMessageSeq,
    delivery: { bindingId, hostSessionId: "host", nextHops: {} },
  });
  const otherRoom = room("other", "other-binding", 2);
  const before = [room("restored", "old-binding", 6), otherRoom];
  owner.project("site", "reader", before);
  expect(staleTab.project("site", "reader", before)).toEqual({ restored: 6, other: 2 });

  const restored = [room("restored", "new-binding", 1), otherRoom];
  expect(owner.project("site", "reader", restored)).toEqual({ restored: 1, other: 2 });
  if (eventFirst) staleTab.refresh(before, key);
  const staleSeq = eventFirst ? 6 : 7;
  const otherWithMessage = { ...otherRoom, lastMessageSeq: 3 };
  const stale = [room("restored", "old-binding", staleSeq), otherWithMessage];
  staleTab.advance(stale, "restored", staleSeq);
  if (!eventFirst) staleTab.refresh(stale, key);
  expect.soft(staleTab.advance(stale, "other", 3)).toMatchObject({ other: 3 });
  expect.soft(JSON.parse(storage.get(key)!)).toMatchObject({ restored: { seq: 1, binding: "new-binding" }, other: { seq: 3 } });

  staleTab.project("site", "reader", [restored[0], otherWithMessage]);
  const withNewMessage = [room("restored", "new-binding", 2), otherWithMessage];
  expect(staleTab.advance(withNewMessage, "restored", 2)).toEqual({ restored: 2, other: 3 });
  expect(JSON.parse(storage.get(key)!)).toMatchObject({ restored: { seq: 2 }, other: { seq: 3 } });
});

test.each([100, { seq: 100, binding: "old" }])("offline restore preserves unread after the first authoritative projection", record => {
  const key = "piik.channel.read.site.reader";
  const storage = new Map([[key, JSON.stringify({ room: record })]]);
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => storage.set(name, value),
  });
  const tab = new RoomReadMarkers();
  const room = { id: "room", authorized: true, available: true, lastMessageSeq: 0 };
  tab.project("site", "reader", [room]);
  expect(JSON.parse(storage.get(key)!)).toEqual({ room: record });
  const projected = (lastMessageSeq: number, bindingId: string) => [{
    ...room, lastMessageSeq, delivery: { bindingId, hostSessionId: "host", nextHops: {} },
  }];
  expect(tab.project("site", "reader", projected(20, "new")).room).toBe(20);
  expect(tab.project("site", "reader", projected(21, "new")).room).toBe(20);
  expect(new RoomReadMarkers().project("site", "reader", projected(24, "reconnected")).room).toBe(20);
});

test.each(["storage refresh", "new room"])("a failed write preserves local progress on %s", trigger => {
  const room = { id: "room", authorized: true, available: true, lastMessageSeq: 12,
    delivery: { bindingId: "bound", hostSessionId: "host", nextHops: {} } };
  let diskSeq = 1;
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ room: { seq: diskSeq, binding: "bound" } }),
    setItem: () => { throw new DOMException("Full", "QuotaExceededError"); },
  });
  const tab = new RoomReadMarkers();
  expect(tab.project("site", "reader", [room]).room).toBe(1);
  expect(tab.advance([room], "room", 7).room).toBe(7);
  const result = trigger === "storage refresh" ? tab.refresh([room])
    : tab.project("site", "reader", [room, { ...room, id: "second" }]);
  expect(result.room).toBe(7);
  diskSeq = 9;
  expect(tab.refresh([room]).room).toBe(9);
  const restored = { ...room, lastMessageSeq: 3, delivery: { ...room.delivery, bindingId: "restored" } };
  expect(tab.project("site", "reader", [restored]).room).toBe(3);
  diskSeq = 2;
  expect(tab.project("site", "other-reader", [room]).room).toBe(2);
});
