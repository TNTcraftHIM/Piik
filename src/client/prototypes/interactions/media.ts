import type { Command, Member, SignalEvent } from "./protocol";

export interface MediaView {
  remotes: { id: string; stream: MediaStream; state: RTCPeerConnectionState }[];
}
export const emptyMedia: MediaView = { remotes: [] };
type Edge = {
  id: string; pc: RTCPeerConnection; stream: MediaStream;
  audio: RTCRtpSender | null; video: RTCRtpSender | null; queue: Promise<void>;
  candidates: RTCIceCandidateInit[];
};

// ponytail: direct Host fanout for the local preview. Production microphone
// commentary belongs in the existing Host media path, not a second route graph.
export class RoomMedia {
  private identity: { self: string; host: string } | null = null;
  private edges = new Map<string, Edge>();
  private source: MediaStream | null = null;

  constructor(private send: (command: Command) => void,
    private change: (state: MediaView) => void,
    private fail: (code: "media-failed") => void) {}

  private publish() {
    this.change({ remotes: Array.from(this.edges.values(), (edge) => ({ id: edge.id, stream: edge.stream, state: edge.pc.connectionState })) });
  }

  setSource(stream: MediaStream | null) {
    this.source = stream;
    if (!this.isHost()) return;
    for (const edge of this.edges.values()) this.enqueue(edge, () => this.replaceSource(edge));
  }
  private async replaceSource(edge: Edge) {
    await edge.audio?.replaceTrack(this.source?.getAudioTracks()[0] ?? null);
    if (this.current(edge)) await edge.video?.replaceTrack(this.source?.getVideoTracks()[0] ?? null);
  }

  update(self: string, members: Member[]) {
    const host = members.find((member) => member.role === "host");
    if (!host || !members.some((member) => member.id === self)) { this.close(); return; }
    if (self !== this.identity?.self || host.id !== this.identity?.host) {
      this.close(); this.identity = { self, host: host.id };
    }
    // The harness keeps connections for its room lifetime. Source stop detaches
    // tracks; leave retires the connection identity and any queued signaling.
    const peers = this.isHost() ? members.filter((member) => member.role === "viewer") : [host];
    for (const [id, edge] of this.edges) {
      if (!peers.some((member) => member.id === id)) {
        edge.pc.close(); this.edges.delete(id);
      }
    }
    for (const member of peers) {
      if (this.edges.has(member.id)) continue;
      const pc = new RTCPeerConnection({ iceServers: [] });
      // Only the offerer creates slots. The answerer adopts the offered slots;
      // pre-creating its own transceivers would leave them unassociated.
      const offerer = this.isHost();
      const edge: Edge = { id: member.id, pc, stream: new MediaStream(),
        audio: offerer ? pc.addTransceiver("audio", { direction: "sendonly" }).sender : null,
        video: offerer ? pc.addTransceiver("video", { direction: "sendonly" }).sender : null,
        candidates: [], queue: Promise.resolve() };
      this.edges.set(member.id, edge);
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && this.current(edge)) this.sendSignal(edge, {
          kind: "candidate", candidate: candidate.candidate,
          sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex,
        });
      };
      pc.ontrack = ({ track }) => {
        if (this.current(edge) && !this.isHost()) { edge.stream.addTrack(track); this.publish(); }
      };
      pc.onconnectionstatechange = () => {
        if (!this.current(edge)) return;
        this.publish();
        if (pc.connectionState === "failed") this.fail("media-failed");
      };
      this.enqueue(edge, async () => {
        if (offerer) {
          await this.replaceSource(edge);
          if (!this.current(edge)) return;
          await pc.setLocalDescription(await pc.createOffer());
          this.sendSignal(edge, { kind: "description", type: "offer", sdp: pc.localDescription!.sdp });
        }
      });
    }
    this.publish();
  }

  private isHost() { return !!this.identity && this.identity.self === this.identity.host; }
  private current(edge: Edge) { return this.edges.get(edge.id) === edge && !!this.identity; }
  private sendSignal(edge: Edge, signal: SignalEvent["signal"]) {
    if (this.current(edge)) this.send({ type: "signal", to: edge.id, signal });
  }
  private enqueue(edge: Edge, task: () => Promise<void>) {
    edge.queue = edge.queue.then(async () => { if (this.current(edge)) await task(); }).catch(() => {
      if (this.current(edge)) this.fail("media-failed");
    });
  }
  receive(event: SignalEvent) {
    const edge = this.edges.get(event.from);
    if (!edge) return;
    this.enqueue(edge, async () => {
      const signal = event.signal;
      if (signal.kind === "candidate") {
        const candidate = { candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex };
        if (edge.pc.remoteDescription) await edge.pc.addIceCandidate(candidate);
        else if (edge.candidates.length < 64) edge.candidates.push(candidate);
        return;
      }
      // Only the Host offers media. Viewers answer with receive-only slots.
      if ((signal.type === "offer") === this.isHost()) return;
      await edge.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
      for (const candidate of edge.candidates.splice(0)) await edge.pc.addIceCandidate(candidate);
      if (signal.type === "offer") {
        for (const transceiver of edge.pc.getTransceivers()) {
          transceiver.direction = "recvonly";
        }
        await edge.pc.setLocalDescription(await edge.pc.createAnswer());
        this.sendSignal(edge, { kind: "description", type: "answer", sdp: edge.pc.localDescription!.sdp });
      }
    });
  }

  close() {
    this.identity = null;
    for (const edge of this.edges.values()) edge.pc.close();
    this.edges.clear();
    this.source = null;
    this.publish();
  }
}
