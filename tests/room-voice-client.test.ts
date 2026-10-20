import { afterEach, expect, it, vi } from "vitest";
import { RoomVoiceSession } from "../src/client/room-voice/session";
import { clientMessageSchema, type ClientMessage, type RoomVoiceState } from "../src/shared/protocol";

afterEach(() => vi.unstubAllGlobals());

function microphone() {
  const track = { readyState: "live", contentHint: "", onended: null as null | (() => void),
    stop: vi.fn(() => { track.readyState = "ended"; }) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}
function room(revision: number, speak = true, publication = false): RoomVoiceState {
  return { type: "room-voice-state", revision, hostPeerId: "host",
    members: [{ peerId: "self", connected: true, requested: true, listen: true, speak,
      ...(publication ? { publicationId: "publication" } : {}) }],
    publications: publication ? [{ id: "publication", peerId: "self" }] : [], connections: [], unavailable: [] };
}
function setup() {
  const messages: ClientMessage[] = [];
  const session = new RoomVoiceSession(message => { messages.push(message); return true; }, { iceServers: [] });
  session.authenticated("self", "viewer"); session.receive(room(1));
  return { session, messages };
}

it("clears a transport failure after the server commits its repaired voice route", () => {
  const { session } = setup();
  vi.spyOn(session.endpoint, "reconcile").mockResolvedValue();
  const pending = { ...room(2), connections: [{ connectionId: "repair_connection_123", parentPeerId: "host", childPeerId: "self",
    transport: "peer" as const, pending: true, revision: 2, send: [], receive: [] }] };
  session.receive({ type: "room-voice-error", code: "connection-unavailable" });
  session.receive(pending);
  expect(session.getSnapshot().error).toBe("transport");
  session.receive({ ...pending, revision: 3, connections: [{ ...pending.connections[0]!, pending: false }] });
  expect(session.getSnapshot().error).toBeNull();
  session.close();
});

it("captures only on explicit action and waits for the server publication acknowledgement", async () => {
  const mic = microphone(), getUserMedia = vi.fn(async () => mic.stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const { session, messages } = setup();
  try {
    expect(getUserMedia).not.toHaveBeenCalled();
    await session.startMicrophone();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true, channelCount: 1 }), video: false });
    expect(session.getSnapshot()).toMatchObject({ microphone: false, capturePending: true });
    expect(messages).toContainEqual({ type: "room-voice-command", command: { action: "publish" } });
    session.receive(room(2, true, true));
    expect(session.getSnapshot()).toMatchObject({ microphone: true, capturePending: false });
    expect(mic.track.stop).not.toHaveBeenCalled();
    // Source sharing has no call into this owner. An ordinary authority update
    // with the same publication must retain the actual microphone stream.
    session.receive(room(3, true, true));
    expect(session.microphone).toBe(true);
    mic.track.onended?.();
    expect(session.microphone).toBe(false);
    expect(messages.at(-1)).toEqual({ type: "room-voice-command", command: { action: "unpublish", publicationId: "publication" } });
    expect(messages.every(message => clientMessageSchema.safeParse(message).success)).toBe(true);
  } finally { session.close(); }
});

it.each(["cancel", "revoke", "disconnect", "close"] as const)("stops a late microphone result after %s without reviving authority", async action => {
  let finish!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { finish = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const { session, messages } = setup();
  const starting = session.startMicrophone();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  if (action === "cancel") session.stopMicrophone();
  if (action === "revoke") { session.receive(room(2, false)); session.receive(room(3, true)); }
  if (action === "disconnect") session.disconnected();
  if (action === "close") session.close();
  const mic = microphone(); finish(mic.stream); await starting;
  expect(mic.track.stop).toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({ microphone: false, capturePending: false });
  expect(messages.some(message => message.type === "room-voice-command" && message.command.action === "publish")).toBe(false);
  session.close();
});

it("retires an acknowledged publication after cancellation and never attaches it to a newer capture", async () => {
  const mic = microphone(), getUserMedia = vi.fn(async () => mic.stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const { session, messages } = setup();
  await session.startMicrophone(); session.stopMicrophone();
  await session.startMicrophone();
  expect(getUserMedia).toHaveBeenCalledOnce();
  session.receive(room(2, true, true));
  expect(session.microphone).toBe(false);
  expect(mic.track.stop).toHaveBeenCalled();
  expect(messages.at(-1)).toEqual({ type: "room-voice-command", command: { action: "unpublish", publicationId: "publication" } });
  expect(session.getSnapshot().capturePending).toBe(false);
  session.close();
});

it("stops admitted microphone capture synchronously when speaking permission is revoked", async () => {
  const mic = microphone();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => mic.stream } });
  const { session } = setup();
  await session.startMicrophone(); session.receive(room(2, true, true));
  session.receive(room(3, false));
  expect(mic.track.stop).toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({ microphone: false, capturePending: false });
  session.receive(room(4, true));
  expect(session.microphone).toBe(false);
  session.close();
});

it("does not capture before the existing Host microphone owner has yielded, and cancellation fences that wait", async () => {
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  let release!: () => void;
  const session = new RoomVoiceSession(() => true, { iceServers: [] }, () => new Promise<void>(resolve => { release = resolve; }));
  session.authenticated("self", "host"); session.receive(room(1));
  const starting = session.startMicrophone();
  expect(getUserMedia).not.toHaveBeenCalled();
  session.stopMicrophone(); release(); await starting;
  expect(getUserMedia).not.toHaveBeenCalled();
  session.close();
});

it("does not acquire or publish room audio when commentary release fails", async () => {
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const messages: ClientMessage[] = [];
  const session = new RoomVoiceSession(message => { messages.push(message); return true; }, { iceServers: [] },
    async () => { throw new Error("Native stop rejected"); });
  session.authenticated("self", "host"); session.receive(room(1));
  await session.startMicrophone();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(messages.some(message => message.type === "room-voice-command" && message.command.action === "publish")).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ microphone: false, capturePending: false, error: "microphoneFailed" });
  session.close();
});

it("preserves a valid microphone request and source when an unrelated room voice edge fails", async () => {
  let finish!: (stream: MediaStream) => void;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { finish = resolve; }) } });
  const { session } = setup();
  const starting = session.startMicrophone();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  session.receive({ type: "room-voice-error", code: "connection-unavailable" });
  const mic = microphone(); finish(mic.stream); await starting;
  session.receive(room(2, true, true));
  expect(session.microphone).toBe(true);
  session.receive({ type: "room-voice-error", code: "connection-unavailable" });
  expect(session.microphone).toBe(true);
  expect(mic.track.stop).not.toHaveBeenCalled();
  session.close();
});
