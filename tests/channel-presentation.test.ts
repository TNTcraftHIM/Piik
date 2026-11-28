import { PRODUCT_VERSION } from "../src/client/channel/product-version";
import { memberName } from "../src/client/channel/member-name";
import { historyProfileIds } from "../src/client/channel/message-history";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelRoomListItem } from "../src/client/channel/components/ChannelRoomListItem";
import { ChannelPeople } from "../src/client/channel/components/ChannelPeople";
import { ChannelActivityIndicators } from "../src/client/channel/components/ChannelUser";
import type { ChannelController } from "../src/client/channel/types";
import { firstUnreadMessageId, messageDateFormats, roomActivityPeople, roomPeople, roomSessionViewing, screenTitle, watchAudience } from "../src/client/channel/presentation";
import { messageSchema, snapshotSchema, watchActivitySchema } from "../src/client/channel/protocol";
import { say, t, type CopyKey } from "../src/client/ui/copy";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { AppPageMedia, type WatchMedia } from "../src/client/channel/watch-media";

const english = (key: CopyKey) => t("en", key);
const chinese = (key: CopyKey) => t("zh", key);

it("adds the date to a message timestamp across local midnight", () => {
  const message = new Date(2026, 10, 20, 23, 59);
  const formats = messageDateFormats("en-US", new Intl.DateTimeFormat().resolvedOptions().timeZone);
  const sameDay = formats.clock(message, new Date(2026, 10, 20, 23, 59));
  const nextDay = formats.clock(message, new Date(2026, 10, 21));
  expect(sameDay).not.toContain("Nov");
  expect(nextDay).toContain("Nov 20");
  expect(formats.clock(message, new Date(2027, 0, 1))).toContain("2026");
});

