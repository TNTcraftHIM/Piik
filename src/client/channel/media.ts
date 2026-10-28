import { observeDecodedFrameProof } from "../media/decoded-frame-proof";
import { decodedVideoFrames } from "../webrtc/stats";
import type { ChannelCommand, ChannelPair, ChannelSignal, ChannelSnapshot } from "./protocol";
import { ChannelTransport } from "./transport";

interface Peer {
  plan: ChannelPair;
  transport: ChannelTransport;
  inputs: Map<string, MediaInput>;
  baseReady: Set<string>;
}

interface MediaInput {
  stream: MediaStream;
  video: MediaStreamTrack | undefined;
  receiver: RTCRtpReceiver | undefined;
  ready: boolean;
  stopProof?: () => void;
}

export class ChannelMedia {
  private peers = new Map<string, Peer>();
  private publications: ChannelSnapshot["publications"] = [];
  private local = new Map<string, MediaStream>();
  private streams = new Map<string, MediaStream>();
  private relayAudio = new Map<string, { tracks: MediaStreamTrack[]; audio: HTMLAudioElement }>();

  constructor(private send: (command: ChannelCommand) => void,
    private changed: (streams: ReadonlyMap<string, MediaStream>) => void,
    private data?: (peer: string, kind: "control" | "chunk", data: string | Uint8Array) => void,
    private dataState?: (peer: string, ready: boolean) => void,
    private bulkClosed?: (peer: string) => void) {}

  setLocal(id: string, stream: MediaStream): void {
    this.local.set(id, stream);
    this.refresh();
  }

  removeLocal(id: string): void {
    const stream = this.local.get(id);
    this.local.delete(id);
    this.refresh();
    // Only the capture owner stops tracks. Forwarders close their sender, never the source.
    stream?.getTracks().forEach(track => track.stop());
  }

  update(sessionId: string, state: ChannelSnapshot): void {
    this.publications = state.publications;
    const plans = new Map(state.pairs.map(plan => [plan.id, plan]));
    for (const [id, peer] of this.peers) {
      if (!plans.has(id)) {
        this.peers.delete(id);
        this.closePeer(peer);
      }
    }
    for (const plan of state.pairs) {
      let peer = this.peers.get(plan.id);
      if (!peer) {
        const transport = new ChannelTransport({
          polite: sessionId.localeCompare(plan.peerId) > 0,
          iceServers: state.iceServers,
          send: payload => this.send({ type: "signal", pairId: plan.id, payload }),
          receive: (publicationId, stream) => this.receive(plan.id, publicationId, stream),
          data: (kind, data) => { if (this.peers.get(plan.id)?.plan.rooms.length) this.data?.(plan.peerId, kind, data); },
          dataState: ready => this.dataState?.(plan.peerId, ready),
          bulkClosed: () => this.bulkClosed?.(plan.peerId),
          connected: () => {
            this.send({ type: "link_state", pairId: plan.id, state: "connected" });
            const current = this.peers.get(plan.id);
            if (current) for (const [id, input] of current.inputs) this.prove(current, id, input.stream);
          },
          failed: () => this.send({ type: "link_state", pairId: plan.id, state: "failed" }),
          base: ready => {
            const current = this.peers.get(plan.id);
            if (current) this.reportBase(current, ready);
          },
        });
        peer = { plan, transport, inputs: new Map(), baseReady: new Set() };
        this.peers.set(plan.id, peer);
      } else peer.plan = plan;
      for (const room of peer.baseReady) if (!plan.rooms.includes(room)) peer.baseReady.delete(room);
      peer.transport.setRooms(plan.rooms);
      if (peer.transport.isBaseReady()) this.reportBase(peer, true);
      for (const [publicationId, input] of peer.inputs) {
        if (!plan.incoming.includes(publicationId)) {
          input.stopProof?.();
          peer.inputs.delete(publicationId);
        }
      }
    }
    this.refresh();
  }

  private reportBase(peer: Peer, ready: boolean): void {
    for (const roomId of peer.plan.rooms) {
      if (ready && peer.baseReady.has(roomId)) continue;
      if (ready) peer.baseReady.add(roomId); else peer.baseReady.delete(roomId);
      this.send({ type: "base_state", roomId, pairId: peer.plan.id, ready });
    }
  }

  signal(pairId: string, payload: ChannelSignal): void {
    this.peers.get(pairId)?.transport.signal(payload);
  }

  resync(): void {
    for (const peer of this.peers.values()) peer.transport.resync();
  }

  sendData(peerId: string, kind: "control" | "chunk", data: string | Uint8Array): Promise<void> {
    const peer = [...this.peers.values()].find(peer => peer.plan.peerId === peerId && peer.plan.rooms.length);
    if (!peer) return Promise.reject(new Error("file_peer_unavailable"));
    return peer.transport.sendData(kind, data).catch(error => {
      // Retiring this exact pair already notified the delivery owner. A late
      // send rejection must not retire a replacement to the same participant.
      if (this.peers.get(peer.plan.id) === peer) throw error;
    });
  }

