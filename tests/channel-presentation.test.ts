import { describe, expect, it } from "vitest";
import { firstUnreadMessageId, roomPeople, roomRealtimePeople, screenTitle } from "../src/client/channel/presentation";
import { snapshotSchema } from "../src/client/channel/protocol";

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
    expect(screenTitle(publication, "en")).toBe("First window");
    publication.title = "Movie night";
    publication.source.name = "Second window";
    expect(screenTitle(publication, "en")).toBe("Movie night");
    publication.title = null;
    expect(screenTitle(publication, "en")).toBe("Second window");
  });

  it("localizes only missing source names and preserves literal human titles", () => {
    expect(screenTitle({ source: { kind: "screen", name: null }, title: null }, "zh")).toBe("分享画面");
    expect(screenTitle({ source: { kind: "screen", name: null }, title: null }, "en")).toBe("Shared screen");
    expect(screenTitle({ source: { kind: "camera", name: null }, title: null }, "zh")).toBe("摄像头");
    expect(screenTitle({ source: { kind: "camera", name: null }, title: null }, "en")).toBe("Camera");
    expect(screenTitle({ source: { kind: "screen", name: "<窗口>" }, title: "<Movie>" }, "en")).toBe("<Movie>");
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
    subscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  });
  expect(roomPeople(state, "room").map(person => person.userId)).toEqual(["self", "chat"]);
  expect(roomRealtimePeople(state, "room").map(({ id, voice, sharing, watching }) => ({ id, voice, sharing, watching }))).toEqual([
    { id: "self", voice: { microphone: false, deafened: true }, sharing: true, watching: true },
    { id: "route", voice: undefined, sharing: false, watching: false },
  ]);
});