it("projects joined watch people independently of transport and deduplicates their endpoints", async () => {
  const sessions = [["owner-page", "owner"], ["owner-app", "owner"], ["viewer-web", "viewer"], ["viewer-app", "viewer"], ["direct-web", "direct"], ["relay-endpoint", "relay"]];
  const activity = watchActivitySchema.parse({ id: "watch", roomId: "room", sessionId: "owner-page", userId: "owner",
    source: { kind: "website", url: "https://video.test/watch" }, playback: { timeline: "media" as const, position: 0, paused: true, rate: 1, anchorTime: 0 },
    viewerSessionIds: ["owner-app", "viewer-web", "viewer-app", "direct-web", "retired"] });
  const state = snapshotSchema.parse({ channel: { id: "site", name: "Site", icon: "couch", ownerId: "owner", roomCreationPolicy: "ordinary", askUnnamedMemberName: false, hostingMode: "lightweight", historyWindow: 1000, userCount: 4, managedRoomIds: [], rooms: [{
    id: "room", name: "Room", icon: "couch", creatorId: "owner", access: "public", hidden: false, hasPassword: false,
    authorized: true, canManage: true, available: true, reading: true, participantSessionIds: sessions.map(([id]) => id),
    lastMessageSeq: 0, fileActivity: [], capabilities: { attachments: true },
  }] }, users: ["owner", "viewer", "direct", "relay"].map(id => ({ id, name: id, version: "a".repeat(64) })),
    sessions: sessions.map(([id, userId]) => ({ id, userId, online: true, signingKey: Array(32).fill(0), ...PRODUCT_VERSION })),
    publications: [], voice: [], subscriptions: [], watchActivities: [activity], watchSubscriptions: [], watchBytes: [], files: [], pairs: [], iceServers: [],
  });
  expect(watchAudience(state, activity)).toEqual([{ userId: "viewer", name: "viewer", avatar: undefined }, { userId: "direct", name: "direct", avatar: undefined }]);
  expect(roomActivityPeople(state, "room").map(({ id, sharing, viewing }) => ({ id, sharing, viewing }))).toEqual([
    { id: "owner", sharing: true, viewing: "joined" }, { id: "viewer", sharing: false, viewing: "joined" },
    { id: "direct", sharing: false, viewing: "joined" },
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
  const viewing = (userId: string) => roomActivityPeople(state, "room", undefined, local).find(person => person.id === userId)?.viewing;
  const localViewing = () => roomSessionViewing([], state.watchActivities, [], local);
  try {
    player.blockedReason = "autoplay";
    expect(viewing("viewer")).toBe("joined");
    expect(localViewing()).toBe("joined");
    player.blockedReason = null;
    expect(viewing("viewer")).toBe("preparing"); // Metadata is not a composited frame.
    expect(localViewing()).toBe("preparing");
    player.presentFrame();
    expect(viewing("viewer")).toBe("active");
    expect(localViewing()).toBe("active");
    player.blockedReason = "local-seek";
    expect(viewing("viewer")).toBe("joined");
    expect(localViewing()).toBe("joined");
    player.blockedReason = null;
    observedVideo.readyState = 1;
    expect(viewing("viewer")).toBe("preparing");
    expect(localViewing()).toBe("preparing");
    observedVideo.readyState = 4;
    expect(localViewing()).toBe("active");
    expect(viewing("direct")).toBe("joined");
    state.watchActivities[0].viewerSessionIds = ["viewer-app"];
    expect(viewing("viewer")).toBe("joined"); // Same identity, different endpoint.
    expect(localViewing()).toBeUndefined();
    state.watchActivities[0].viewerSessionIds = ["viewer-web"];
    player.blockedReason = "autoplay";
    player.error = "watch_media_failed";
    expect(viewing("viewer")).toBe("failed");
    expect(localViewing()).toBe("failed");
  } finally { player.close(); }
  let sample = { position: 0, paused: true, rate: 1, duration: 10, readyState: 1, ended: false, buffered: null };
  const page = new AppPageMedia({ id: "native-page", selectedCandidateId: "native-video", read: async () => sample,
    patch: async () => {}, listen: () => () => {}, focus: async () => {}, close() {} });
  const originalPlayer = new WatchPlayer("room", false, page, () => {});
  local.watchPlayers.set("watch", originalPlayer);
  state.watchActivities[0].viewerSessionIds = ["viewer-web", "direct-web"];
  try {
    originalPlayer.calibrate(0, performance.now());
    originalPlayer.update(activity.playback);
    await originalPlayer.sample();
    expect(viewing("viewer")).toBe("preparing");
    expect(localViewing()).toBe("preparing");
    sample = { ...sample, readyState: 4 };
    await originalPlayer.sample();
    expect(viewing("viewer")).toBe("active");
    expect(localViewing()).toBe("active");
    expect(viewing("direct")).toBe("joined");
    sample = { ...sample, readyState: 2, ended: true };
    await originalPlayer.sample();
    expect(viewing("viewer")).toBe("active");
    expect(localViewing()).toBe("active");
  } finally { originalPlayer.close(); }

});

it("labels a person's picture by its current delivery stage", () => {
  for (const [viewing, label] of [["preparing", "screen.connectingPicture"], ["active", "screen.pictureReceived"], ["failed", "screen.pictureFailed"]] as const) {
    const html = renderToStaticMarkup(createElement(ChannelActivityIndicators, { viewing }));
    expect(html).toContain(`<button type="button" class="c3-participant-status" aria-label="${say(label)}"`);
    expect(html).toContain(`data-viewing="${viewing}"`);
  }
});

it("starts unread messages at another person without consuming earlier unread history", () => {
  const own = { id: "own", seq: 1, userId: "self" };
  const other = { id: "other", seq: 2, userId: "friend" };
  expect(firstUnreadMessageId([other], 0, "self", true)).toBeUndefined();
  expect(firstUnreadMessageId([other], 1, "self", true)).toBe("other");
  expect(firstUnreadMessageId([other], 0, "self", false)).toBe("other");
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
    const source = { kind: "future-Capture_42", name: null };
    expect(screenTitle({ source, title: null }, english)).toBe("Shared screen");
    expect(screenTitle({ source, title: null }, chinese)).toBe("分享画面");
    expect(screenTitle({ source: { ...source, name: "Studio feed" }, title: null }, english)).toBe("Studio feed");
    expect(screenTitle({ source: { ...source, name: "Studio feed" }, title: "Concert" }, english)).toBe("Concert");
    expect(screenTitle({ source: { kind: "screen", name: "<窗口>" }, title: "<Movie>" }, english)).toBe("<Movie>");
  });
});

