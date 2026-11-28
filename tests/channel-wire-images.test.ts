import { PRODUCT_VERSION } from "../src/client/channel/product-version";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { INPUT_FRAME_BYTES, REMOTE_INPUT_COMMAND_BYTES, REMOTE_TEXT_BYTES } from "../src/client/remote-control/protocol";
import { CHANNEL_EVENT_BYTES, CHANNEL_ROOM_LIMIT, CHANNEL_SESSION_LIMIT, IDENTITY_IMAGE_URL_BYTES, PROFILE_PAGE_SIZE, ChannelEventDecoder } from "../src/client/channel/protocol";

const picture = "data:image/png;base64,YWJj";
const version = "a".repeat(64);
const snapshot = () => ({
  channel: { id: "domain", name: "Friends", icon: picture, ownerId: null, roomCreationPolicy: "ordinary", askUnnamedMemberName: false, hostingMode: "lightweight", historyWindow: 1000, userCount: 1, managedRoomIds: [], rooms: [{
    id: "room", name: "Room", icon: "couch", picture: picture as string | null, creatorId: "user", access: "public", hidden: false,
    hasPassword: false, authorized: true, canManage: false, participantSessionIds: [], lastMessageSeq: 0, fileActivity: [],
    available: true, reading: true, capabilities: { attachments: true },
  }] },
  users: [{ id: "user", name: "Friend", version }], sessions: [], publications: [], voice: [],
  subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [], files: [], pairs: [], iceServers: [],
});
const welcome = (state = snapshot()) => ({ type: "welcome", ...PRODUCT_VERSION, credential: "credential", sessionId: "endpoint",
  selfProfile: { id: "user", name: "Friend", avatar: picture, version }, state });
const omitted = (state = snapshot()) => {
  const { icon, rooms, ...channel } = state.channel;
  return { type: "state", state: { ...state,
    channel: { ...channel, rooms: rooms.map(({ picture, ...room }) => room) },
  } };
};
const decode = (decoder: ChannelEventDecoder, event: unknown) => {
  const text = JSON.stringify(event);
  return decoder.decode(JSON.parse(text), new TextEncoder().encode(text).byteLength);
};

it("matches the compiled Core wire contract for schemas built before WASM initialization", async () => {
  const core = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await core.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  expect(JSON.parse(core.channel_wire_limits())).toEqual({
    ...PRODUCT_VERSION, sessions: CHANNEL_SESSION_LIMIT, rooms: CHANNEL_ROOM_LIMIT,
    inputFrameBytes: INPUT_FRAME_BYTES, inputCommandBytes: REMOTE_INPUT_COMMAND_BYTES, inputTextBytes: REMOTE_TEXT_BYTES,
    profilePage: PROFILE_PAGE_SIZE, eventBytes: CHANNEL_EVENT_BYTES, identityImageBytes: IDENTITY_IMAGE_URL_BYTES,
  });
});

it("WASM reports unknown host input before its first projection and completes the following sync", async () => {
  const core = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await core.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  const creatorId = crypto.randomUUID(), hostSessionId = crypto.randomUUID(), bindingId = crypto.randomUUID();
  const policy = core.create_room_policy(JSON.stringify({ id: "room", name: "Room", icon: "couch", creatorId, access: "public", hidden: false }));
  const host = new core.RoomHost(policy);
  try {
    const dispatch = (action: object, revision: number) => JSON.parse(host.dispatch(JSON.stringify({
      hostingMode: "lightweight", channelOwnerId: creatorId, now: 1000, bindingId, hostSessionId, revision, endpoints: {}, action,
    })));
    expect(dispatch({ type: "future_action" }, 1))
      .toEqual({ type: "host_unsupported", roomId: "room", bindingId, revision: 1 });
    dispatch({ type: "sync" }, 2);
    expect(JSON.parse(host.finish(undefined))).toMatchObject({ bindingId, revision: 2, projection: { summary: { id: "room" } } });
  } finally { host.free(); }
});

it("accepts the Core session budget and rejects one extra session", () => {
  const state = { ...snapshot(), sessions: Array.from({ length: CHANNEL_SESSION_LIMIT }, (_, index) => ({
    id: `endpoint-${index}`, userId: "user", online: true, signingKey: Array(32).fill(0), ...PRODUCT_VERSION,
  })) };
  expect(() => decode(new ChannelEventDecoder(), { ...welcome(), state })).not.toThrow();
  state.sessions.push({ ...state.sessions[0]!, id: "extra" });
  expect(() => decode(new ChannelEventDecoder(), { ...welcome(), state })).toThrow();
});