  private receive(pairId: string, publicationId: string, stream: MediaStream): void {
    const peer = this.peers.get(pairId);
    if (!peer?.plan.incoming.includes(publicationId)) return;
    this.prove(peer, publicationId, stream);
    this.refresh();
  }

  private prove(peer: Peer, id: string, stream: MediaStream): void {
    const kind = this.publications.find(publication => publication.id === id)?.kind;
    if (!kind) return;
    const video = kind === "screen" ? stream.getVideoTracks()[0] : undefined;
    const receiver = video ? peer.transport.pc.getReceivers().find(candidate => candidate.track === video) : undefined;
    const previous = peer.inputs.get(id);
    const input: MediaInput = previous && previous.stream === stream && previous.video === video && previous.receiver === receiver
      ? previous : { stream, video, receiver, ready: false };
    if (input !== previous) {
      previous?.stopProof?.();
      peer.inputs.set(id, input);
    }
    if (input.ready || input.stopProof) return;
    const owned = () => this.peers.get(peer.plan.id) === peer && peer.plan.incoming.includes(id) &&
      peer.inputs.get(id) === input && (kind !== "screen" ||
        (receiver !== undefined && stream.getVideoTracks()[0] === video && receiver.track === video &&
          peer.transport.pc.getReceivers().includes(receiver)));
    const ready = () => {
      if (!owned()) return true;
      if (peer.transport.pc.connectionState !== "connected") return false;
      input.ready = true;
      input.stopProof = undefined;
      this.send({ type: "flow_state", publicationId: id, pairId: peer.plan.id, ready: true });
      return true;
    };
    if (kind === "voice") {
      ready();
      return;
    }
    if (!video || !receiver) return;
    input.stopProof = observeDecodedFrameProof({
      owns: owned,
      requireProgress: previous?.receiver === receiver,
      readFramesDecoded: async () => decodedVideoFrames(await receiver.getStats()),
      onProof: ready,
    });
  }

  private refresh(): void {
    const streams = new Map(this.local);
    const relayAudio = new Map<string, MediaStreamTrack[]>();
    for (const peer of this.peers.values()) for (const [id, input] of peer.inputs) streams.set(id, input.stream);
    for (const peer of this.peers.values()) {
      const outgoing = new Map<string, MediaStream>();
      for (const id of peer.plan.outgoing) {
        const stream = streams.get(id);
        if (stream) {
          outgoing.set(id, stream);
          if (!this.local.has(id)) {
            const tracks = stream.getAudioTracks().filter(track => track.readyState !== "ended");
            if (tracks.length) relayAudio.set(id, tracks);
          }
        }
      }
      peer.transport.setOutgoing(outgoing);
    }
    this.syncRelayAudio(relayAudio);
    const changed = streams.size !== this.streams.size || [...streams].some(([id, stream]) => this.streams.get(id) !== stream);
    this.streams = streams;
    if (changed) this.changed(new Map(streams));
  }

  private syncRelayAudio(needed: ReadonlyMap<string, MediaStreamTrack[]>): void {
    for (const [id, binding] of this.relayAudio) {
      const tracks = needed.get(id);
      if (tracks?.length === binding.tracks.length && tracks.every((track, index) => track === binding.tracks[index])) continue;
      binding.audio.pause();
      binding.audio.srcObject = null;
      binding.audio.remove();
      this.relayAudio.delete(id);
    }
    for (const [id, tracks] of needed) if (!this.relayAudio.has(id)) {
      // Chromium's audio receiver is pulled by a consumer, even for forwarding.
      const audio = new Audio();
      audio.autoplay = true; audio.hidden = true; audio.muted = true;
      audio.srcObject = new MediaStream(tracks);
      this.relayAudio.set(id, { tracks, audio });
      document.body.append(audio);
      void audio.play().catch(error => {
        if (this.relayAudio.get(id)?.audio === audio && error?.name !== "AbortError") {
          console.warn("Channel relay audio could not start", error);
        }
      });
    }
  }

  async stats(): Promise<Array<{ pairId: string; peerId: string; reports: Record<string, unknown>[] }>> {
    return Promise.all([...this.peers].map(async ([pairId, peer]) => {
      const values: Record<string, unknown>[] = [];
      (await peer.transport.pc.getStats()).forEach(report => values.push(report));
      return { pairId, peerId: peer.plan.peerId, reports: values };
    }));
  }

  private closePeer(peer: Peer): void {
    for (const input of peer.inputs.values()) input.stopProof?.();
    peer.transport.close();
  }

  reset(): void {
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
    for (const id of [...this.local.keys()]) this.removeLocal(id);
    this.refresh();
  }
}
