import { expect, test } from "vitest";
import { roomCreationPolicySchema } from "../src/client/channel/protocol";
import { roomCreationPolicyFor, roomDraft, roomSettings } from "../src/client/channel/room-creation";

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