it("accepts the Core room budget and rejects one extra room", () => {
  const state = snapshot(), room = state.channel.rooms[0]!;
  state.channel.rooms = Array.from({ length: CHANNEL_ROOM_LIMIT }, (_, index) => ({ ...room, id: `room-${index}` }));
  expect(() => decode(new ChannelEventDecoder(), welcome(state))).not.toThrow();
  state.channel.rooms.push({ ...room, id: "extra" });
  expect(() => decode(new ChannelEventDecoder(), welcome(state))).toThrow();
});

it("ignores extra members in watch state while validating known values", () => {
  const next = { displayLabel: "Evening" };
  const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" };
  const activity = {
    id: "watch", roomId: "room", userId: "user", sessionId: "endpoint",
    predecessor: { kind: "screen", id: "screen" },
    source: { kind: "media", url: "https://video.test/watch" },
    playback: { timeline: "media", position: 0, paused: true, rate: 1, anchorTime: 0 },
    viewerSessionIds: [], byteSource: source,
  };
  const subscription = { id: activity.id, mode: "peer" };
  const plan = { roomId: "room", activityId: crypto.randomUUID(), source, upstream: null, downstream: [], receiving: false };
  const read = (watch: unknown, binding: unknown = subscription, bytes: unknown = plan) => decode(new ChannelEventDecoder(), {
    type: "state", state: { ...snapshot(), watchActivities: [watch], watchSubscriptions: [binding], watchBytes: [bytes] },
  });
  const event = read({ ...activity, ...next, predecessor: { ...activity.predecessor, ...next },
    source: { ...activity.source, ...next }, byteSource: { ...source, ...next } },
  { ...subscription, ...next }, { ...plan, ...next, source: { ...source, ...next } });
  expect(event).toHaveProperty("state.watchActivities", [activity]);
  expect(event).toHaveProperty("state.watchSubscriptions", [subscription]);
  expect(event).toHaveProperty("state.watchBytes", [plan]);
  expect(() => read({ ...activity, playback: { ...activity.playback, rate: "fast" } })).toThrow();
  expect(() => read({ ...activity, source: { ...activity.source, kind: "playlist" } })).toThrow();
  expect(() => read({ ...activity, predecessor: { ...activity.predecessor, kind: "playlist" } })).toThrow();
  expect(() => read(activity, { ...subscription, mode: "automatic" })).toThrow();
  expect(() => read(activity, subscription, { ...plan, source: { ...source, format: "playlist" } })).toThrow();
  expect(() => read(activity, subscription, { ...plan, receiving: "yes" })).toThrow();
});

it("only a reply can carry a result, with a validated request ID and known payload", () => {
  const decoder = new ChannelEventDecoder();
  const reply = { type: "reply", requestId: "request", roomId: "room" };
  expect(decode(decoder, { type: "future_notification", requestId: "request" })).toBeUndefined();
  expect(decode(decoder, { ...reply, result: { type: "future_result" } }))
    .toEqual({ ...reply, result: { type: "unknown_outcome" } });
  expect(decode(decoder, { type: "error", requestId: "request", code: "storage_failed" }))
    .toEqual({ type: "error", code: "storage_failed" });
  expect(() => decode(decoder, { ...reply, requestId: "", result: { type: "done" } })).toThrow();
  expect(() => decode(decoder, { ...reply, result: { type: "watch_ready" } })).toThrow();
  expect(() => decode(decoder, { ...reply, result: { type: "topology", topology: { address: "private" } } })).toThrow();
});

