import { afterEach, expect, test, vi } from "vitest";
import { RoomReadMarkers } from "../src/client/channel/read-markers";

afterEach(() => vi.unstubAllGlobals());

test.each([true, false])("a stale tab cannot undo a restored read cursor (storage event first: %s)", eventFirst => {
  const key = "piik.channel.read.v2.site.reader";
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => storage.set(name, value),
  });
  const owner = new RoomReadMarkers();
  const staleTab = new RoomReadMarkers();
  const room = (id: string, bindingId: string, lastMessageSeq: number) => ({
    id, authorized: true, available: true, lastMessageSeq, historyLineage: bindingId,
    delivery: { bindingId, hostSessionId: "host" },
  });
  const otherRoom = room("other", "other-binding", 2);
  const before = [room("restored", "old-binding", 6), otherRoom];
  owner.project("site", "reader", before);
  expect(staleTab.project("site", "reader", before)).toEqual({ restored: 6, other: 2 });

  const restored = [room("restored", "new-binding", 1), otherRoom];
  expect(owner.project("site", "reader", restored)).toEqual({ restored: 0, other: 2 });
  owner.advance(restored, "restored", 1);
  if (eventFirst) expect(staleTab.refresh(before, key).restored).toBe(6);
  const staleSeq = eventFirst ? 6 : 7;
  const otherWithMessage = { ...otherRoom, lastMessageSeq: 3 };
  const stale = [room("restored", "old-binding", staleSeq), otherWithMessage];
  staleTab.advance(stale, "restored", staleSeq);
  if (!eventFirst) expect(staleTab.refresh(stale, key).restored).toBe(6);
  expect.soft(staleTab.advance(stale, "other", 3)).toMatchObject({ other: 3 });
  expect.soft(JSON.parse(storage.get(key)!)).toMatchObject({ restored: { seq: 1, lineage: "new-binding" }, other: { seq: 3 } });

  staleTab.project("site", "reader", [restored[0], otherWithMessage]);
  const withNewMessage = [room("restored", "new-binding", 2), otherWithMessage];
  expect(staleTab.advance(withNewMessage, "restored", 2)).toEqual({ restored: 2, other: 3 });
  expect(JSON.parse(storage.get(key)!)).toMatchObject({ restored: { seq: 2 }, other: { seq: 3 } });
});

test.each([80, 105])("offline restore preserves unread when the new branch reaches %s", tail => {
  const record = { seq: 100, lineage: "old" };
  const key = "piik.channel.read.v2.site.reader";
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
    ...room, lastMessageSeq, historyLineage: "new", delivery: { bindingId, hostSessionId: "host" },
  }];
  expect(tab.project("site", "reader", projected(tail, "new")).room).toBe(0);
  expect(tab.project("site", "reader", projected(tail + 1, "new")).room).toBe(0);
  expect(new RoomReadMarkers().project("site", "reader", projected(tail + 5, "reconnected")).room).toBe(0);
});

test.each(["storage refresh", "new room"])("a failed write preserves local progress on %s", trigger => {
  const room = { id: "room", authorized: true, available: true, lastMessageSeq: 12, historyLineage: "g",
    delivery: { bindingId: "bound", hostSessionId: "host" } };
  let diskSeq = 1;
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ room: { seq: diskSeq, lineage: "g" } }),
    setItem: () => { throw new DOMException("Full", "QuotaExceededError"); },
  });
  const tab = new RoomReadMarkers();
  expect(tab.project("site", "reader", [room]).room).toBe(1);
  expect(tab.advance([room], "room", 7).room).toBe(7);
  expect(tab.refresh([{ ...room, available: false }]).room).toBe(7);
  const result = trigger === "storage refresh" ? tab.refresh([room])
    : tab.project("site", "reader", [room, { ...room, id: "second" }]);
  expect(result.room).toBe(7);
  diskSeq = 9;
  expect(tab.refresh([room]).room).toBe(9);
  const restored = { ...room, lastMessageSeq: 3, historyLineage: "restored", delivery: { ...room.delivery, bindingId: "restored" } };
  expect(tab.project("site", "reader", [restored]).room).toBe(0);
  diskSeq = 2;
  expect(tab.project("site", "other-reader", [room]).room).toBe(2);
});

test("queued projections preserve another tab's later read and a skipped restore accepts a real read", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const room = (lineage: string) => [{
    id: "room", authorized: true, available: true, lastMessageSeq: 15, historyLineage: lineage,
    delivery: { bindingId: lineage, hostSessionId: "host" },
  }];
  const initial = room("original"), intermediate = room("first"), latest = room("second");
  const ahead = new RoomReadMarkers(), behind = new RoomReadMarkers();
  const show = (tab: RoomReadMarkers, rooms: ReturnType<typeof room>) => tab.project("site", "reader", rooms).room;
  show(behind, initial);
  show(ahead, initial);
  show(ahead, intermediate);
  ahead.advance(intermediate, "room", 4);
  show(ahead, latest);
  ahead.advance(latest, "room", 11);
  behind.refresh(initial);
  expect(show(behind, intermediate)).toBe(0);
  expect(show(behind, latest)).toBe(11);
  expect(show(new RoomReadMarkers(), latest)).toBe(11);

  const skipped = new RoomReadMarkers();
  show(skipped, latest);
  show(ahead, room("third"));
  ahead.advance(room("third"), "room", 5);
  const current = room("fourth");
  expect(show(skipped, current)).toBe(0);
  skipped.advance(current, "room", 6);
  expect(show(new RoomReadMarkers(), current)).toBe(6);
});
