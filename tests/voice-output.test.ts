import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserVoiceEndpoint } from "../src/client/room-voice/browser-endpoint";
import { RoomVoiceSession } from "../src/client/room-voice/session";
import { audioOutputSelectionSupported, requestAudioOutputAccess } from "../src/client/media/audio-output";
import type { RoomVoiceState } from "../src/shared/protocol";

class Element extends EventTarget {
  static all: Element[] = [];
  static switchDevice = async (_id: string) => {};
  sinkId = "";
  volume = 1; muted = false; paused = true; ended = false; autoplay = false;
  srcObject: unknown = null;
  playedOn: string[] = [];
  constructor() { super(); Element.all.push(this); }
  async setSinkId(id: string) { await Element.switchDevice(id); this.sinkId = id; }
  async play() { this.playedOn.push(this.sinkId); this.paused = false; this.dispatchEvent(new Event("play")); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  remove() {}
}
class Context extends EventTarget {
  static all: Context[] = [];
  static switchDevice = async (_id: string) => {};
  sinkId: string;
  state = "running"; destination = {};
  gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  constructor(options?: { sinkId?: string }) { super(); this.sinkId = options?.sinkId ?? ""; Context.all.push(this); }
  async setSinkId(id: string) { await Context.switchDevice(id); this.sinkId = id; }
  async resume() { this.state = "running"; this.dispatchEvent(new Event("statechange")); }
  async close() { this.state = "closed"; }
  createGain() { const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; this.gains.push(gain); return gain; }
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
}
class Stream {
  constructor(private tracks: unknown[]) {}
  getAudioTracks() { return this.tracks; }
}
class Peer {
  static current: Peer;
  connectionState = "connected"; signalingState = "stable";
  localDescription: unknown; remoteDescription: unknown;
  tracks: Array<{ mid: string; receiver: { track: { id: string; kind: string; readyState: string } } }> = [];
  constructor() { Peer.current = this; }
  getTransceivers() { return this.tracks; }
  async setRemoteDescription(sdp: unknown) { this.remoteDescription = sdp; }
  async setLocalDescription(sdp: unknown) { this.localDescription = sdp; }
  async createAnswer() { return { type: "answer", sdp: "" }; }
  close() { this.connectionState = "closed"; }
}
const endpoints: BrowserVoiceEndpoint[] = [];
const sessions: RoomVoiceSession[] = [];
beforeEach(() => {
  Element.all = []; Context.all = [];
  Element.switchDevice = async () => {}; Context.switchDevice = async () => {};
  vi.stubGlobal("Audio", Element); vi.stubGlobal("HTMLMediaElement", Element);
  vi.stubGlobal("AudioContext", Context); vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("document", { body: { append: vi.fn() } });
  vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn(async () => [{ kind: "audiooutput", deviceId: "headset", label: "Headset" }]),
  }) });
});
afterEach(() => {
  sessions.splice(0).forEach(session => session.close());
  endpoints.splice(0).forEach(endpoint => endpoint.close());
  vi.unstubAllGlobals();
});
function endpoint() {
  const endpoint = new BrowserVoiceEndpoint({ iceServers: [] }, () => true, () => {});
  endpoints.push(endpoint); return endpoint;
}
async function receive(endpoint: BrowserVoiceEndpoint, ids = ["friend"], revision = 1) {
  const state: RoomVoiceState = { type: "room-voice-state", revision, enabled: true, hostPeerId: "host",
    members: [], publications: ids.map(id => ({ id, peerId: id })), unavailable: [],
    connections: [{ connectionId: "connection", parentPeerId: "host", childPeerId: "self", transport: "peer",
      pending: false, revision, send: [], receive: ids }] };
  endpoint.setAuthority(state, "self");
  await endpoint.reconcile();
  Peer.current.tracks = ids.map(id => ({ mid: id, receiver: { track: { id, kind: "audio", readyState: "live" } } }));
  await endpoint.receive({ type: "room-voice-signal", connectionId: "connection",
    description: { revision, sdp: { type: "offer", sdp: "" }, tracks: ids.map(id => ({ mid: id, publicationId: id })) } });
  await endpoint.resume();
}
const playingElements = () => Element.all.filter(element => element.srcObject);

it("routes ordinary playback, lazy gain playback and later publications to the chosen device", async () => {
  const voice = endpoint();
  await voice.setOutputDevice("headset");
  await receive(voice);
  expect(playingElements().map(element => element.sinkId)).toEqual(["headset"]);
  expect(playingElements()[0].playedOn.every(id => id === "headset")).toBe(true);
  expect(Context.all).toHaveLength(0);
  voice.setListeningVolume(1.5);
  expect(Context.all[0].sinkId).toBe("headset");
  expect(Context.all[0].gains[0].gain.value).toBe(1.5);
  await voice.setOutputDevice("speakers");
  expect(Context.all[0].sinkId).toBe("speakers");
  expect(playingElements()[0].sinkId).toBe("speakers");
  await receive(voice, ["friend", "new-friend"], 2);
  expect(playingElements().every(element => element.sinkId === "speakers")).toBe(true);
  voice.setPeerVolume("new-friend", 2);
  expect(Context.all.at(-1)!.gains.at(-1)!.gain.value).toBe(3);
  voice.deafen(true);
  expect(Context.all.at(-1)!.gains.every(gain => gain.gain.value === 0)).toBe(true);
  await voice.setOutputDevice("");
  voice.deafen(false);
  expect(Context.all.at(-1)!.sinkId).toBe("");
  expect(playingElements().every(element => element.sinkId === "")).toBe(true);
});

