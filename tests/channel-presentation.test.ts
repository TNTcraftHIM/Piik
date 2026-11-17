import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelRoomParticipants } from "../src/client/channel/components/ChannelRoomParticipants";
import { ChannelPeople } from "../src/client/channel/components/ChannelPeople";
import type { ChannelController } from "../src/client/channel/types";
import { firstUnreadMessageId, participantActivity, roomPeople, roomRealtimePeople, screenTitle, watchAudience } from "../src/client/channel/presentation";
import { snapshotSchema, watchActivitySchema } from "../src/client/channel/protocol";
import { t, type CopyKey } from "../src/client/ui/copy";

import { WatchPlayer } from "../src/client/channel/watch-playback";
import type { WatchMedia } from "../src/client/channel/watch-media";

const english = (key: CopyKey) => t("en", key);
const chinese = (key: CopyKey) => t("zh", key);

it("projects joined watch people independently of transport and deduplicates their endpoints", () => {
  const sessions = [["owner-page", "owner"], ["owner-app", "owner"], ["viewer-web", "viewer"], ["viewer-app", "viewer"], ["direct-web", "direct"], ["relay-endpoint", "relay"]];
  const activity = watchActivitySchema.parse({ id: "watch", roomId: "room", sessionId: "owner-page", userId: "owner",
    source: { kind: "website", url: "https://video.test/watch" }, playback: { timeline: "media" as const, position: 0, paused: true, rate: 1, anchorTime: 0 },
    viewerSessionIds: ["owner-app", "viewer-web", "viewer-app", "direct-web", "retired"] });
  const state = snapshotSchema.parse({ channel: { id: "site", name: "Site", icon: "couch", ownerId: "owner", historyWindow: 1000, userCount: 4, rooms: [{
    id: "room", name: "Room", icon: "couch", creatorId: "owner", access: "public", hidden: false, hasPassword: false,
    authorized: true, canManage: true, available: true, reading: true, participantSessionIds: sessions.map(([id]) => id),
    lastMessageSeq: 0, realtimeSessionIds: sessions.map(([id]) => id), capabilities: { attachments: true },
  }] }, users: ["owner", "viewer", "direct", "relay"].map(id => ({ id, name: id, version: "a".repeat(64) })),
    sessions: sessions.map(([id, userId]) => ({ id, userId, online: true, signingKey: Array(32).fill(0) })),
    publications: [], voice: [], subscriptions: [], watchActivities: [activity], watchSubscriptions: [], watchBytes: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  });
  expect(watchAudience(state, activity)).toEqual([{ userId: "viewer", name: "viewer", avatar: undefined }, { userId: "direct", name: "direct", avatar: undefined }]);
  expect(roomRealtimePeople(state, "room").map(({ id, sharing, viewing }) => ({ id, sharing, viewing }))).toEqual([
    { id: "owner", sharing: true, viewing: "joined" }, { id: "viewer", sharing: false, viewing: "joined" },
    { id: "direct", sharing: false, viewing: "joined" }, { id: "relay", sharing: false, viewing: undefined },
  ]);
  expect(roomPeople(state, "room")).toHaveLength(4);
  const { viewerSessionIds: _viewers, ...oldActivity } = activity;
  expect(watchActivitySchema.safeParse(oldActivity).success).toBe(false);
  expect(watchAudience(state, { ...activity, viewerSessionIds: [] })).toEqual([]);
  const observedVideo = { readyState: 4, videoWidth: 640 };
  const video = observedVideo as HTMLVideoElement;
  const media: WatchMedia = { presentation: { kind: "video", element: video }, read: async () => ({ position: 0, paused: true, rate: 1, duration: 10, readyState: 4, ended: false, buffered: [[0, 10]] }),
    patch: async () => {}, ready: async () => {}, listen: () => () => {}, close() {} };
  const player = new WatchPlayer("room", false, media, () => {});
  const local = { sessionId: "viewer-web", watchPlayers: new Map([["watch", player]]) };
  try {
    expect(participantActivity(state, "room", "viewer", local).viewing).toBe("preparing"); // Metadata is not a composited frame.
    player.presentFrame();
    expect(participantActivity(state, "room", "viewer", local).viewing).toBe("active");
    observedVideo.readyState = 1; // A retained paused/offscreen player's first frame still belongs to this lease.
    expect(participantActivity(state, "room", "viewer", local).viewing).toBe("active");
    observedVideo.readyState = 4;
    expect(participantActivity(state, "room", "direct", local).viewing).toBe("joined");
    state.watchActivities[0].viewerSessionIds = ["viewer-app"];
    expect(participantActivity(state, "room", "viewer", local).viewing).toBe("joined"); // Same identity, different endpoint.
    state.watchActivities[0].viewerSessionIds = ["viewer-web"];
    player.error = "watch_media_failed";
    expect(participantActivity(state, "room", "viewer", local).viewing).toBe("failed");
  } finally { player.close(); }

});

it("starts unread messages at another person without consuming earlier unread history", () => {
  const own = { id: "own", seq: 1, userId: "self" };
  const other = { id: "other", seq: 2, userId: "friend" };
  expect(firstUnreadMessageId([own], 0, "self")).toBeUndefined();
  expect(firstUnreadMessageId([own, other], 0, "self")).toBe("other");
  expect(firstUnreadMessageId([other, { ...own, seq: 3 }], 0, "self")).toBe("other");
  expect(firstUnreadMessageId([own, other], 2, "self")).toBeUndefined();
  expect(firstUnreadMessageId([own, other], undefined, "self")).toBeUndefined();
  expect(firstUnreadMessageId([own, other], 0, "friend")).toBe("own");
});