it("shows each person's room activity across endpoints and keeps chat presence independent", () => {
  const state = snapshotSchema.parse({
    channel: { id: "site", name: "Site", icon: "couch", ownerId: "self", roomCreationPolicy: "ordinary", askUnnamedMemberName: false, hostingMode: "lightweight", historyWindow: 1000, userCount: 3, managedRoomIds: [], rooms: [{
      id: "room", name: "Room", icon: "couch", creatorId: "self", access: "public", hidden: false,
      hasPassword: false, authorized: true, canManage: true, available: true, reading: true,
      participantSessionIds: ["self-page", "self-helper", "chat-page"], lastMessageSeq: 0,
      fileActivity: [{ sessionId: "self-helper", sending: true, receiving: false }, { sessionId: "route-peer", sending: false, receiving: true }],
      capabilities: { attachments: true },
    }] }, users: ["self", "chat", "route"].map(id => ({ id, name: id, version: "a".repeat(64) })),
    sessions: [["self-page", "self"], ["self-helper", "self"], ["chat-page", "chat"], ["route-peer", "route"]]
      .map(([id, userId]) => ({ id, userId, online: true, signingKey: Array(32).fill(0), ...PRODUCT_VERSION })),
    publications: [{ id: "screen", roomId: "room", sessionId: "self-helper", userId: "self", kind: "screen", paused: false,
      source: { kind: "screen", name: null }, title: null, audience: [{ sessionId: "self-page", state: "active" }],
      videoSettings: { ceiling: { resolution: { width: 1280, height: 720 }, maxFramerate: 30, maxBitrate: 4_000_000 }, degradationPreference: "balanced" },
    }], voice: [{ roomId: "room", sessionId: "self-page", muted: true, deafened: true }],
    subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [], files: [], pairs: [], iceServers: [],
  });
  expect(roomPeople(state, "room").map(person => person.userId)).toEqual(["self", "chat"]);
  const activities = () => roomActivityPeople(state, "room");
  expect(activities().map(({ id, voice, sharing, viewing, sendingFiles, receivingFiles }) => ({ id, voice, sharing, viewing, sendingFiles, receivingFiles }))).toEqual([
    { id: "self", voice: { microphone: false, deafened: true }, sharing: true, viewing: "active", sendingFiles: true, receivingFiles: false },
    { id: "route", voice: undefined, sharing: false, viewing: undefined, sendingFiles: false, receivingFiles: true },
  ]);
  state.publications[0].audience[0].state = "preparing";
  expect(activities().find(person => person.id === "self")?.viewing).toBe("preparing");
  const picture = state.publications.find(publication => publication.kind === "screen")!;
  picture.audience.push({ sessionId: "self-helper", state: "active" });
  expect(activities().find(person => person.id === "self")?.viewing).toBe("active");
  picture.audience.pop();
  state.publications[0].audience[0].state = "failed";
  expect(activities().find(person => person.id === "self")?.viewing).toBe("failed");
  state.publications[0].audience[0].state = "active";
  const room = state.channel.rooms[0];
  const streams = new Map<string, MediaStream>();
  const channel = { state, profiles: new Map(), streams, voicePlaybackByUser: new Map(), sessionId: "self-page", self: state.users[0],
    ownedScreens: new Set(), readByRoom: { room: 0 }, watchPlayers: new Map() } as unknown as ChannelController;
  const render = () => renderToStaticMarkup(createElement(ChannelRoomListItem, { channel, room, selected: true, settingsOpen: false, onSelect() {}, onManage() {} }));
  const renderPeople = () => renderToStaticMarkup(createElement(ChannelPeople, { channel, roomId: "room", active: true, onBack() {} }));
  expect(render()).toContain(say("room.item.showParticipants", { count: "2" }));
  const rows = renderPeople().split('data-user-id="');
  const owner = rows.find(row => row.startsWith('self"'));
  const member = rows.find(row => row.startsWith('route"'));
  expect(owner).toContain('<small>' + say("channel.user.roomOwner") + '</small>');
  expect(owner?.match(/<button[^>]*class="c3-participant-status"/g)).toHaveLength(1);
  const ownerStatus = owner?.match(/class="c3-participant-status" aria-label="([^"]+)"/)?.[1];
  for (const key of ["voice.microphoneInactive", "voice.listeningPaused", "channel.roomParticipants.sharing", "screen.pictureReceived", "channel.roomParticipants.sendingFiles"] as const) {
    expect(ownerStatus).toContain(say(key));
  }
  expect(member).not.toContain(say("channel.user.roomOwner"));
  expect(member).toContain(say("channel.roomParticipants.receivingFiles"));
  const navigationDescriptions = () => {
    const html = render();
    const ids = html.match(/<button[^>]*aria-label="Room"[^>]*aria-describedby="([^"]+)"/)?.[1];
    return (ids?.split(/\s+/) ?? []).map(id => html.match(new RegExp('id="' + id + '"[^>]*>([^<]+)<'))?.[1]);
  };
  const voiceJoined = say("channel.joinVoice.voiceJoined");
  expect(navigationDescriptions()).toEqual([`${voiceJoined}、${say("screen.sharedScreens")} 1`]);
  state.subscriptions.push("screen");
  picture.audience.push({ sessionId: "self-helper", state: "active" });
  room.lastMessageSeq = 1;
  for (const [status, label] of [["preparing", "screen.connectingPicture"], ["active", "screen.pictureReceived"], ["failed", "screen.pictureFailed"]] as const) {
    picture.audience[0].state = status;
    expect(navigationDescriptions()).toEqual([say("room.item.unread"), `${voiceJoined}、${say(label)}`]);
  }
  room.lastMessageSeq = 0;
  picture.audience.pop();
  state.subscriptions.pop();
  picture.audience[0].state = "active";
  state.sessions.find(session => session.id === "self-helper")!.online = false;
  state.sessions.find(session => session.id === "route-peer")!.online = false;
  expect(renderPeople()).toContain('class="c3-user" data-user-id="self"');
  expect(renderPeople()).toContain('class="c3-user is-offline" data-user-id="route"');
  expect(roomPeople(state, room.id).map(({ userId, online }) => [userId, online])).toEqual([["self", true], ["chat", true]]);
  state.sessions.find(session => session.id === "self-page")!.online = false;
  expect(renderPeople()).toContain('class="c3-user is-offline" data-user-id="self"');
  expect(roomPeople(state, room.id).map(({ userId, online }) => [userId, online])).toEqual([["self", false], ["chat", true]]);
  room.fileActivity = [];
  expect(activities().map(user => user.id)).toEqual(["self"]);
  expect(render()).toContain(say("room.item.showParticipants", { count: "2" }));
  expect(renderPeople()).toContain('data-user-id="route"');
  expect(roomPeople(state, room.id).map(user => user.userId)).toEqual(["self", "chat"]);
  // A disconnected chat reader has no live media to keep them in the room.
  state.sessions.find(session => session.id === "chat-page")!.online = false;
  expect(roomPeople(state, room.id).map(user => user.userId)).toEqual(["self"]);
  state.sessions.find(session => session.id === "chat-page")!.online = true;

  state.voice[0].deafened = false;
  state.voice.push({ roomId: room.id, sessionId: "route-peer", muted: false, deafened: false });
  state.publications.push({ roomId: room.id, sessionId: "route-peer", userId: "route", id: "voice", kind: "voice", paused: false, audience: [] });
  state.subscriptions.push("voice");
  streams.set("voice", {} as MediaStream);
  const listenLabel = say("voice.listenPerson");
  expect(renderPeople()).toContain(`aria-label="${listenLabel}"`);
  streams.clear();
  expect(renderPeople()).not.toContain(`aria-label="${listenLabel}"`);
  state.publications = [];
  state.voice = [];
  expect(roomPeople(state, room.id).map(user => user.userId)).toEqual(["chat"]);
});

it("distinguishes unnamed members, chosen names and missing profiles", () => {
  const first = "d1291eea-8073-41ff-90fa-81a7c50f0cf4", second = "04b8f197-b6c6-44a2-aa18-8ec594ea32d1";
  expect(memberName(first, "")).toMatch(/ #[2-9A-HJ-NP-Z]{4}$/);
  expect(memberName(first, "")).not.toBe(memberName(second, ""));
  expect(memberName(first, "Guest")).toBe("Guest");
  expect(memberName(first, undefined)).toBe(say("conversation.user"));
  const row = messageSchema.parse({ id: "copy", seq: 2, time: 10, text: "reply", attachments: [], userId: first, archivedAuthorName: "",
    reply: { seq: 1, userId: second, text: "original", archivedAuthorName: "", notify: false } });
  expect(historyProfileIds([row])).toEqual([]);
});