it("restores every output after a partial switch fails", async () => {
  const voice = endpoint();
  await voice.setOutputDevice("headset"); await receive(voice);
  voice.setListeningVolume(2);
  Context.switchDevice = async id => { if (id === "speakers") throw new DOMException("Denied", "NotAllowedError"); };
  await expect(voice.setOutputDevice("speakers")).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(voice.outputDeviceId).toBe("headset");
  expect(playingElements()[0].sinkId).toBe("headset");
  expect(Context.all[0].sinkId).toBe("headset");
  expect(Context.all[0].gains[0].gain.value).toBe(2);
});

it("holds new playback until a pending output choice finishes and does not change the default first", async () => {
  const voice = endpoint();
  let finish!: () => void;
  Element.switchDevice = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const selection = voice.setOutputDevice("headset");
  await Promise.resolve();
  const incoming = receive(voice);
  await vi.waitFor(() => expect(playingElements()).toHaveLength(1));
  expect(playingElements()[0].playedOn).toEqual([]);
  voice.setListeningVolume(2);
  finish(); await selection; await incoming;
  expect(playingElements()[0].playedOn.every(id => id === "headset")).toBe(true);
  expect(Context.all[0].sinkId).toBe("headset");
});

it("does not commit a device switch that finishes after playback retirement", async () => {
  const voice = endpoint();
  let finish!: () => void;
  Element.switchDevice = () => new Promise<void>(resolve => { finish = resolve; });
  const selection = voice.setOutputDevice("headset");
  await Promise.resolve(); voice.close(); finish();
  await expect(selection).rejects.toMatchObject({ name: "AbortError" });
  expect(voice.outputDeviceId).toBe("");
  expect(playingElements()).toEqual([]);
});

it("routes a replacement playback context acquired while the old context is switching", async () => {
  const voice = endpoint();
  await receive(voice); voice.setListeningVolume(2);
  let finish!: () => void;
  Context.switchDevice = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const selection = voice.setOutputDevice("headset");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const incoming = receive(voice, ["replacement"], 2);
  await vi.waitFor(() => expect(Context.all).toHaveLength(2));
  finish(); await selection; await incoming;
  expect(Context.all[0].state).toBe("closed");
  expect(Context.all[1].sinkId).toBe("headset");
  expect(playingElements().every(element => element.sinkId === "headset")).toBe(true);
});

it("suspends a disconnected device, keeps the choice across reconnect and recovers on explicit selection", async () => {
  const send = vi.fn(() => true);
  const session = new RoomVoiceSession(send, { iceServers: [] }); sessions.push(session);
  session.authenticated("self", "viewer");
  await session.configureOutput("headset");
  await receive(session.endpoint);
  send.mockClear();
  session.endpoint.setListeningVolume(2);
  const devices = navigator.mediaDevices;
  vi.mocked(devices.enumerateDevices).mockResolvedValue([]);
  devices.dispatchEvent(new Event("devicechange"));
  await vi.waitFor(() => expect(session.getSnapshot().outputError).toBe("missing"));
  expect(Context.all[0].gains[0].gain.value).toBe(0);
  expect(session.getSnapshot().outputDeviceId).toBe("headset");
  session.disconnected(); session.authenticated("self", "viewer");
  expect(session.getSnapshot().outputDeviceId).toBe("headset");
  await session.configureOutput("");
  expect(session.getSnapshot()).toMatchObject({ outputDeviceId: "", outputError: null, outputPending: false });
  expect(send).not.toHaveBeenCalled();
});

it("uses the output permission picker, or immediately releases temporary microphone access without publishing", async () => {
  const stop = vi.fn();
  Object.assign(navigator.mediaDevices, { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) });
  expect(await requestAudioOutputAccess()).toBeUndefined();
  expect(stop).toHaveBeenCalledOnce();
  const picker = vi.fn(async () => ({ deviceId: "headset" }));
  Object.assign(navigator.mediaDevices, { selectAudioOutput: picker });
  const send = vi.fn(() => true);
  const session = new RoomVoiceSession(send, { iceServers: [] }); sessions.push(session);
  await session.configureOutput();
  expect(session.getSnapshot()).toMatchObject({ outputDeviceId: "headset", microphone: false });
  expect(send).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce();
});

it("requires support for both playback paths and reports denied permission without changing output", async () => {
  expect(audioOutputSelectionSupported()).toBe(true);
  vi.stubGlobal("AudioContext", class {});
  expect(audioOutputSelectionSupported()).toBe(false);
  vi.stubGlobal("AudioContext", Context);
  const session = new RoomVoiceSession(() => true, { iceServers: [] }); sessions.push(session);
  await session.configureOutput("headset");
  Element.switchDevice = async id => { if (id === "speakers") throw new DOMException("Denied", "NotAllowedError"); };
  await session.configureOutput("speakers");
  expect(session.getSnapshot()).toMatchObject({ outputDeviceId: "headset", outputPending: false, outputError: "denied" });
});

it("releases permission-only input arriving after the room session closes", async () => {
  let finish!: (stream: { getTracks: () => { stop: () => void }[] }) => void;
  const stop = vi.fn();
  Object.assign(navigator.mediaDevices, { getUserMedia: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
  const send = vi.fn(() => true);
  const session = new RoomVoiceSession(send, { iceServers: [] }); sessions.push(session);
  const access = session.configureOutput();
  session.close(); finish({ getTracks: () => [{ stop }] }); await access;
  expect(stop).toHaveBeenCalledOnce();
  expect(session.getSnapshot()).toMatchObject({ outputDeviceId: "", outputPending: false, microphone: false });
  expect(send).not.toHaveBeenCalled();
});
