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
function room(revision: number, joined = true, publication = false, enabled = true): RoomVoiceState {
  return { type: "room-voice-state", revision, enabled, hostPeerId: "host",
    members: [{ peerId: "self", connected: true, joined, upstream: { kind: "none" },
      ...(publication ? { publicationId: "publication" } : {}) }],
    publications: publication ? [{ id: "publication", peerId: "self" }] : [], connections: [], unavailable: [] };
}
function setup(listeningPresence = false, bitrate = false) {
  const resume = vi.fn(async () => {});
  class Context {
    currentTime = 0;
    createGain() { return { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }; }
    createAnalyser() { return { fftSize: 256, getFloatTimeDomainData: vi.fn() }; }
    createMediaStreamSource() { return { connect: vi.fn() }; }
    createMediaStreamDestination() { return { stream: microphone().stream }; }
    resume = resume;
    close = async () => {};
  }
  vi.stubGlobal("AudioContext", Context);
  const messages: ClientMessage[] = [];
  const send = vi.fn((message: ClientMessage) => { messages.push(message); return true; });
  const session = new RoomVoiceSession(send, { iceServers: [] }, listeningPresence, bitrate);
  session.authenticated("self", "viewer"); session.receive(room(1));
  return { session, messages, resume, send };
}

it("reports listening only to supporting servers and restores it on subscription without muting the microphone", async () => {
  const mic = microphone();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => mic.stream) } });
  const { session, messages, send } = setup(true, true);
  await session.startMicrophone(); session.receive(room(2, true, true));
  messages.length = 0;
  session.receive({ type: "room-voice-error", code: "not-allowed" });
  session.deafen(true);
  expect(session.getSnapshot()).toMatchObject({ microphone: true, deafened: true, error: "rejected" });
  expect(mic.track.stop).not.toHaveBeenCalled();
  expect(messages).toEqual([{ type: "room-voice-command", command: { action: "deafen", deafened: true } }]);
  send.mockReturnValueOnce(false);
  session.deafen(false);
  expect(session.getSnapshot()).toMatchObject({ deafened: false, error: "rejected" });
  session.deafen(true);
  session.command({ action: "leave" });
  session.receive(room(3, false));
  expect(session.getSnapshot().deafened).toBe(true);
  session.disconnected();
  session.deafen(false); // Changes during disconnection stay local until resubscription.
  session.deafen(true);
  messages.length = 0;
  session.authenticated("self", "viewer"); session.subscribeRoom();
  expect(messages).toEqual([{ type: "subscribe-room-voice", deafened: true, bitrate: true }]);
  session.close();
  const legacy = setup();
  legacy.session.deafen(true); legacy.session.subscribeRoom();
  expect(legacy.messages).toEqual([{ type: "subscribe-room-voice" }]);
  legacy.session.close();
});

it("clears a transport failure after the committed voice transports actually connect", () => {
  const { session } = setup();
  vi.spyOn(session.endpoint, "reconcile").mockResolvedValue();
  let connected = false;
  vi.spyOn(session.endpoint, "connected", "get").mockImplementation(() => connected);
  const pending = { ...room(2), connections: [{ connectionId: "repair_connection_123", parentPeerId: "host", childPeerId: "self",
    transport: "peer" as const, pending: true, revision: 2, send: [], receive: [] }] };
  session.receive({ type: "room-voice-error", code: "connection-unavailable" });
  session.receive(pending);
  expect(session.getSnapshot().error).toBe("transport");
  session.receive({ ...pending, revision: 3, connections: [{ ...pending.connections[0]!, pending: false }] });
  expect(session.getSnapshot().error).toBe("transport");
  connected = true;
  session.receive({ ...pending, revision: 4, connections: [{ ...pending.connections[0]!, pending: false }] });
  expect(session.getSnapshot().error).toBeNull();
  session.close();
});

