import { describe, expect, it } from "vitest";
import { CHANNEL_EVENT_BYTES, CHANNEL_PROTOCOL, ChannelEventDecoder } from "../src/client/channel/protocol";

const picture = "data:image/png;base64,YWJj";
const version = "a".repeat(64);
const snapshot = () => ({
  channel: { id: "domain", name: "Friends", icon: picture, ownerId: null, historyWindow: 1000, userCount: 1, rooms: [{
    id: "room", name: "Room", icon: picture, creatorId: "user", access: "public", hidden: false,
    hasPassword: false, authorized: true, canManage: false, participantSessionIds: [], lastMessageSeq: 0, realtimeSessionIds: [],
    available: true, reading: false, capabilities: { attachments: true },
  }] },
  users: [{ id: "user", name: "Friend", version }], sessions: [], publications: [], voice: [],
  subscriptions: [], watchActivities: [], watchSubscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
});
const welcome = (state = snapshot()) => ({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint",
  selfProfile: { id: "user", name: "Friend", avatar: picture, version }, state });
const omitted = (state = snapshot()) => {
  const { icon, rooms, ...channel } = state.channel;
  return { type: "state", state: { ...state,
    channel: { ...channel, rooms: rooms.map(({ icon, ...room }) => room) },
  } };
};
const decode = (decoder: ChannelEventDecoder, event: unknown) => {
  const text = JSON.stringify(event);
  return decoder.decode(JSON.parse(text), new TextEncoder().encode(text).byteLength);
};

describe("physical socket site and room pictures", () => {
  it("hydrates omissions and retains every other state's authoritative fields", () => {
    const decoder = new ChannelEventDecoder();
    decode(decoder, welcome());
    const wire = omitted(); wire.state.users[0].name = "Renamed";
    const event = decode(decoder, wire);
    expect(event.type).toBe("state");
    if (event.type !== "state") throw new Error("Unexpected event");
    expect(event.state.users[0]).toEqual({ id: "user", name: "Renamed", version });
    expect(event.state.channel.icon).toBe(picture);
    expect(event.state.channel.rooms[0].icon).toBe(picture);
    const cleared = snapshot(); cleared.channel.icon = "star"; cleared.channel.rooms[0].icon = "couch";
    decode(decoder, { type: "state", state: cleared });
    const inherited = decode(decoder, omitted());
    expect(inherited).toMatchObject({ state: { channel: { icon: "star", rooms: [{ icon: "couch" }] } } });
  });

  it("rejects unknown subjects, changed domains and retired identities", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const unknown = omitted(); unknown.state.channel.rooms[0].id = "new-room";
    expect(() => decode(decoder, unknown)).toThrow();
    const domain = omitted(); domain.state.channel.id = "new-domain";
    expect(() => decode(decoder, domain)).toThrow();
    const retired = snapshot(); retired.users = []; retired.channel.rooms = [];
    decode(decoder, { type: "state", state: retired });
    expect(() => decode(decoder, omitted())).toThrow();
  });

  it("requires full Welcome and isolates physical socket replacement", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    expect(() => decode(new ChannelEventDecoder(), omitted())).toThrow();
    expect(() => decode(decoder, { ...welcome(), state: omitted().state })).toThrow();
    expect(() => decode(decoder, omitted())).not.toThrow();
    const renewed = snapshot(); renewed.channel.rooms[0].icon = "star";
    decode(decoder, welcome(renewed));
    expect(decode(decoder, omitted())).toMatchObject({ state: { channel: { rooms: [{ icon: "star" }] } } });
  });

  it("keeps the previous cache when another field fails validation", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const invalid = snapshot(); invalid.channel.icon = "data:image/png;base64,ZGVm"; invalid.users[0].name = "x".repeat(41);
    expect(() => decode(decoder, { type: "state", state: invalid })).toThrow();
    decode(decoder, { type: "ack", requestId: "request" });
    expect(decode(decoder, omitted())).toMatchObject({ state: { channel: { icon: picture } } });
  });

  it("reads full profiles independently of snapshot picture inheritance", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const profile = { id: "offline-user", name: "Offline friend", avatar: picture as string | null, version };
    const page = { type: "profiles", requestId: "profiles", profiles: [profile], total: 1, nextCursor: null };
    expect(decode(decoder, page)).toEqual(page);
    profile.avatar = null;
    expect(decode(decoder, page)).toMatchObject({ profiles: [{ avatar: null }] });
    const { avatar, ...missing } = profile;
    expect(() => decode(decoder, { ...page, profiles: [missing] })).toThrow();
    expect(decode(decoder, omitted())).toMatchObject({ state: { channel: { icon: picture } } });
  });

  it("bounds both raw and expanded frames", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    expect(() => decoder.decode({ type: "ack", requestId: "request" }, CHANNEL_EVENT_BYTES + 1)).toThrow();
    expect(() => decoder.decode(omitted(), CHANNEL_EVENT_BYTES - 1)).toThrow();
  });
});
