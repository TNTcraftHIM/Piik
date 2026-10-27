import { afterEach, expect, it, vi } from "vitest";
import { BrowserVoiceEndpoint } from "../src/client/room-voice/browser-endpoint";
import type { ClientMessage, RoomVoiceState } from "../src/shared/protocol";
import type { MicrophoneInput } from "../src/client/media/microphone-input";

const candidate = (index: number) => ({
  candidate: `candidate:${index} 1 UDP 100 192.0.2.1 ${40000 + index} typ host`,
  sdpMid: "0", sdpMLineIndex: 0,
});

it("keeps connected voice on sender parameter rejection and applies a later explicit update", async () => {
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
  const messages: ClientMessage[] = [];
  const endpoint = new BrowserVoiceEndpoint({ iceServers: [] }, message => { messages.push(message); return true; }, () => {});
  const authority: RoomVoiceState = { type: "room-voice-state", revision: 1, enabled: true, hostPeerId: "self", bitrate: 32_000,
    members: [{ peerId: "self", connected: true, joined: true, upstream: { kind: "none" } }],
    publications: [{ id: "mic", peerId: "self" }], unavailable: [],
    connections: [{ connectionId: "voice", transport: "peer", parentPeerId: "self", childPeerId: "other",
      revision: 1, pending: false, send: ["mic"], receive: [] }] };
  const track = { kind: "audio" };
  let parameters = { encodings: [{ maxBitrate: 32_000 }], codecs: [{ mimeType: "audio/opus", sdpFmtpLine: "maxaveragebitrate=510000" }] };
  const sender = { track, getParameters: () => parameters, setStreams: vi.fn(),
    setParameters: vi.fn(async (next: typeof parameters) => { parameters = next; }) };
  const input = { stream: { getAudioTracks: () => [track] }, close: vi.fn() };
  // The real endpoint owns sender creation, negotiation, failure reporting and retirement.
  vi.stubGlobal("RTCPeerConnection", class extends Peer { addTrack = vi.fn(() => sender); });
  try {
    endpoint.setAuthority(authority, "self");
    endpoint.attach("mic", input as unknown as MicrophoneInput);
    await endpoint.reconcile();
    const pc = Peer.instances[0]!;
    expect(endpoint.connected).toBe(true);
    sender.setParameters.mockRejectedValueOnce(new DOMException("temporarily unavailable", "InvalidStateError"));
    endpoint.setAuthority({ ...authority, revision: 2, bitrate: 48_000 }, "self");
    await expect(endpoint.reconcile()).resolves.toBeUndefined();
    expect(parameters.encodings[0]!.maxBitrate).toBe(32_000);
    expect(messages.filter(message => message.type === "room-voice-transport" && message.state === "failed")).toEqual([]);
    expect(pc.close).not.toHaveBeenCalled();
    await endpoint.reconcile();
    expect(parameters.encodings[0]!.maxBitrate).toBe(48_000);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    pc.setRemoteDescription = async () => { throw new Error("invalid SDP"); };
    await expect(endpoint.receive({ type: "room-voice-signal", connectionId: "voice",
      description: { revision: 1, sdp: { type: "answer", sdp: "invalid" }, tracks: [] } })).rejects.toThrow("invalid SDP");
    expect(messages).toContainEqual({ type: "room-voice-transport", connectionId: "voice", state: "failed" });
    endpoint.setAuthority({ ...authority, revision: 3, connections: [] }, "self");
    expect(pc.close).toHaveBeenCalledOnce();
  } finally { endpoint.close(); }
});

class Peer {
  static instances: Peer[] = [];
  connectionState: RTCPeerConnectionState = "connected";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  getTransceivers = (): unknown[] => [];
  addTransceiver = () => {};
  createDataChannel = () => {};
  createOffer = async () => ({ type: "offer" as const, sdp: "offer" });
  createAnswer = async () => ({ type: "answer" as const, sdp: "answer" });
  setLocalDescription = async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
    for (let index = 0; index < 65; index++) this.onicecandidate?.({ candidate: candidate(index) });
  };
  setRemoteDescription = async (description: RTCSessionDescriptionInit) => { this.remoteDescription = description; };
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  close = vi.fn(() => { this.connectionState = "closed"; });
  constructor() { Peer.instances.push(this); }
}

afterEach(() => { vi.unstubAllGlobals(); Peer.instances = []; });