describe("physical socket site and room pictures", () => {
  it("hydrates omissions and retains every other state's authoritative fields", () => {
    const decoder = new ChannelEventDecoder();
    decode(decoder, welcome());
    const wire = omitted(); wire.state.users[0].name = "Renamed";
    const event = decode(decoder, wire);
    expect(event?.type).toBe("state");
    if (event?.type !== "state") throw new Error("Unexpected event");
    expect(event.state.users[0]).toEqual({ id: "user", name: "Renamed", version });
    expect(event.state.channel.icon).toBe(picture);
    expect(event.state.channel.rooms[0]).toMatchObject({ icon: "couch", picture });
    const cleared = snapshot(); cleared.channel.icon = "star"; cleared.channel.rooms[0].icon = "star"; cleared.channel.rooms[0].picture = null;
    decode(decoder, { type: "state", state: cleared });
    const inherited = decode(decoder, omitted());
    expect(inherited).toMatchObject({ state: { channel: { icon: "star", rooms: [{ icon: "couch" }] } } });
    expect(inherited).not.toHaveProperty("state.channel.rooms[0].picture");
  });

  it("does not inherit from an unknown room, a different domain or a retired room", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const unknown = omitted(); unknown.state.channel.rooms[0].id = "new-room";
    expect(decode(decoder, unknown)).not.toHaveProperty("state.channel.rooms[0].picture");
    decode(decoder, welcome());
    const domain = omitted(); domain.state.channel.id = "new-domain";
    expect(() => decode(decoder, domain)).toThrow(); // Site icon has no prior value in the new domain.
    const retired = snapshot(); retired.users = []; retired.channel.rooms = [];
    decode(decoder, { type: "state", state: retired });
    expect(decode(decoder, omitted())).not.toHaveProperty("state.channel.rooms[0].picture");
  });

  it.each(["authorized", "available", "reading"] as const)("drops room pictures when %s becomes false", flag => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const unavailable = snapshot(); unavailable.channel.rooms[0][flag] = false;
    expect(decode(decoder, { type: "state", state: unavailable })).not.toHaveProperty("state.channel.rooms[0].picture");
    const restored = decode(decoder, omitted());
    if (restored?.type !== "state") throw new Error("Unexpected event");
    expect(restored.state.channel.rooms[0].picture).toBeUndefined();
    expect(decode(decoder, { type: "state", state: snapshot() })).toMatchObject({ state: { channel: { rooms: [{ picture }] } } });
  });

  it("requires a full site icon in Welcome, uses the new snapshot's pictures and isolates sockets", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    expect(() => decode(new ChannelEventDecoder(), omitted())).toThrow();
    expect(() => decode(decoder, { ...welcome(), state: omitted().state })).toThrow();
    expect(() => decode(decoder, omitted())).not.toThrow();
    const renewed = snapshot(); renewed.channel.rooms[0].icon = "star"; renewed.channel.rooms[0].picture = null;
    decode(decoder, welcome(renewed));
    const wire = omitted(renewed);
    const event = decode(decoder, wire);
    expect(event).toMatchObject({ state: { channel: { rooms: [{ icon: "star" }] } } });
    expect(event).not.toHaveProperty("state.channel.rooms[0].picture");
  });

  it("keeps the previous cache when another field fails validation", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const invalid = snapshot(); invalid.channel.icon = "data:image/png;base64,ZGVm"; invalid.users[0].name = "x".repeat(41);
    expect(() => decode(decoder, { type: "state", state: invalid })).toThrow();
    decode(decoder, { type: "reply", requestId: "request", result: { type: "done" } });
    expect(decode(decoder, omitted())).toMatchObject({ state: { channel: { icon: picture } } });
  });

  it("reads full profiles independently of snapshot picture inheritance", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const profile = { id: "offline-user", name: "Offline friend", avatar: picture as string | null, version };
    const page = { type: "reply", requestId: "profiles", result: { type: "profiles", profiles: [profile], total: 1, nextCursor: null } };
    expect(decode(decoder, page)).toEqual(page);
    profile.avatar = null;
    expect(decode(decoder, page)).toMatchObject({ result: { profiles: [{ avatar: null }] } });
    const { avatar, ...missing } = profile;
    expect(() => decode(decoder, { ...page, result: { ...page.result, profiles: [missing] } })).toThrow();
    expect(decode(decoder, omitted())).toMatchObject({ state: { channel: { icon: picture } } });
  });

  it("bounds both raw and expanded frames", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    expect(() => decoder.decode({ type: "reply", requestId: "request", result: { type: "done" } }, CHANNEL_EVENT_BYTES + 1)).toThrow();
    const { state } = omitted();
    const wire = { type: "state", state: { ...state, channel: { ...state.channel, icon: "star" } } };
    expect(() => decoder.decode(wire, CHANNEL_EVENT_BYTES - 1)).toThrow();
  });
});
