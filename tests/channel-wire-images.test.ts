import { describe, expect, it } from "vitest";
import { CHANNEL_EVENT_BYTES, CHANNEL_PROTOCOL, ChannelEventDecoder } from "../src/client/channel/protocol";

const picture = "data:image/png;base64,YWJj";
const snapshot = () => ({
  channel: { id: "domain", name: "Friends", icon: picture, ownerId: null, historyWindow: 1000, rooms: [{
    id: "room", name: "Room", icon: picture, creatorId: "user", access: "public", hidden: false,
    hasPassword: false, authorized: true, canManage: false, participantSessionIds: [], lastMessageSeq: 0, realtimeSessionIds: [],
    available: true, reading: false, capabilities: { attachments: true },
  }] },
  users: [{ id: "user", name: "Friend", avatar: picture as string | null }], sessions: [], publications: [], voice: [],
  subscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
});
const welcome = (state = snapshot()) => ({ type: "welcome", protocol: CHANNEL_PROTOCOL, credential: "credential", sessionId: "endpoint", state });
const omitted = (state = snapshot()) => {
  const { icon, rooms, ...channel } = state.channel;
  return { type: "state", state: { ...state,
    channel: { ...channel, rooms: rooms.map(({ icon, ...room }) => room) },
    users: state.users.map(({ avatar, ...user }) => user),
  } };
};
const decode = (decoder: ChannelEventDecoder, event: unknown) => {
  const text = JSON.stringify(event);
  return decoder.decode(JSON.parse(text), new TextEncoder().encode(text).byteLength);
};

describe("physical socket identity pictures", () => {
  it("hydrates omissions and retains every other state's authoritative fields", () => {
    const decoder = new ChannelEventDecoder();
    decode(decoder, welcome());
    const wire = omitted(); wire.state.users[0].name = "Renamed";
    const event = decode(decoder, wire);
    expect(event.type).toBe("state");
    if (event.type !== "state") throw new Error("Unexpected event");
    expect(event.state.users[0]).toEqual({ id: "user", name: "Renamed", avatar: picture });
    expect(event.state.channel.icon).toBe(picture);
    expect(event.state.channel.rooms[0].icon).toBe(picture);
    const cleared = snapshot(); cleared.users[0].avatar = null; cleared.channel.icon = "star";
    decode(decoder, { type: "state", state: cleared });
    const inherited = decode(decoder, omitted());
    expect(inherited).toMatchObject({ state: { users: [{ avatar: null }], channel: { icon: "star" } } });
  });

  it("rejects unknown subjects, changed domains and retired identities", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const unknown = omitted(); unknown.state.users[0].id = "new-user";
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
    const renewed = snapshot(); renewed.users[0].avatar = null;
    decode(decoder, welcome(renewed));
    expect(decode(decoder, omitted())).toMatchObject({ state: { users: [{ avatar: null }] } });
  });

  it("keeps the previous cache when another field fails validation", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    const invalid = snapshot(); invalid.users[0].avatar = "data:image/png;base64,ZGVm"; invalid.users[0].name = "x".repeat(41);
    expect(() => decode(decoder, { type: "state", state: invalid })).toThrow();
    decode(decoder, { type: "ack", requestId: "request" });
    expect(decode(decoder, omitted())).toMatchObject({ state: { users: [{ avatar: picture }] } });
  });

  it("bounds both raw and expanded frames", () => {
    const decoder = new ChannelEventDecoder(); decode(decoder, welcome());
    expect(() => decoder.decode({ type: "ack", requestId: "request" }, CHANNEL_EVENT_BYTES + 1)).toThrow();
    expect(() => decoder.decode(omitted(), CHANNEL_EVENT_BYTES - 1)).toThrow();
  });
});