describe("screen titles", () => {
  it("keeps a custom title across source replacement, then clears to the latest source", () => {
    const publication = { source: { kind: "screen" as const, name: "First window" }, title: null as string | null };
    expect(screenTitle(publication, english)).toBe("First window");
    publication.title = "Movie night";
    publication.source.name = "Second window";
    expect(screenTitle(publication, english)).toBe("Movie night");
    publication.title = null;
    expect(screenTitle(publication, english)).toBe("Second window");
  });

  it("localizes only missing source names and preserves literal human titles", () => {
    expect(screenTitle({ source: { kind: "screen", name: null }, title: null }, chinese)).toBe("分享画面");
    expect(screenTitle({ source: { kind: "screen", name: null }, title: null }, english)).toBe("Shared screen");
    expect(screenTitle({ source: { kind: "camera", name: null }, title: null }, chinese)).toBe("摄像头");
    expect(screenTitle({ source: { kind: "camera", name: null }, title: null }, english)).toBe("Camera");
    expect(screenTitle({ source: { kind: "screen", name: "<窗口>" }, title: "<Movie>" }, english)).toBe("<Movie>");
  });
});

it("merges a user's real-time endpoints without treating chat-only presence as participation", () => {
  const state = snapshotSchema.parse({
    channel: { id: "site", name: "Site", icon: "couch", ownerId: "self", historyWindow: 1000, userCount: 3, rooms: [{
      id: "room", name: "Room", icon: "couch", creatorId: "self", access: "public", hidden: false,
      hasPassword: false, authorized: true, canManage: true, available: true, reading: true,
      participantSessionIds: ["self-page", "chat-page"], lastMessageSeq: 0, realtimeSessionIds: ["self-page", "self-helper", "route-peer"], capabilities: { attachments: true },
    }] }, users: ["self", "chat", "route"].map(id => ({ id, name: id, version: "a".repeat(64) })),
    sessions: [["self-page", "self"], ["self-helper", "self"], ["chat-page", "chat"], ["route-peer", "route"]]
      .map(([id, userId]) => ({ id, userId, online: true, signingKey: Array(32).fill(0) })),
    publications: [{ id: "screen", roomId: "room", sessionId: "self-helper", userId: "self", kind: "screen", paused: false,
      source: { kind: "screen", name: null }, title: null, audience: [{ sessionId: "self-page", state: "active" }],
      videoSettings: { ceiling: { resolution: { width: 1280, height: 720 }, maxFramerate: 30, maxBitrate: 4_000_000 }, degradationPreference: "balanced" },
    }], voice: [{ roomId: "room", sessionId: "self-page", muted: true, deafened: true }],
    subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  });
  expect(roomPeople(state, "room").map(person => person.userId)).toEqual(["self", "chat"]);
  expect(roomRealtimePeople(state, "room").map(({ id, voice, sharing, viewing }) => ({ id, voice, sharing, viewing }))).toEqual([
    { id: "self", voice: { microphone: false, deafened: true }, sharing: true, viewing: "active" },
    { id: "route", voice: undefined, sharing: false, viewing: undefined },
  ]);
  state.publications[0].audience[0].state = "preparing";
  expect(roomRealtimePeople(state, "room").find(person => person.id === "self")?.viewing).toBe("preparing");
  const picture = state.publications.find(publication => publication.kind === "screen")!;
  picture.audience.push({ sessionId: "self-helper", state: "active" });
  expect(roomRealtimePeople(state, "room").find(person => person.id === "self")?.viewing).toBe("active");
  picture.audience.pop();
  state.publications[0].audience[0].state = "failed";
  expect(roomRealtimePeople(state, "room").find(person => person.id === "self")?.viewing).toBe("failed");
  state.publications[0].audience[0].state = "active";
  const channel = { state, profiles: new Map(), streams: new Map(), voicePlaybackByUser: new Map(), sessionId: "self-page", self: null } as unknown as ChannelController;
  const render = () => renderToStaticMarkup(createElement(ChannelRoomParticipants, { channel, room: state.channel.rooms[0] }));
  const renderPeople = () => renderToStaticMarkup(createElement(ChannelPeople, { channel, roomId: "room", active: true, onBack() {} }));
  state.sessions.find(session => session.id === "self-helper")!.online = false;
  state.sessions.find(session => session.id === "route-peer")!.online = false;
  expect(render()).toContain('class="c3-user" data-user-id="self"');
  expect(renderPeople()).toContain('class="c3-user" data-user-id="self"');
  expect(render()).toContain('class="c3-user is-offline" data-user-id="route"');
  expect(renderPeople()).toContain('class="c3-user is-offline" data-user-id="route"');
  state.sessions.find(session => session.id === "self-page")!.online = false;
  expect(render()).toContain('class="c3-user is-offline" data-user-id="self"');
  expect(renderPeople()).toContain('class="c3-user is-offline" data-user-id="self"');
  expect(roomRealtimePeople(state, "room").map(user => user.id)).toEqual(["self", "route"]);
});
