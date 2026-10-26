import { afterEach, expect, it, vi } from "vitest";
import { BrowserVoiceEndpoint } from "../src/client/room-voice/browser-endpoint";
import type { ClientMessage, RoomVoiceState } from "../src/shared/protocol";

const candidate = (index: number) => ({
  candidate: `candidate:${index} 1 UDP 100 192.0.2.1 ${40000 + index} typ host`,
  sdpMid: "0", sdpMLineIndex: 0,
});

class Peer {
  static instances: Peer[] = [];
  connectionState: RTCPeerConnectionState = "connected";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  getTransceivers = () => [];
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
