import { observeDecodedFrameProof } from "../media/decoded-frame-proof";
import { collectConnectionMetrics, createStatsAccumulator, decodedVideoFrameSamples } from "../webrtc/stats";
import { P2pQualityProbe } from "../media/candidate-quality-probe";
import { VIEWER_QUALITY_EVIDENCE_INTERVAL_MS } from "../../shared/protocol";
import type { ChannelCommand, ChannelPair, ChannelSignal, ChannelSnapshot } from "./protocol";
import type { ChannelScreenInput, ScreenPresentation } from "./types";
import { ChannelTransport, type OutgoingMedia } from "./transport";
import { applyCaptureProfile, type QualityProfile } from "../media/quality";
import { automaticVideoCodecPreference, VP8_ONLY_VIDEO_CODEC, type BrowserVideoCodecPreference } from "../webrtc/video-codec";
import { preferredVideoCodecForTrack } from "../webrtc/video-codec-preflight";

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
  presentationReady?: boolean;
  qualityApproved?: boolean;
  switchReady?: boolean;
  failed?: boolean;
  incumbent?: MediaInput;
  stopQuality?: () => void;
  stopProof?: () => void;
  release?: () => void;
  codec?: BrowserVideoCodecPreference;
  codecProbe?: AbortController;
}

export class ChannelMedia {
  private peers = new Map<string, Peer>();
  private publications: ChannelSnapshot["publications"] = [];
  private subscriptions: ChannelSnapshot["subscriptions"] = [];
  private rooms: ChannelSnapshot["channel"]["rooms"] = [];
  private local = new Map<string, { stream: MediaStream; profile?: QualityProfile; codec?: BrowserVideoCodecPreference }>();
  private streams = new Map<string, MediaStream>();
  private screenInputs = new Map<string, ChannelScreenInput[]>();
  private relayAudio = new Map<string, { tracks: MediaStreamTrack[]; audio: HTMLAudioElement }>();

  constructor(private send: (command: ChannelCommand) => void,
    private changed: (streams: ReadonlyMap<string, MediaStream>, screenInputs: ReadonlyMap<string, readonly ChannelScreenInput[]>) => void,
    private data?: (peer: string, kind: "control" | "chunk", data: string | Uint8Array) => void,
    private dataState?: (peer: string, ready: boolean) => void,
    private bulkClosed?: (peer: string) => void,
    private input?: (pairId: string, channel: RTCDataChannel | null) => void) {}

  setLocal(id: string, stream: MediaStream, profile?: QualityProfile, codec?: BrowserVideoCodecPreference): void {
    this.local.set(id, { stream, profile, codec });
    this.refresh();
  }

  async configureLocal(id: string, profile: QualityProfile): Promise<void> {
    const local = this.local.get(id);
    if (!local?.profile) throw new Error("capture_unavailable");
    const previous = local.profile;
    const current = () => this.local.get(id) === local;
    const senders = (settings: QualityProfile) => [...this.peers.values()].flatMap(peer => peer.plan.outgoing
      .filter(flow => flow.publicationId === id && flow.inputFlowId === null)
      .map(flow => peer.transport.configureVideo(flow.id, settings)));
    try {
      await applyCaptureProfile(local.stream, profile);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      const applied = await Promise.allSettled(senders(profile));
      const failure = applied.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      local.profile = profile;
      this.refresh();
    } catch (error) {
      if (current()) {
        const restored = await Promise.allSettled([applyCaptureProfile(local.stream, previous), ...senders(previous)]);
        for (const result of restored) if (result.status === "rejected") console.warn("Channel source quality rollback failed", result.reason);
      }
      throw error;
    }
  }

  removeLocal(id: string): void {
    const stream = this.local.get(id)?.stream;
    this.local.delete(id);
    this.refresh();
    // Only the capture owner stops tracks. Forwarders close their sender, never the source.
    stream?.getTracks().forEach(track => track.stop());
  }

