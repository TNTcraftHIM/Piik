import { afterEach, expect, test, vi } from "vitest";
import { CHAT_OVERLAY_DURATION_MS, RoomInteractionSession, type RoomInteraction } from "../src/client/lib/room-interactions";
import { normalizeChatText } from "../src/shared/room-interactions";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  vi.useFakeTimers();
  const send = vi.fn(() => true);
  const session = new RoomInteractionSession(send);
  session.authenticated("self_peer_1234");
  expect(send).toHaveBeenLastCalledWith({ type: "subscribe-room-interactions" });
  return { session, send };
}
const message = (id: string): RoomInteraction => ({ type: "room-interaction", id, requestId: "request_1234", occurredAt: Date.now(),
  sender: { peerId: "other_peer_1234", role: "viewer", displayName: "朋友" }, payload: { kind: "chat", text: "Hello" } });

test("data needs explicit readiness, waits for server echo, and has no offline replay", () => {
  // LAN HTTP viewing does not expose secure-context-only crypto.randomUUID.
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const { session, send } = setup();
  expect(session.send({ kind: "chat", text: "Hi" })).toBe(false);
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  expect(session.send({ kind: "chat", text: "Hi" })).toBe(true);
  expect(session.getSnapshot().messages).toHaveLength(0);
  const pending = session.getSnapshot().pending!;
  expect(session.send({ kind: "reaction", reaction: "poop" })).toBe(false);
  session.receive({ ...message("event_1234"), requestId: pending.requestId,
    sender: { peerId: "self_peer_1234", role: "host", displayName: "Host" }, payload: pending.payload });
  expect(session.getSnapshot().pending).toBeNull();
  expect(session.getSnapshot().confirmed?.payload).toEqual({ kind: "chat", text: "Hi" });
  vi.advanceTimersByTime(800);
  expect(session.send({ kind: "reaction", reaction: "tomato", targetPeerId: "other_peer_1234" })).toBe(true);
  session.disconnected();
  expect(session.getSnapshot()).toMatchObject({ ready: false, pending: null, error: "unconfirmed", reactions: [] });
  const count = send.mock.calls.length;
  session.authenticated("self_peer_1234");
  expect(send.mock.calls.slice(count)).toEqual([[{ type: "subscribe-room-interactions" }]]);
  expect(session.getSnapshot().messages).toHaveLength(1);
  expect(session.getSnapshot().error).toBe("unconfirmed");
  session.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("history and animations are bounded, deduplicated and retired with the room", () => {
  const { session } = setup();
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  for (let i = 0; i < 100; i++) session.receive(message(`event_${i}`));
  session.receive(message("event_99"));
  expect(session.getSnapshot().messages).toHaveLength(80);
  expect(session.getSnapshot().messages[0].id).toBe("event_20");
  for (let i = 0; i < 21; i++) session.receive({ ...message(`reaction_${i}`), payload: { kind: "reaction", reaction: "clap" } });
  expect(session.getSnapshot().reactions).toHaveLength(8);
  vi.advanceTimersByTime(2400);
  expect(session.getSnapshot().reactions).toHaveLength(0);
  session.authenticated("different_peer_1234");
  expect(session.getSnapshot().messages).toHaveLength(80);
  session.close();
  expect(session.getSnapshot().messages).toHaveLength(0);
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  expect(session.getSnapshot().ready).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("rejection and timeout leave delivery unconfirmed without automatic retries", () => {
  const { session, send } = setup();
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  session.send({ kind: "chat", text: "Try me" });
  session.receive({ type: "room-interaction-rejected", requestId: session.getSnapshot().pending!.requestId, reason: "rate-limited" });
  expect(session.getSnapshot()).toMatchObject({ error: "rate-limited", pending: null, confirmed: null });
  vi.advanceTimersByTime(800);
  session.send({ kind: "chat", text: "Try me" });
  const count = send.mock.calls.length;
  vi.advanceTimersByTime(6000);
  expect(session.getSnapshot()).toMatchObject({ error: "unconfirmed", pending: null, confirmed: null });
  expect(send).toHaveBeenCalledTimes(count);
  session.close();
});

test("plain text permits emoji and markup as text, while rejecting control characters and oversized input", () => {
  expect(normalizeChatText("  hello 👋 <b>world</b> ")).toBe("hello 👋 <b>world</b>");
  expect(normalizeChatText("Cafe\u0301")).toBe("Café");
  expect(normalizeChatText("👋".repeat(280))).not.toBeNull();
  for (const text of [" ", "x\nname", "fake\u202ehost", "x\ud800", "你".repeat(281)]) expect(normalizeChatText(text)).toBeNull();
});

test("same-room re-admission retains bounded history and its original self attribution", () => {
  const { session, send } = setup();
  const key = session.key;
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  session.send({ kind: "chat", text: "before reconnect" });
  const pending = session.getSnapshot().pending!;
  session.receive({ ...message("self_event_1234"), requestId: pending.requestId,
    sender: { peerId: "self_peer_1234", role: "viewer", displayName: "Me" }, payload: pending.payload });
  session.receive(message("other_event_1234"));
  session.disconnected();
  const sendCount = send.mock.calls.length;
  session.authenticated("new_self_peer_1234");
  expect(session.key).toBe(key);
  expect(session.getSnapshot().messages.map(item => item.isSelf)).toEqual([true, false]);
  expect(session.getSnapshot()).toMatchObject({ confirmed: null, pending: null, ready: false });
  expect(send.mock.calls.slice(sendCount)).toEqual([[{ type: "subscribe-room-interactions" }]]);
  session.close();
  const replacement = new RoomInteractionSession(send);
  expect(replacement.key).not.toBe(key);
  expect(replacement.getSnapshot().messages).toEqual([]);
  replacement.close();
});

test("late echoes do not confirm a newer same-text request or erase its rejection", () => {
  const { session } = setup();
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  const payload = { kind: "chat", text: "same text" } as const;
  session.send(payload);
  const first = session.getSnapshot().pending!;
  vi.advanceTimersByTime(5_000);
  session.send(payload);
  const next = session.getSnapshot().pending!;
  const echo = { ...message("late_event_1234"), requestId: first.requestId, payload,
    sender: { peerId: "self_peer_1234", role: "viewer" as const, displayName: "Me" } };
  session.receive(echo);
  expect(session.getSnapshot().confirmed).toBeNull();
  expect(session.getSnapshot().pending?.requestId).toBe(next.requestId);
  session.receive({ type: "room-interaction-rejected", requestId: next.requestId, reason: "busy" });
  session.receive({ ...echo, id: "late_event_5678" });
  expect(session.getSnapshot()).toMatchObject({ confirmed: null, error: "busy" });
  expect(session.getSnapshot().messages).toHaveLength(2);
  session.close();
});

test("chat overlay keeps the newest message on each fixed lane, with no playback queue", () => {
  const { session } = setup();
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  session.setOverlayVisible(true);
  session.receive(message("before_enabled"));
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  session.setOverlayEnabled(true);
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  session.send({ kind: "chat", text: "not confirmed" });
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  session.receive(message("flight_1"));
  vi.advanceTimersByTime(1000);
  session.receive(message("flight_2"));
  session.receive(message("flight_3"));
  session.receive(message("overflow"));
  const flights = session.getSnapshot().overlayMessages;
  expect(flights.map(item => [item.id, item.lane])).toEqual([["flight_3", 2], ["overflow", 0]]);
  expect(session.getSnapshot().messages.at(-1)?.id).toBe("overflow");
  session.receive(message("flight_1"));
  expect(session.getSnapshot().overlayMessages).toBe(flights);
  vi.advanceTimersByTime(CHAT_OVERLAY_DURATION_MS - 1000);
  expect(session.getSnapshot().overlayMessages.map(item => item.id)).toEqual(["flight_3", "overflow"]);
  session.receive(message("flight_4"));
  expect(session.getSnapshot().overlayMessages.at(-1)?.id).toBe("flight_4");
  expect(new Set(session.getSnapshot().overlayMessages.map(item => item.lane)).size).toBe(session.getSnapshot().overlayMessages.length);
  vi.advanceTimersByTime(CHAT_OVERLAY_DURATION_MS);
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  expect(session.getSnapshot().messages).toHaveLength(6);
  session.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("clock offsets, delivery delay and missing events do not shift a common effect's lane or expiry", () => {
  vi.useFakeTimers();
  const first = new RoomInteractionSession(() => true, () => Date.now() + 3_600_000);
  const second = new RoomInteractionSession(() => true, () => Date.now() - 720_000);
  for (const session of [first, second]) {
    session.authenticated("self_peer_1234");
    session.setOverlayEnabled(true);
    session.setOverlayVisible(true);
  }
  // Symmetric 20ms / 200ms subscription round trips to the same server clock.
  vi.advanceTimersByTime(20);
  first.receive({ type: "room-interactions-ready", serverTime: 1_000_010 });
  vi.advanceTimersByTime(180);
  second.receive({ type: "room-interactions-ready", serverTime: 1_000_100 });
  first.receive({ ...message("only_first_saw_this"), occurredAt: 1_000_200 });
  const common = { ...message("flight_3"), occurredAt: 1_000_200 };
  first.receive(common);
  const reaction = { ...common, id: "common_reaction", payload: { kind: "reaction", reaction: "clap" } } as const;
  first.receive(reaction);
  vi.advanceTimersByTime(900);
  second.receive(common);
  second.receive(reaction);
  const a = first.getSnapshot().overlayMessages.find(item => item.id === common.id)!;
  const b = second.getSnapshot().overlayMessages[0];
  expect(a.lane).toBe(b.lane);
  expect(a.expiresAt - first.now()).toBe(5100);
  expect(b.expiresAt - second.now()).toBe(5100);
  expect(first.getSnapshot().reactions[0].expiresAt - first.now()).toBe(1500);
  expect(second.getSnapshot().reactions[0].expiresAt - second.now()).toBe(1500);
  vi.advanceTimersByTime(5100);
  for (const session of [first, second]) {
    expect(session.getSnapshot().overlayMessages).toEqual([]);
    expect(session.getSnapshot().reactions).toEqual([]);
    session.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});

test("expired events still confirm chat, but never replay effects; reconnect replaces the time anchor", () => {
  const { session } = setup();
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  session.setOverlayEnabled(true);
  session.setOverlayVisible(true);
  const occurredAt = Date.now() - 7000;
  session.send({ kind: "chat", text: "Delayed confirmation" });
  const pending = session.getSnapshot().pending!;
  session.receive({ ...message("expired_chat"), occurredAt, requestId: pending.requestId, payload: pending.payload,
    sender: { peerId: "self_peer_1234", role: "viewer", displayName: "Me" } });
  session.receive({ ...message("expired_reaction"), occurredAt, payload: { kind: "reaction", reaction: "clap" } });
  expect(session.getSnapshot()).toMatchObject({ pending: null, confirmed: { id: "expired_chat" }, overlayMessages: [], reactions: [] });
  expect(session.getSnapshot().messages).toHaveLength(1);
  session.authenticated("new_self_peer_1234");
  session.receive({ type: "room-interactions-ready", serverTime: 2_000_000 });
  // Duplicate ready messages must not move active effects to a new clock.
  session.receive({ type: "room-interactions-ready", serverTime: 8_000_000 });
  session.receive({ ...message("after_new_anchor"), occurredAt: 2_000_000 });
  expect(session.getSnapshot().overlayMessages[0].expiresAt - session.now()).toBe(CHAT_OVERLAY_DURATION_MS);
  session.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("asymmetric subscription delay stays approximate and cannot extend a fresh effect", () => {
  const { session } = setup();
  session.setOverlayEnabled(true);
  session.setOverlayVisible(true);
  // 190ms outbound and 10ms inbound: midpoint overestimates server time by 90ms.
  vi.advanceTimersByTime(200);
  session.receive({ type: "room-interactions-ready", serverTime: 1_000_190 });
  session.receive({ ...message("asymmetric_flight"), occurredAt: 1_000_200 });
  expect(session.getSnapshot().overlayMessages[0].expiresAt - session.now()).toBe(CHAT_OVERLAY_DURATION_MS - 90);
  session.authenticated("readmitted_peer_1234");
  // Reversing the path delay underestimates time; cap lifetime at six seconds.
  vi.advanceTimersByTime(200);
  session.receive({ type: "room-interactions-ready", serverTime: 2_000_010 });
  session.receive({ ...message("ahead_of_estimate"), occurredAt: 2_000_200 });
  expect(session.getSnapshot().overlayMessages[0].expiresAt - session.now()).toBe(CHAT_OVERLAY_DURATION_MS);
  session.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("hidden, disabled and reconnecting overlays discard flights without replaying room history", () => {
  const { session } = setup();
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  session.setOverlayEnabled(true);
  session.receive(message("no_picture"));
  session.setOverlayVisible(true);
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  session.receive(message("visible"));
  expect(session.getSnapshot().overlayMessages).toHaveLength(1);
  session.setOverlayVisible(false);
  session.receive(message("background"));
  session.setOverlayVisible(true);
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  session.receive(message("visible_again"));
  session.setOverlayEnabled(false);
  session.setOverlayEnabled(true);
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  session.receive(message("before_disconnect"));
  session.disconnected();
  expect(session.getSnapshot().overlayMessages).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  session.receive(message("stale_event"));
  session.authenticated("readmitted_peer_1234");
  session.receive({ type: "room-interactions-ready", serverTime: Date.now() });
  expect(session.getSnapshot()).toMatchObject({ overlayEnabled: true, overlayMessages: [] });
  expect(session.getSnapshot().messages).toHaveLength(5);
  session.receive(message("after_reconnect"));
  expect(session.getSnapshot().overlayMessages.map(item => item.id)).toEqual(["after_reconnect"]);
  session.close();
  expect(session.getSnapshot()).toMatchObject({ overlayEnabled: false, overlayMessages: [], messages: [] });
  expect(vi.getTimerCount()).toBe(0);
});