it.each(["levels", "metrics"].flatMap(observation => [false, true].map(replaced => ({ observation, replaced }))))(
"keeps in-flight $observation tied to its receiver publication (replaced=$replaced)", async ({ observation, replaced }) => {
  class AudioElement extends EventTarget {
    volume = 1; muted = false; paused = true; ended = false;
    srcObject: unknown = null;
    play = async () => { this.paused = false; };
    pause = () => { this.paused = true; };
    remove = () => {};
  }
  vi.stubGlobal("Audio", AudioElement);
  vi.stubGlobal("document", { body: { append: () => {} } });
  vi.stubGlobal("MediaStream", class {
    constructor(private tracks: MediaStreamTrack[]) {}
    getAudioTracks() { return this.tracks; }
  });
  const track = { id: "stable-receiver", kind: "audio", readyState: "live" };
  let finishStats!: (report: RTCStatsReport) => void;
  const reading = new Promise<RTCStatsReport>(resolve => { finishStats = resolve; });
  const getStats = vi.fn(() => reading);
  vi.stubGlobal("RTCPeerConnection", class extends Peer {
    getStats = getStats;
    getTransceivers = () => [{ mid: "0", direction: "recvonly", receiver: { track }, sender: { track: null } }];
  });
  const endpoint = new BrowserVoiceEndpoint({ iceServers: [] }, () => true, () => {});
  const authority = (publicationId: string, peerId: string, revision: number): RoomVoiceState => ({
    type: "room-voice-state", revision, enabled: true, hostPeerId: "host", unavailable: [],
    members: [{ peerId: "self", connected: true, joined: true, upstream: { kind: "sfu" } }],
    publications: [{ id: publicationId, peerId }],
    connections: [{ connectionId: "stable-connection", childPeerId: "self", transport: "sfu", revision, pending: false, send: [], receive: [publicationId] }],
  });
  const manifest = async (publicationId: string, revision: number) => endpoint.receive({
    type: "room-voice-signal", connectionId: "stable-connection", description: {
      revision, sdp: { type: "offer", sdp: "offer" }, tracks: [{ mid: "0", publicationId }],
    },
  });
  const report = (ssrc: number, audioLevel: number) => new Map([["audio", {
    id: "audio", type: "inbound-rtp", kind: "audio", ssrc, timestamp: ssrc * 1000,
    trackIdentifier: track.id, audioLevel, bytesReceived: ssrc * 100,
  }]]) as unknown as RTCStatsReport;
  try {
    endpoint.setAuthority(authority("old-publication", "old-publisher", 1), "self");
    await endpoint.reconcile(); await manifest("old-publication", 1);
    const pending = observation === "levels" ? endpoint.levels() : endpoint.connectionMetrics();
    expect(getStats).toHaveBeenCalledOnce();
    const publication = replaced ? "new-publication" : "old-publication";
    const publisher = replaced ? "new-publisher" : "old-publisher";
    endpoint.setAuthority(authority(publication, publisher, 2), "self");
    await manifest(publication, 2);
    finishStats(report(1, .75));
    if (replaced) expect([...(await pending)]).toEqual([]);
    else if (observation === "levels") expect([...(await pending)]).toEqual([[publisher, .75]]);
    else expect(await pending).toEqual([expect.objectContaining({ peerId: publisher, direction: "receive" })]);

    getStats.mockResolvedValue(report(2, .25));
    if (observation === "levels") expect([...(await endpoint.levels())]).toEqual([[publisher, .25]]);
    else expect(await endpoint.connectionMetrics()).toEqual([
      expect.objectContaining({ peerId: publisher, direction: "receive", connectionId: "stable-connection" }),
    ]);
    expect(Peer.instances).toHaveLength(1);
    expect(Peer.instances[0]!.close).not.toHaveBeenCalled();
  } finally { endpoint.close(); }
});