it("captures only on explicit action and waits for the server publication acknowledgement", async () => {
  const mic = microphone(), getUserMedia = vi.fn(async () => mic.stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const { session, messages, resume } = setup();
  try {
    expect(getUserMedia).not.toHaveBeenCalled();
    await session.startMicrophone();
    expect(resume.mock.invocationCallOrder[0]).toBeLessThan(getUserMedia.mock.invocationCallOrder[0]!);
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

it("explains an unavailable microphone API without requesting a publication", async () => {
  vi.stubGlobal("navigator", {});
  const { session, messages } = setup();
  try {
    await session.startMicrophone();
    expect(session.getSnapshot()).toMatchObject({ error: "microphoneUnavailable", capturePending: false, microphone: false });
    expect(messages.some(message => message.type === "room-voice-command")).toBe(false);
  } finally { session.close(); }
});

it.each(["cancel", "leave", "close-room", "disconnect", "close"] as const)("stops a late microphone result after %s without reviving authority", async action => {
  let finish!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { finish = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const { session, messages } = setup();
  const starting = session.startMicrophone();
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  if (action === "cancel") session.stopMicrophone();
  if (action === "leave") { session.receive(room(2, false)); session.receive(room(3, true)); }
  if (action === "close-room") { session.receive(room(2, false, false, false)); session.receive(room(3, true)); }
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

it("closes capture and clears pending publication when the Host closes room voice", async () => {
  const mic = microphone(), replacement = microphone();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn()
    .mockResolvedValueOnce(mic.stream).mockResolvedValueOnce(replacement.stream) } });
  const { session } = setup();
  await session.startMicrophone();
  expect(session.getSnapshot().capturePending).toBe(true);
  session.receive(room(2, false, false, false));
  expect(mic.track.stop).toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({ microphone: false, capturePending: false });
  session.receive(room(3));
  await session.startMicrophone(); session.receive(room(4, true, true));
  expect(session.microphone).toBe(true);
  session.receive(room(5, false, false, false));
  expect(replacement.track.stop).toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({ microphone: false, capturePending: false });
  session.receive(room(6, true));
  expect(session.microphone).toBe(false);
  session.close();
});

it("pauses local listening independently of microphone and per-person mute", async () => {
  const mic = microphone(), getUserMedia = vi.fn(async () => mic.stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const { session, messages } = setup();
  try {
    await session.startMicrophone(); session.receive(room(2, true, true));
    session.setListeningVolume(2);
    session.muteVoice("friend");
    session.deafen(true);
    expect(mic.track.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ deafened: true, microphone: true, capturePending: false, listeningVolume: 2 });
    expect(messages.some(message => message.type === "room-voice-command" && message.command.action === "unpublish")).toBe(false);
    session.deafen(false);
    expect(session.getSnapshot()).toMatchObject({ deafened: false, microphone: true, listeningVolume: 2, input: { volume: 1 } });
    expect(session.getSnapshot().muted.has("friend")).toBe(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

it("keeps the current microphone on a failed input change and replaces only local input on success", async () => {
  const first = microphone(), replacement = microphone();
  const getUserMedia = vi.fn().mockResolvedValueOnce(first.stream)
    .mockRejectedValueOnce(new DOMException("Device busy", "NotReadableError")).mockResolvedValueOnce(replacement.stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const { session, messages } = setup();
  await session.startMicrophone(); session.receive(room(2, true, true));
  session.setVolume(.5);
  await session.configureInput({ deviceId: "other", voiceProcessing: false });
  expect(session.getSnapshot().input).toMatchObject({ deviceId: "", voiceProcessing: true, volume: .5 });
  expect(first.track.stop).not.toHaveBeenCalled();
  await session.configureInput({ deviceId: "other", voiceProcessing: false });
  expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: "other" }, noiseSuppression: false }), video: false });
  expect(first.track.stop).toHaveBeenCalledOnce();
  expect(replacement.track.stop).not.toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({ microphone: true, capturePending: false, input: { deviceId: "other", voiceProcessing: false, volume: .5 } });
  expect(messages.filter(message => message.type === "room-voice-command")).toEqual([{ type: "room-voice-command", command: { action: "publish" } }]);
  session.close();
  expect(replacement.track.stop).toHaveBeenCalledOnce();
});

it("keeps person volume local across publication changes and retires it with the participant", () => {
  const { session, messages } = setup();
  const friend = { peerId: "friend", connected: true, joined: true, upstream: { kind: "none" as const } };
  session.receive({ ...room(2), members: [...room(2).members, friend] });
  session.setPeerVolume("friend", 2);
  session.setListeningVolume(.5);
  session.muteVoice("friend");
  session.receive({ ...room(3), members: [...room(3).members, { ...friend, publicationId: "friend-publication" }],
    publications: [{ peerId: "friend", id: "friend-publication" }] });
  expect(session.getSnapshot().peerVolumes.get("friend")).toBe(2);
  expect(session.getSnapshot().muted.has("friend")).toBe(true);
  expect(session.getSnapshot().listeningVolume).toBe(.5);
  expect(messages).toHaveLength(0);
  session.disconnected();
  session.authenticated("self", "viewer");
  session.receive({ ...room(3), members: [...room(3).members, friend] });
  expect(session.getSnapshot().peerVolumes.get("friend")).toBe(2);
  expect(session.getSnapshot().muted.has("friend")).toBe(true);
  session.receive(room(4));
  expect(session.getSnapshot().peerVolumes.size).toBe(0);
  expect(session.getSnapshot().muted.has("friend")).toBe(false);
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
