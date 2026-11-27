import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import init, { create_room_policy } from "../prototype/channel-browser/pkg/piik_channel_browser.js";
import { roomSummarySchema } from "../src/client/channel/protocol";
import { MAX_AUDIO_SEND_BITRATE, MIN_AUDIO_BITRATE } from "../src/shared/protocol";

test("the room voice wire schema matches Core's creation default and send range", async () => {
  await init({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  const settings = { id: "room", creatorId: crypto.randomUUID(), name: "Room", icon: "couch", access: "public", hidden: false };
  const schema = roomSummarySchema.shape.voiceBitrate;

  const create = (voiceBitrate?: number) => {
    const policy = create_room_policy(JSON.stringify({ ...settings, voiceBitrate }));
    return JSON.parse(policy).voiceBitrate;
  };
  expect(schema.parse(undefined)).toBe(create());
  for (const bitrate of [MIN_AUDIO_BITRATE, MAX_AUDIO_SEND_BITRATE]) {
    expect(schema.parse(bitrate)).toBe(create(bitrate));
  }
  for (const bitrate of [MIN_AUDIO_BITRATE - 1, MAX_AUDIO_SEND_BITRATE + 1]) {
    expect(schema.safeParse(bitrate).success).toBe(false);
    expect(() => create(bitrate)).toThrow("invalid_room_policy");
  }
});
