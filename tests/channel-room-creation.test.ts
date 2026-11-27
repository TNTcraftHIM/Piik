import { expect, test, vi } from "vitest";
import { channelErrorPresentation } from "../src/client/components/error-presentation";
import { roomCreationPolicySchema } from "../src/client/channel/protocol";
import { roomCreationPolicyFor, roomDraft, roomSettings, readSimpleShareRoom, rememberSimpleShareRoom, roomSettingsPatch, simpleShareRoom, simpleShareRoomKey } from "../src/client/channel/room-creation";

test("room capacity points to recovery from both room creation entries", () => {
  expect(channelErrorPresentation("room_limit", key => key)).toEqual({
    message: "channel.error.roomLimit",
    connectionHelp: false,
  });
});

test.each(roomCreationPolicySchema.options)("the %s policy applies only to guests", roomCreationPolicy => {
  const channel = { ownerId: "owner", roomCreationPolicy };
  expect(roomCreationPolicyFor(channel, "guest")).toBe(roomCreationPolicy);
  expect(roomCreationPolicyFor(channel, "owner")).toBe("ordinary");
});

test("an invitation-only form or quick launch ignores public and password draft choices", () => {
  const draft = { ...roomDraft(), name: " Garden ", hidden: false, password: "old choice" };
  expect(roomSettings(draft, true)).toMatchObject({ name: "Garden", access: "private", hidden: true, password: null });
  expect(roomSettings({ ...draft, access: "private" }, true)).toMatchObject({ hidden: true, password: null });
  expect(roomSettings({ ...draft, access: "private" })).toMatchObject({ access: "private", hidden: false, password: "old choice" });
});

test("room edits only send changed fields and preserve explicit picture and password removal", () => {
  const room = { access: "private", hidden: false, hasPassword: true } as const;
  expect(roomSettingsPatch({ name: " New name " }, room)).toEqual({ name: "New name" });
  expect(roomSettingsPatch({ picture: null, password: "", removePassword: true }, room)).toEqual({ picture: null, password: null });
  expect(roomSettingsPatch({ access: "public", password: "", removePassword: false }, room)).toEqual({ access: "public" });
});

test("a remote switch to public omits private drafts unless the manager explicitly selects private", () => {
  const room = { access: "public", hidden: false, hasPassword: false } as const;
  const draft = { name: "Renamed", hidden: true, password: "new password" };
  expect(roomSettingsPatch(draft, room)).toEqual({ name: "Renamed" });
  expect(roomSettingsPatch({ ...draft, access: "private" }, room)).toEqual({ ...draft, access: "private" });
});

test("policy changes discard admission drafts and send only necessary invitation-only constraints", () => {
  const stale = { name: " Renamed ", access: "public", hidden: false, password: "old draft" } as const;
  const compliant = { access: "private", hidden: true, hasPassword: false } as const;
  expect(roomSettingsPatch(stale, compliant, true)).toEqual({ name: "Renamed" });
  const oldRoom = { access: "public", hidden: false, hasPassword: true } as const;
  expect(roomSettingsPatch(stale, oldRoom, true)).toEqual({ name: "Renamed", access: "private", hidden: true, password: null });
  expect(roomSettingsPatch({ password: "old draft" }, oldRoom, true)).toEqual({});
});

test("simple sharing returns to its own authorized room even while its host is offline", () => {
  const room = (id: string, creatorId: string, authorized = true, available = true) => ({ id, creatorId, authorized, available });
  const rooms = [room("work", "me"), room("friend", "friend"), room("offline", "me", true, false), room("locked", "me", false), room("shared", "me")];
  expect(simpleShareRoom(rooms, "me", null)).toBeUndefined();
  expect(simpleShareRoom(rooms, "me", "shared")?.id).toBe("shared");
  expect(simpleShareRoom(rooms, "me", "offline")?.id).toBe("offline");
  for (const id of ["deleted", "friend", "locked"]) expect(simpleShareRoom(rooms, "me", id)).toBeUndefined();
});

test("simple sharing remembers its room per site and person on this device", () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
  try {
    const key = simpleShareRoomKey("site", "me");
    expect(readSimpleShareRoom(key)).toBeNull();
    rememberSimpleShareRoom(key, "shared");
    expect(readSimpleShareRoom(key)).toBe("shared");
    expect(readSimpleShareRoom(simpleShareRoomKey("other-site", "me"))).toBeNull();
    expect(simpleShareRoomKey("site", undefined)).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