  update(sessionId: string, state: ChannelSnapshot): void {
    this.rooms = state.channel.rooms;
    this.publications = state.publications;
    this.subscriptions = state.subscriptions;
    const plans = new Map(state.pairs.map(plan => [plan.id, plan]));
    let released = false;
    for (const [id, peer] of this.peers) {
      if (!plans.has(id)) {
        this.peers.delete(id);
        released = this.closePeer(peer) || released;
      }
    }
    for (const plan of state.pairs) {
      let peer = this.peers.get(plan.id);
      if (!peer) {
        const transport = new ChannelTransport({
          polite: sessionId.localeCompare(plan.peerId) > 0,
          iceServers: state.iceServers,
          canReceiveVideoLayers: plan.canReceiveVideoLayers,
          send: payload => this.send({ type: "signal", pairId: plan.id, payload }),
          receive: (flowId, stream) => this.receive(plan.id, flowId, stream),
          retire: flowId => this.retire(plan.id, flowId),
          outgoingFailed: flowId => {
            if (this.peers.get(plan.id)?.plan.outgoing.some(flow => flow.id === flowId)) {
              this.send({ type: "flow_state", flowId, pairId: plan.id, state: "failed" });
            }
          },
          data: (kind, data) => { if (this.peers.get(plan.id)?.plan.rooms.length) this.data?.(plan.peerId, kind, data); },
          dataState: ready => this.dataState?.(plan.peerId, ready),
          bulkClosed: () => this.bulkClosed?.(plan.peerId),
          input: channel => this.input?.(plan.id, channel),
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
      peer.transport.setInputEnabled([...plan.incoming, ...plan.outgoing].some(flow => flow.selected
        && state.publications.some(publication => publication.id === flow.publicationId && publication.kind === "screen")));
      if (peer.transport.isBaseReady()) this.reportBase(peer, true);
      for (const [flowId, input] of peer.inputs) {
        if (!plan.incoming.some(flow => flow.id === flowId)) {
          input.release?.();
          peer.inputs.delete(flowId);
        } else {
          const flow = plan.incoming.find(flow => flow.id === flowId)!;
          if (this.publications.find(publication => publication.id === flow.publicationId)?.paused) {
            input.stopProof?.(); input.stopProof = undefined;
            input.stopQuality?.(); input.ready = false;
          } else this.prove(peer, flowId, input.stream);
        }
      }
    }
    this.refresh(released);
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

  sendData(peerId: string, kind: "control" | "chunk", data: string | Uint8Array, allowed?: () => boolean): Promise<void> {
    const peer = [...this.peers.values()].find(peer => peer.plan.peerId === peerId && peer.plan.rooms.length);
    if (!peer) return Promise.reject(new Error("peer_data_unavailable"));
    return peer.transport.sendData(kind, data, allowed).catch(error => {
      // Retiring this exact pair already notified the delivery owner. A late
      // send rejection must not retire a replacement to the same participant.
      if (this.peers.get(peer.plan.id) === peer) throw error;
    });
  }

  sendInput(peerId: string, frame: string): boolean {
    const peer = [...this.peers.values()].find(peer => peer.plan.peerId === peerId);
    return peer?.transport.sendInput(frame) ?? false;
  }

  private receive(pairId: string, flowId: string, stream: MediaStream): void {
    const peer = this.peers.get(pairId);
    if (!peer?.plan.incoming.some(flow => flow.id === flowId)) return;
    this.prove(peer, flowId, stream);
    this.refresh();
  }

  private retire(pairId: string, id: string): void {
    const peer = this.peers.get(pairId), input = peer?.inputs.get(id);
    if (!peer || !input) return;
    input.release?.();
    peer.inputs.delete(id);
    const publicationId = peer.plan.incoming.find(flow => flow.id === id)?.publicationId;
    if (input.ready && this.publications.find(publication => publication.id === publicationId)?.kind === "screen") {
      this.send({ type: "flow_state", flowId: id, pairId, state: "failed" });
    }
    this.refresh();
  }

  private prove(peer: Peer, id: string, stream: MediaStream): void {
    if (!peer.transport.hasRemoteStream(id, stream)) return;
    const publicationId = peer.plan.incoming.find(flow => flow.id === id)?.publicationId;
    const publication = this.publications.find(publication => publication.id === publicationId);
    const kind = publication?.kind;
    if (!kind) return;
    const video = kind === "screen" ? stream.getVideoTracks().find(track => track.readyState !== "ended") : undefined;
    const receiver = video ? peer.transport.pc.getReceivers().find(candidate => candidate.track === video) : undefined;
    const previous = peer.inputs.get(id);
    const input: MediaInput = previous && previous.stream === stream && previous.video === video && previous.receiver === receiver
      ? previous : { stream, video, receiver, ready: false };
    if (input !== previous) {
      previous?.release?.();
      peer.inputs.set(id, input);
      const changed = () => {
        if (this.peers.get(peer.plan.id) !== peer || peer.inputs.get(id) !== input) return;
        this.prove(peer, id, stream);
        this.refresh();
      };
      if (kind === "screen") {
        stream.addEventListener("removetrack", changed);
        video?.addEventListener("ended", changed);
      }
      input.release = () => {
        input.codecProbe?.abort();
        input.stopProof?.();
        input.stopQuality?.();
        if (kind === "screen") {
          stream.removeEventListener("removetrack", changed);
          video?.removeEventListener("ended", changed);
        }
      };
      if (kind === "screen" && previous?.ready && !video) {
        this.send({ type: "flow_state", flowId: id, pairId: peer.plan.id, state: "failed" });
      }
    }
    if (publication?.paused || input.ready || input.stopProof || input.failed) return;
    const owned = () => this.ownsInput(peer, id, input) && (kind !== "screen" || receiver !== undefined);
    const ready = () => {
      if (!owned()) return true;
      if (peer.transport.pc.connectionState !== "connected") return false;
      input.ready = true;
      input.stopProof = undefined;
      this.send({ type: "flow_state", flowId: id, pairId: peer.plan.id, state: kind === "screen" ? "decoded" : "forwardable" });
      this.refresh();
      return true;
    };
    if (kind === "voice") {
      ready();
      return;
    }
    if (!video || !receiver) return;
    const baseline = peer.transport.frameBaseline(id);
    input.stopProof = observeDecodedFrameProof({
      owns: owned,
      requireProgress: baseline === null || previous?.receiver === receiver,
      readFramesDecoded: async () => {
        const samples = decodedVideoFrameSamples(await receiver.getStats());
        const sample = samples.length === 1 ? samples[0] : undefined;
        if (!sample || sample.framesDecoded === null) return null;
        return baseline === null ? sample.framesDecoded : Math.max(0, sample.framesDecoded - (baseline.get(sample.id) ?? 0));
      },
      onProof: ready,
    });
  }

  private ownsInput(peer: Peer, flowId: string, input: MediaInput): boolean {
    return this.peers.get(peer.plan.id) === peer && peer.plan.incoming.some(flow => flow.id === flowId)
      && peer.inputs.get(flowId) === input && peer.transport.hasRemoteStream(flowId, input.stream)
      && (!input.video || (input.receiver !== undefined && input.receiver.track === input.video
        && input.stream.getVideoTracks().find(track => track.readyState === "live") === input.video
        && peer.transport.pc.getReceivers().includes(input.receiver)));
  }

  private selectedInput(publicationId: string): { peer: Peer; flowId: string; input: MediaInput } | null {
    for (const peer of this.peers.values()) {
      const flow = peer.plan.incoming.find(flow => flow.publicationId === publicationId && flow.selected);
      const input = flow && peer.inputs.get(flow.id);
      if (flow && input && !input.failed) return { peer, flowId: flow.id, input };
    }
    return null;
  }

  screenPresentation(flowId: string, stream: MediaStream, state: ScreenPresentation): void {
    for (const peer of this.peers.values()) {
      const flow = peer.plan.incoming.find(flow => flow.id === flowId && !flow.selected);
      const input = peer.inputs.get(flowId);
      if (!flow || !input || input.stream !== stream || input.failed || !this.subscriptions.includes(flow.publicationId)) continue;
      if (state === "failed") {
        input.failed = true;
        input.release?.();
        this.send({ type: "flow_state", flowId, pairId: peer.plan.id, state: "failed" });
        this.refresh();
      } else if (!input.switchReady) {
        input.presentationReady = state === "prepared";
        this.switchReady(peer, flowId, input);
      }
      return;
    }
  }

  private switchReady(peer: Peer, flowId: string, input: MediaInput): void {
    const flow = peer.plan.incoming.find(flow => flow.id === flowId && !flow.selected);
    if (input.failed || input.switchReady || !input.ready || !input.qualityApproved || !input.presentationReady
      || !flow || !this.subscriptions.includes(flow.publicationId) || !this.ownsInput(peer, flowId, input) || this.selectedInput(flow.publicationId)?.input !== input.incumbent
      || peer.transport.pc.connectionState !== "connected") return;
    input.switchReady = true;
    input.stopQuality?.();
    this.send({ type: "flow_state", flowId, pairId: peer.plan.id, state: "switch_ready" });
    this.refresh();
  }

  private compareCandidate(peer: Peer, flowId: string, publicationId: string, input: MediaInput): void {
    if (input.failed || input.switchReady || !input.ready || !input.video || !input.receiver) return;
    const current = this.selectedInput(publicationId);
    if (!current?.input.video || !current.input.receiver) return;
    if (input.stopQuality && input.incumbent === current.input) return;
    input.stopQuality?.();
    input.incumbent = current.input;
    input.qualityApproved = false;
    const probe = new P2pQualityProbe(), candidateStats = createStatsAccumulator(), currentStats = createStatsAccumulator();
    const video = input.video, incumbentVideo = current.input.video;
    let active = true, timer: ReturnType<typeof setTimeout> | null = null;
    const owns = () => active && this.ownsInput(peer, flowId, input) && this.ownsInput(current.peer, current.flowId, current.input)
      && peer.plan.incoming.some(flow => flow.id === flowId && !flow.selected)
      && this.selectedInput(publicationId)?.input === current.input && input.video === video
      && video.readyState === "live" && incumbentVideo.readyState === "live";
    const stop = () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      if (input.stopQuality === stop) input.stopQuality = undefined;
    };
    input.stopQuality = stop;
    const poll = async () => {
      if (!owns()) { stop(); return; }
      const samples = await Promise.all([
          collectConnectionMetrics(current.peer.transport.pc, "receive", currentStats, { trackIdentifier: incumbentVideo.id }),
          collectConnectionMetrics(peer.transport.pc, "receive", candidateStats, { trackIdentifier: video.id }),
      ]).catch(() => null);
      if (!owns()) { stop(); return; }
      if (samples) {
        const [incumbent, candidate] = samples;
        const result = probe.observe(current.peer.transport.pc.connectionState === "connected" && peer.transport.pc.connectionState === "connected"
          ? incumbent : null, candidate);
        input.qualityApproved = result === "approved";
        if (result === "rejected") {
          this.screenPresentation(flowId, input.stream, "failed");
          return;
        }
        this.switchReady(peer, flowId, input);
      } else {
        // Missing observation remains pending under the room's operation deadline.
        input.qualityApproved = false;
        probe.reset();
      }
      if (owns()) timer = setTimeout(() => { timer = null; void poll(); }, VIEWER_QUALITY_EVIDENCE_INTERVAL_MS);
    };
    void poll();
  }

  private refresh(released = false): void {
    const streams = new Map([...this.local].map(([id, local]) => [id, local.stream]));
    const relayAudio = new Map<string, MediaStreamTrack[]>();
    for (const publication of this.publications) {
      if (this.local.has(publication.id)) continue;
      const current = this.selectedInput(publication.id);
      if (!current) continue;
      streams.set(publication.id, current.input.stream);
    }
    const outgoingByPeer = new Map<ChannelTransport, Map<string, OutgoingMedia>>();
    for (const peer of this.peers.values()) {
      const outgoing = new Map<string, OutgoingMedia>();
      for (const flow of peer.plan.outgoing) {
        const publication = this.publications.find(publication => publication.id === flow.publicationId);
        if (!publication) continue;
        const local = flow.inputFlowId === null ? this.local.get(flow.publicationId) : undefined;
        let stream = local?.stream;
        let codec = local?.codec ?? VP8_ONLY_VIDEO_CODEC;
        if (flow.inputFlowId !== null) for (const source of this.peers.values()) {
          if (!source.plan.incoming.some(input => input.id === flow.inputFlowId && input.publicationId === flow.publicationId)) continue;
          const input = source.inputs.get(flow.inputFlowId);
          if (input && !input.failed) {
            stream = input.stream;
            if (publication.kind === "screen" && input.video && !input.codec && !input.codecProbe) {
              // Send immediately; a late preference is only for new senders.
              const probe = input.codecProbe = new AbortController();
              void preferredVideoCodecForTrack(input.video, probe.signal).then(value => {
                if (probe.signal.aborted) return;
                input.codec = automaticVideoCodecPreference(value);
                this.refresh();
              }).catch(() => {});
            }
            if (input.codec) codec = input.codec;
          }
          break;
        }
        outgoing.set(flow.id, { kind: publication.kind, stream: stream ?? null, profile: local?.profile, codec, paused: publication.paused,
          voiceBitrate: this.rooms.find(room => room.id === publication.roomId)?.voiceBitrate });
        if (stream && flow.inputFlowId !== null) {
          const tracks = stream.getAudioTracks().filter(track => track.readyState !== "ended");
          if (tracks.length) relayAudio.set(flow.inputFlowId, tracks);
        }
      }
      outgoingByPeer.set(peer.transport, outgoing);
      released = peer.transport.setOutgoing(outgoing) || released;
    }
    // All pairs share this participant's actual resources. Failure rollback
    // does not report a release; only normal retirement permits another try.
    if (released) for (const [transport, outgoing] of outgoingByPeer) transport.setOutgoing(outgoing, true);
    this.syncRelayAudio(relayAudio);
    const changed = streams.size !== this.streams.size || [...streams].some(([id, stream]) => this.streams.get(id) !== stream);
    this.streams = streams;
    const screenInputs = new Map<string, ChannelScreenInput[]>();
    for (const peer of this.peers.values()) for (const flow of peer.plan.incoming) {
      if (this.publications.find(publication => publication.id === flow.publicationId)?.kind !== "screen") continue;
      const input = peer.inputs.get(flow.id);
      if (!input || input.failed) continue;
      if (!flow.selected && !this.subscriptions.includes(flow.publicationId)) { input.stopQuality?.(); continue; }
      const values = screenInputs.get(flow.publicationId) ?? [];
      values.push({ flowId: flow.id, stream: input.stream, selected: flow.selected, switchReady: !!input.switchReady });
      screenInputs.set(flow.publicationId, values);
      if (flow.selected || this.publications.find(publication => publication.id === flow.publicationId)?.paused) { input.stopQuality?.(); input.incumbent = undefined; }
      else this.compareCandidate(peer, flow.id, flow.publicationId, input);
    }
    if (changed || screenInputs.size || this.screenInputs.size) this.changed(new Map(streams), screenInputs);
    this.screenInputs = screenInputs;
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

  private closePeer(peer: Peer): boolean {
    for (const input of peer.inputs.values()) input.release?.();
    return peer.transport.close();
  }

  reset(): void {
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
    for (const id of [...this.local.keys()]) this.removeLocal(id);
    this.refresh();
  }
}