it("drops an in-flight sender report after microphone replacement on the same publication", async () => {
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
  const oldTrack = { id: "old-input", kind: "audio", readyState: "live" };
  const newTrack = { id: "new-input", kind: "audio", readyState: "live" };
  const sender = { track: oldTrack, setStreams: () => {}, getParameters: () => ({ encodings: [], codecs: [] }),
    replaceTrack: async (track: typeof oldTrack) => { sender.track = track; } };
  let finishStats!: (report: RTCStatsReport) => void;
  const reading = new Promise<RTCStatsReport>(resolve => { finishStats = resolve; });
  const getStats = vi.fn(() => reading);
  vi.stubGlobal("RTCPeerConnection", class extends Peer { getStats = getStats; addTrack = () => sender; });
  const endpoint = new BrowserVoiceEndpoint({ iceServers: [] }, () => true, () => {});
  endpoint.setAuthority({ type: "room-voice-state", revision: 1, enabled: true, hostPeerId: "self", unavailable: [],
    members: [{ peerId: "self", connected: true, joined: true, upstream: { kind: "none" } }],
    publications: [{ id: "mic", peerId: "self" }],
    connections: [{ connectionId: "stable", transport: "peer", parentPeerId: "self", childPeerId: "other", revision: 1, pending: false, send: ["mic"], receive: [] }],
  }, "self");
  const input = (track: typeof oldTrack) => ({ stream: { getAudioTracks: () => [track] },
    close: () => { track.readyState = "ended"; } }) as unknown as MicrophoneInput;
  const report = (track: typeof oldTrack) => new Map([
    ["sender", { id: "sender", type: "outbound-rtp", kind: "audio", mediaSourceId: "source", timestamp: 1000, ssrc: 1 }],
    ["source", { id: "source", type: "media-source", kind: "audio", trackIdentifier: track.id }],
  ]) as unknown as RTCStatsReport;
  try {
    endpoint.attach("mic", input(oldTrack)); await endpoint.reconcile();
    const pending = endpoint.connectionMetrics();
    endpoint.attach("mic", input(newTrack)); await endpoint.reconcile();
    finishStats(report(oldTrack));
    expect(await pending).toEqual([]);
    getStats.mockResolvedValue(report(newTrack));
    expect(await endpoint.connectionMetrics()).toEqual([
      expect.objectContaining({ peerId: "self", direction: "send", metrics: expect.objectContaining({ trackIdentifier: newTrack.id }) }),
    ]);
    expect(Peer.instances).toHaveLength(1);
    expect(Peer.instances[0]!.close).not.toHaveBeenCalled();
  } finally { endpoint.close(); }
});

it.each(["local", "remote"])("retains and flushes the first 64 %s voice candidates without failing the transport", async phase => {
  vi.stubGlobal("RTCPeerConnection", Peer);
  const messages: ClientMessage[] = [];
  const endpoint = new BrowserVoiceEndpoint({ iceServers: [] }, message => { messages.push(message); return true; }, () => {});
  const connection = { connectionId: "voice-connection", transport: "peer" as const,
    parentPeerId: phase === "local" ? "self" : "other", childPeerId: phase === "local" ? "other" : "self",
    revision: 1, pending: false, send: [], receive: [] };
  const authority: RoomVoiceState = { type: "room-voice-state", revision: 1, enabled: true, hostPeerId: "self",
    members: [{ peerId: "self", connected: true, joined: true, upstream: { kind: "none" } }],
    publications: [], connections: [connection], unavailable: [] };
  try {
    endpoint.setAuthority(authority, "self");
    await endpoint.reconcile();
    const pc = Peer.instances[0]!;
    if (phase === "local") {
      expect(messages.filter(message => message.type === "room-voice-signal" && message.candidate)
        .map(message => message.type === "room-voice-signal" ? message.candidate : undefined))
        .toEqual(Array.from({ length: 64 }, (_, index) => candidate(index)));
    } else {
      for (let index = 0; index < 65; index++) await endpoint.receive({
        type: "room-voice-signal", connectionId: connection.connectionId, candidate: candidate(index),
      });
      expect(pc.addIceCandidate).not.toHaveBeenCalled();
      await endpoint.receive({ type: "room-voice-signal", connectionId: connection.connectionId,
        description: { revision: 1, sdp: { type: "offer", sdp: "offer" }, tracks: [] } });
      expect(pc.addIceCandidate.mock.calls.map(([value]) => value))
        .toEqual(Array.from({ length: 64 }, (_, index) => candidate(index)));
    }
    expect(messages.filter(message => message.type === "room-voice-transport" && message.state === "failed")).toEqual([]);
    expect(endpoint.connected).toBe(true);
    expect(pc.close).not.toHaveBeenCalled();

    // ICE state reports failure; the room's subsequent authority update owns retirement.
    pc.connectionState = "failed";
    await endpoint.reconcile();
    expect(messages).toContainEqual({ type: "room-voice-transport", connectionId: connection.connectionId, state: "failed" });
    endpoint.setAuthority({ ...authority, revision: 2, connections: [] }, "self");
    expect(pc.close).toHaveBeenCalledOnce();
    const count = messages.length;
    pc.onicecandidate?.({ candidate: candidate(99) });
    expect(messages).toHaveLength(count);
  } finally { endpoint.close(); }
});
