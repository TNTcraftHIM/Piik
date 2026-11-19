import { afterEach, expect, test, vi } from "vitest";
import { NativeRoomHosting } from "../src/client/channel/hosting-api";

const hosting = new NativeRoomHosting("/rooms", {});
afterEach(() => vi.unstubAllGlobals());

test.each([
  [Response.json({ error: "expected_room_backup" }, { status: 400 }), "expected_room_backup"],
  [Response.json({ error: "storage_failed" }, { status: 409 }), "storage_failed"],
  [Response.json({ error: "room_restored_connection_failed" }, { status: 409 }), "room_restored_connection_failed"],
  [Response.json({ error: "upstream unavailable" }, { status: 503 }), "room_restore_unconfirmed"],
  [new Response("bad gateway", { status: 502 }), "room_restore_unconfirmed"],
  [new Response("truncated"), "room_restore_unconfirmed"],
  [Response.json({}), "room_restore_unconfirmed"],
] as const)("classifies the restore reply %#", async (reply, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
  await expect(hosting.restore(new Blob())).rejects.toThrow(expected);
});

test("reports lost restore reply without repeating the upload", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("network"));
  vi.stubGlobal("fetch", fetch);
  await expect(hosting.restore(new Blob())).rejects.toThrow("room_restore_unconfirmed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
