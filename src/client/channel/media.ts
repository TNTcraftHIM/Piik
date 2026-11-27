import { observeDecodedFrameProof } from "../media/decoded-frame-proof";
import { collectConnectionMetrics, collectTrackConnectionMetrics, createStatsAccumulator, decodedVideoFrameSamples, type StatsAccumulator } from "../webrtc/stats";
import { P2pQualityProbe } from "../media/candidate-quality-probe";
import { VIEWER_QUALITY_EVIDENCE_INTERVAL_MS } from "../../shared/protocol";
import type { ChannelCommand, ChannelPair, ChannelSignal, ChannelSnapshot } from "./protocol";
import type { ChannelMediaMetric, ChannelMediaMetrics, ChannelScreenInput, ScreenPresentation, ScreenBufferStatus } from "./types";
import { ChannelTransport, type OutgoingMedia } from "./transport";
import { applyCaptureProfile, screenAudioBitrate, screenContentHint, type QualityProfile } from "../media/quality";
import { automaticVideoCodecPreference, VP8_ONLY_VIDEO_CODEC, type BrowserVideoCodecPreference } from "../webrtc/video-codec";
import { preferredVideoCodecForTrack } from "../webrtc/video-codec-preflight";
import { BrowserEncodingPool } from "../media/browser-encoding-pool";
import { browserDebugEnabled, debugEvent } from "../lib/debug";

interface Peer {
  plan: ChannelPair;
  transport: ChannelTransport;
  inputs: Map<string, MediaInput>;
  roomDataReady: Set<string>;
}

interface MediaInput {
  stream: MediaStream;
  video: MediaStreamTrack | undefined;
  audio: MediaStreamTrack | undefined;
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
  metrics?: Map<string, StatsAccumulator>;
}

export class ChannelMedia {
  private screenBufferTargetMs: number | null = null;
  // A null runtime records a failed acquisition for a still-admitted pair.
  private peers = new Map<string, Peer | null>();
  private publications: ChannelSnapshot["publications"] = [];
  private subscriptions: ChannelSnapshot["subscriptions"] = [];
  private rooms: ChannelSnapshot["channel"]["rooms"] = [];
  private local = new Map<string, { stream: MediaStream; profile?: QualityProfile; codec?: BrowserVideoCodecPreference; paused?: boolean }>();
  private streams = new Map<string, MediaStream>();
  private screenInputs = new Map<string, ChannelScreenInput[]>();
  private relayMedia = new Map<string, { tracks: MediaStreamTrack[]; player: HTMLMediaElement }>();
  private videoPool = new BrowserEncodingPool();

  constructor(private send: (command: ChannelCommand) => void,
    private changed: (streams: ReadonlyMap<string, MediaStream>, screenInputs: ReadonlyMap<string, readonly ChannelScreenInput[]>) => void,
    private data?: (peer: string, kind: "control" | "chunk", data: string | Uint8Array) => void,
    private dataState?: (peer: string, ready: boolean) => void,
    private bulkClosed?: (peer: string) => void,
    private input?: (pairId: string, channel: RTCDataChannel | null) => void,
    private buffering?: { target: number | null; isLocalScreen?(publicationId: string): boolean; changed(status: ScreenBufferStatus): void }) {
    this.screenBufferTargetMs = buffering?.target ?? null;
  }

  private *peerRuntimes(): IterableIterator<Peer> {
    for (const peer of this.peers.values()) if (peer) yield peer;
  }

  setScreenBufferTarget(target: number | null): void {
    this.screenBufferTargetMs = target;
    this.applyScreenBufferTarget();
  }

  private applyScreenBufferTarget(): void {
    let status: ScreenBufferStatus = null;
    for (const peer of this.peerRuntimes()) for (const [id, input] of peer.inputs) {
      const publicationId = peer.plan.incoming.find(flow => flow.id === id)?.publicationId;
      const publication = this.publications.find(publication => publication.id === publicationId);
      if (!publication) continue;
      const viewerScreen = publication.kind === "screen" && !this.buffering?.isLocalScreen?.(publication.id);
      for (const receiver of peer.transport.pc.getReceivers()) {
        if (!input.stream.getTracks().includes(receiver.track)) continue;
        if (!("jitterBufferTarget" in receiver)) {
          if (viewerScreen && status !== "failed") status = "unsupported";
          continue;
        }
        try {
          const buffered = receiver as RTCRtpReceiver & { jitterBufferTarget: number | null };
          // Native forwarding may reuse an audio MID from a screen for room voice.
          const target = viewerScreen ? this.screenBufferTargetMs : null;
          if (buffered.jitterBufferTarget !== target) buffered.jitterBufferTarget = target;
          if (viewerScreen) status ??= "supported";
        } catch { if (viewerScreen) status = "failed"; }
      }
    }
    this.buffering?.changed(status);
  }

  setLocal(id: string, stream: MediaStream, profile?: QualityProfile, codec?: BrowserVideoCodecPreference, paused = this.local.get(id)?.paused): void {
    this.local.set(id, { stream, profile, codec, paused });
    this.refresh();
  }

  localProfile(id: string): QualityProfile | undefined {
    return this.local.get(id)?.profile;
  }

  setLocalPaused(id: string, paused: boolean): void {
    const local = this.local.get(id);
    if (!local) return;
    local.paused = paused;
    this.refresh();
  }

  async configureLocal(id: string, profile: QualityProfile): Promise<void> {
    const local = this.local.get(id);
    if (!local?.profile) throw new Error("capture_unavailable");
    const previous = local.profile;
    const current = () => this.local.get(id) === local;
    const senders = (settings: QualityProfile) => [...this.peerRuntimes()].flatMap(peer => peer.plan.outgoing
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

  async configureLocalAudio(id: string, bitrate: number): Promise<void> {
    const local = this.local.get(id);
    if (!local?.profile) throw new Error("capture_unavailable");
    if (local.profile.maxAudioBitrate === bitrate) return;
    const previous = screenAudioBitrate(local.profile.maxAudioBitrate);
    const current = () => this.local.get(id) === local;
    const senders = (value: number) => [...this.peerRuntimes()].flatMap(peer => peer.plan.outgoing
      .filter(flow => flow.publicationId === id && flow.inputFlowId === null)
      .map(flow => peer.transport.configureAudio(flow.id, value)));
    try {
      const applied = await Promise.allSettled(senders(bitrate));
      const failure = applied.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      local.profile = { ...local.profile, maxAudioBitrate: bitrate };
      this.refresh();
    } catch (error) {
      if (current()) {
        const restored = await Promise.allSettled(senders(previous));
        for (const result of restored) if (result.status === "rejected") console.warn("Channel source audio rollback failed", result.reason);
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
        if (peer) {
          this.recordAssignments(peer.plan);
          released = this.closePeer(peer) || released;
        }
      }
    }
    for (const plan of state.pairs) {
      let peer = this.peers.get(plan.id);
      if (peer === null) continue;
      if (!peer) {
        let transport: ChannelTransport;
        try {
          transport = new ChannelTransport({
            identity: { sessionId, pairId: plan.id, peerId: plan.peerId },
            polite: sessionId > plan.peerId,
            iceServers: state.iceServers,
            canReceiveVideoLayers: plan.canReceiveVideoLayers,
            videoPool: this.videoPool,
            send: payload => this.send({ type: "signal", pairId: plan.id, payload }),
            receive: (flowId, stream) => this.receive(plan.id, flowId, stream),
            retire: flowId => this.retire(plan.id, flowId),
            outgoingFailed: flowId => {
              if (this.peers.get(plan.id)?.plan.outgoing.some(flow => flow.id === flowId)) {
                this.send({ type: "flow_state", flowId, pairId: plan.id, state: "failed" });
              }
            },
            data: (kind, data) => {
              const current = this.peers.get(plan.id);
              if (current?.transport === transport && (kind === "control" || current.plan.rooms.length)) this.data?.(plan.peerId, kind, data);
            },
            dataState: ready => this.dataState?.(plan.peerId, ready),
            bulkClosed: () => this.bulkClosed?.(plan.peerId),
            input: channel => this.input?.(plan.id, channel),
            connected: () => {
              const current = this.peers.get(plan.id);
              if (current?.transport === transport) this.reportConnected(current);
            },
            disconnected: () => {
              if (this.peers.get(plan.id)?.transport === transport) {
                this.send({ type: "link_state", pairId: plan.id, state: "disconnected" });
              }
            },
            failed: released => {
              const current = this.peers.get(plan.id);
              if (current?.transport !== transport) return;
              this.closePeer(current);
              this.send({ type: "link_state", pairId: plan.id, state: "failed" });
              this.refresh(released);
            },
            roomData: ready => {
              const current = this.peers.get(plan.id);
              if (current) this.reportRoomData(current, ready);
            },
          });
        } catch (error) {
          this.peers.set(plan.id, null);
          console.warn("Channel peer connection could not be created", error);
          this.send({ type: "link_state", pairId: plan.id, state: "failed" });
          continue;
        }
        peer = { plan, transport, inputs: new Map(), roomDataReady: new Set() };
        this.peers.set(plan.id, peer);
        this.recordAssignments(undefined, plan);
      } else {
        this.recordAssignments(peer.plan, plan);
        peer.plan = plan;
      }
      for (const room of peer.roomDataReady) if (!plan.rooms.includes(room)) peer.roomDataReady.delete(room);
      try {
        peer.transport.setRooms(plan.rooms);
        const probe = !plan.rooms.length && !plan.incoming.length && !plan.outgoing.length;
        peer.transport.setInputEnabled([...plan.incoming, ...plan.outgoing].some(flow => flow.selected
          && state.publications.some(publication => publication.id === flow.publicationId && publication.kind === "screen")), probe);
      } catch (error) {
        // Browser RTC setup is a pair failure, not an invalid Domain frame.
        console.warn("Channel peer data channels could not be created", error);
        released = this.closePeer(peer) || released;
        this.send({ type: "link_state", pairId: plan.id, state: "failed" });
        continue;
      }
      if (peer.transport.isRoomDataReady()) this.reportRoomData(peer, true);
      for (const [flowId, input] of peer.inputs) {
        if (!plan.incoming.some(flow => flow.id === flowId)) {
          input.release?.();
          peer.inputs.delete(flowId);
        } else {
          const flow = plan.incoming.find(flow => flow.id === flowId)!;
          if (this.publications.find(publication => publication.id === flow.publicationId)?.paused) {
            input.stopProof?.(); input.stopProof = undefined;
            input.stopQuality?.(); input.ready = false;
            input.codecProbe?.abort(); input.codecProbe = undefined;
          } else this.prove(peer, flowId, input.stream);
        }
      }
    }
    this.refresh(released);
  }

  private reportRoomData(peer: Peer, ready: boolean): void {
    for (const roomId of peer.plan.rooms) {
      if (ready && peer.roomDataReady.has(roomId)) continue;
      if (ready) peer.roomDataReady.add(roomId); else peer.roomDataReady.delete(roomId);
      this.send({ type: "room_data_state", roomId, pairId: peer.plan.id, ready });
    }
  }

  signal(pairId: string, payload: ChannelSignal): void {
    this.peers.get(pairId)?.transport.signal(payload);
  }

  resync(): void {
    for (const [pairId, peer] of this.peers) {
      if (!peer || ["failed", "closed"].includes(peer.transport.pc.connectionState)) {
        this.send({ type: "link_state", pairId, state: "failed" });
      } else {
        peer.roomDataReady.clear();
        if (peer.transport.pc.connectionState === "connected") this.reportConnected(peer);
        else {
          if (peer.transport.pc.connectionState === "disconnected") {
            this.send({ type: "link_state", pairId: peer.plan.id, state: "disconnected" });
          }
          for (const [id, input] of peer.inputs) this.reportInput(peer, id, input);
        }
        peer.transport.resync();
      }
    }
  }

  sendData(peerId: string, kind: "control" | "chunk", data: string | Uint8Array, allowed?: () => boolean, request?: string): Promise<void> {
    const peer = [...this.peerRuntimes()].find(peer => peer.plan.peerId === peerId && peer.plan.rooms.length);
    if (!peer) return Promise.reject(new Error("peer_data_unavailable"));
    return peer.transport.sendData(kind, data, allowed, request).catch(error => {
      // Retiring this exact pair already notified the delivery owner. A late
      // send rejection must not retire a replacement to the same participant.
      if (this.peers.get(peer.plan.id) === peer) throw error;
    });
  }

  cancelChunks(peerId: string, request: string): void {
    for (const peer of this.peerRuntimes()) if (peer.plan.peerId === peerId) peer.transport.cancelChunks(request);
  }

  sendInput(peerId: string, frame: string): boolean {
    const peer = [...this.peerRuntimes()].find(peer => peer.plan.peerId === peerId);
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
    // SDP withdrawal retires this media input, not the authority-owned flow.
    this.refresh();
  }

  private prove(peer: Peer, id: string, stream: MediaStream): void {
    if (!peer.transport.hasRemoteStream(id, stream)) return;
    const publicationId = peer.plan.incoming.find(flow => flow.id === id)?.publicationId;
    const publication = this.publications.find(publication => publication.id === publicationId);
    const kind = publication?.kind;
    if (!kind) return;
    const video = kind === "screen" ? stream.getVideoTracks().find(track => track.readyState !== "ended") : undefined;
    const audio = kind === "voice" ? stream.getAudioTracks().find(track => track.readyState === "live") : undefined;
    const track = video ?? audio;
    const receiver = video ? peer.transport.pc.getReceivers().find(candidate => candidate.track === video) : undefined;
    const previous = peer.inputs.get(id);
    const input: MediaInput = previous && previous.stream === stream && previous.video === video && previous.audio === audio && previous.receiver === receiver
      ? previous : { stream, video, audio, receiver, ready: false };
    if (input !== previous) {
      previous?.release?.();
      peer.inputs.set(id, input);
      const changed = () => {
        if (this.peers.get(peer.plan.id) !== peer || peer.inputs.get(id) !== input) return;
        this.prove(peer, id, stream);
        this.refresh();
      };
      stream.addEventListener("removetrack", changed);
      track?.addEventListener("ended", changed);
      input.release = () => {
        input.codecProbe?.abort();
        input.stopProof?.();
        input.stopQuality?.();
        stream.removeEventListener("removetrack", changed);
        track?.removeEventListener("ended", changed);
      };
      if (!track && previous?.stream === stream && (previous.video || previous.audio)) {
        input.failed = true;
        this.reportInput(peer, id, input);
      }
    }
    if (publication?.paused || input.ready || input.stopProof || input.failed) return;
    const owned = () => this.ownsInput(peer, id, input) && (kind !== "screen" || receiver !== undefined);
    const ready = () => {
      if (!owned()) return true;
      if (peer.transport.pc.connectionState !== "connected") return false;
      input.ready = true;
      input.stopProof = undefined;
      this.reportInput(peer, id, input);
      this.refresh();
      return true;
    };
    if (kind === "voice") {
      if (audio) ready();
      return;
    }
    if (!video || !receiver) return;
    const baseline = peer.transport.frameBaseline(id);
    input.stopProof = observeDecodedFrameProof({
      owns: owned,
      requireProgress: baseline === null || previous?.receiver === receiver,
      baseline,
      readFramesDecoded: async () => decodedVideoFrameSamples(await receiver.getStats()),
      onProof: ready,
    });
  }

  private ownsInput(peer: Peer, flowId: string, input: MediaInput): boolean {
    return this.peers.get(peer.plan.id) === peer && peer.plan.incoming.some(flow => flow.id === flowId)
      && peer.inputs.get(flowId) === input && peer.transport.hasRemoteStream(flowId, input.stream)
      && (!input.audio || (input.audio.readyState === "live" && input.stream.getAudioTracks().includes(input.audio)))
      && (!input.video || (input.receiver !== undefined && input.receiver.track === input.video
        && input.stream.getVideoTracks().find(track => track.readyState === "live") === input.video
        && peer.transport.pc.getReceivers().includes(input.receiver)));
  }

  private reportInput(peer: Peer, flowId: string, input: MediaInput): void {
    const flow = peer.plan.incoming.find(flow => flow.id === flowId);
    const kind = this.publications.find(publication => publication.id === flow?.publicationId)?.kind;
    if (!flow || !kind || !this.ownsInput(peer, flowId, input)) return;
    let state: Extract<ChannelCommand, { type: "flow_state" }>["state"];
    if (input.failed) state = "failed";
    else {
      if (!input.ready || peer.transport.pc.connectionState !== "connected") return;
      state = kind === "screen" ? "decoded" : "forwardable";
      input.switchReady = false;
      input.qualityApproved = false;
    }
    this.send({ type: "flow_state", flowId, pairId: peer.plan.id, state });
  }

  private reportConnected(peer: Peer): void {
    this.send({ type: "link_state", pairId: peer.plan.id, state: "connected" });
    for (const [id, input] of peer.inputs) {
      this.reportInput(peer, id, input);
      this.prove(peer, id, input.stream);
    }
  }

  private selectedInput(publicationId: string): { peer: Peer; flowId: string; input: MediaInput } | null {
    for (const peer of this.peerRuntimes()) {
      const flow = peer.plan.incoming.find(flow => flow.publicationId === publicationId && flow.selected);
      const input = flow && peer.inputs.get(flow.id);
      if (flow && input && !input.failed) return { peer, flowId: flow.id, input };
    }
    return null;
  }

  screenPresentation(flowId: string, stream: MediaStream, state: ScreenPresentation, onSelectedFailure?: (id: string) => void): void {
    for (const peer of this.peerRuntimes()) {
      const flow = peer.plan.incoming.find(flow => flow.id === flowId);
      const input = peer.inputs.get(flowId);
      if (!flow || !input || input.stream !== stream || input.failed || !this.subscriptions.includes(flow.publicationId)
        || !this.ownsInput(peer, flowId, input)) continue;
      if (state === "failed") {
        if (onSelectedFailure && this.selectedInput(flow.publicationId)?.input === input) onSelectedFailure(flow.publicationId);
        input.failed = true;
        input.release?.();
        this.reportInput(peer, flowId, input);
        this.refresh();
      } else if (!flow.selected && !input.switchReady) {
        input.presentationReady = state === "prepared";
        this.switchReady(peer, flowId, input);
      }
      return;
    }
  }

  private switchReady(peer: Peer, flowId: string, input: MediaInput): void {
    const flow = peer.plan.incoming.find(flow => flow.id === flowId && !flow.selected);
    if (input.failed || !input.ready || !input.qualityApproved || !input.presentationReady
      || !flow || !this.subscriptions.includes(flow.publicationId) || !this.ownsInput(peer, flowId, input) || this.selectedInput(flow.publicationId)?.input !== input.incumbent
      || peer.transport.pc.connectionState !== "connected") return;
    const alreadyReady = input.switchReady;
    input.switchReady = true;
    this.send({ type: "flow_state", flowId, pairId: peer.plan.id, state: "switch_ready" });
    if (!alreadyReady) this.refresh();
  }

  private compareCandidate(peer: Peer, flowId: string, publicationId: string, input: MediaInput): void {
    if (input.failed || !input.ready || !input.video || !input.receiver) return;
    const current = this.selectedInput(publicationId);
    if (!current?.input.video || !current.input.receiver) return;
    if (input.stopQuality && input.incumbent === current.input) return;
    input.stopQuality?.();
    if (input.switchReady) this.reportInput(peer, flowId, input);
    input.incumbent = current.input;
    input.qualityApproved = false;
    const probe = new P2pQualityProbe(), candidateStats = createStatsAccumulator(), currentStats = createStatsAccumulator();
    const video = input.video, incumbentVideo = current.input.video;
    let lastCurrentTimestamp: number | null = null, lastCandidateTimestamp: number | null = null;
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
      let fresh = true;
      if (samples) {
        const [incumbent, candidate] = samples;
        fresh = incumbent.sampleTimestampMs === null || candidate.sampleTimestampMs === null
          || !Number.isFinite(incumbent.sampleTimestampMs) || !Number.isFinite(candidate.sampleTimestampMs)
          || incumbent.sampleTimestampMs !== lastCurrentTimestamp || candidate.sampleTimestampMs !== lastCandidateTimestamp;
        if (fresh) {
          lastCurrentTimestamp = incumbent.sampleTimestampMs; lastCandidateTimestamp = candidate.sampleTimestampMs;
          const result = probe.observe(current.peer.transport.pc.connectionState === "connected" && peer.transport.pc.connectionState === "connected"
            ? incumbent : null, candidate);
          input.qualityApproved = result === "approved";
        }
      } else {
        // Missing observation remains pending under the room's operation deadline.
        input.qualityApproved = false;
        probe.reset();
      }
      // Only new quality evidence renews readiness; unchanged stats expire at the room owner.
      if (fresh) {
        if (input.qualityApproved) this.switchReady(peer, flowId, input);
        else if (input.switchReady) { this.reportInput(peer, flowId, input); this.refresh(); }
      }
      if (owns()) timer = setTimeout(() => { timer = null; void poll(); }, VIEWER_QUALITY_EVIDENCE_INTERVAL_MS);
    };
    void poll();
  }

  private refresh(released = false): void {
    this.applyScreenBufferTarget();
    const streams = new Map([...this.local].map(([id, local]) => [id, local.stream]));
    const relayMedia = new Map<string, MediaStreamTrack[]>();
    for (const publication of this.publications) {
      if (this.local.has(publication.id)) continue;
      const current = this.selectedInput(publication.id);
      if (!current) continue;
      streams.set(publication.id, current.input.stream);
    }
    const outgoingByPeer = new Map<ChannelTransport, Map<string, OutgoingMedia>>();
    for (const peer of this.peerRuntimes()) {
      const outgoing = new Map<string, OutgoingMedia>();
      for (const flow of peer.plan.outgoing) {
        const publication = this.publications.find(publication => publication.id === flow.publicationId);
        if (!publication) continue;
        const local = flow.inputFlowId === null ? this.local.get(flow.publicationId) : undefined;
        const settings = local?.profile ?? (publication.videoSettings && { ...publication.videoSettings.ceiling, degradationPreference: publication.videoSettings.degradationPreference });
        const profile = settings && { ...settings, displaySource: publication.source?.kind === "screen" };
        let stream = local?.stream;
        let codec = local?.codec ?? VP8_ONLY_VIDEO_CODEC;
        if (flow.inputFlowId !== null) for (const source of this.peerRuntimes()) {
          if (!source.plan.incoming.some(input => input.id === flow.inputFlowId && input.publicationId === flow.publicationId)) continue;
          const input = source.inputs.get(flow.inputFlowId);
          if (input && !input.failed) {
            const tracks = input.stream.getTracks().filter(track => track.readyState !== "ended");
            if (tracks.length) relayMedia.set(flow.inputFlowId, tracks);
            stream = publication.kind !== "screen" || input.codec ? input.stream : undefined;
            if (publication.kind === "screen" && input.ready && !publication.paused && input.video && !input.codec && !input.codecProbe) {
              const probe = input.codecProbe = new AbortController();
              void preferredVideoCodecForTrack(input.video, probe.signal, screenContentHint(profile?.degradationPreference, profile?.displaySource)).then(value => {
                if (input.codecProbe !== probe || probe.signal.aborted || !this.ownsInput(source, flow.inputFlowId!, input)) return;
                input.codec = automaticVideoCodecPreference(value);
                this.refresh();
              }).catch(() => {});
            }
            if (input.codec) codec = input.codec;
          }
          break;
        }
        outgoing.set(flow.id, { kind: publication.kind, stream: stream ?? null,
          profile,
          audioBitrate: local?.profile?.maxAudioBitrate, codec, paused: local?.paused ?? publication.paused,
          voiceBitrate: this.rooms.find(room => room.id === publication.roomId)?.voiceBitrate });
      }
      outgoingByPeer.set(peer.transport, outgoing);
      released = peer.transport.setOutgoing(outgoing) || released;
    }
    // All pairs share this participant's actual resources. Failure rollback
    // does not report a release; only normal retirement permits another try.
    if (released) for (const [transport, outgoing] of outgoingByPeer) transport.setOutgoing(outgoing, true);
    this.syncRelayMedia(relayMedia);
    const streamsChanged = streams.size !== this.streams.size || [...streams].some(([id, stream]) => this.streams.get(id) !== stream);
    const screenInputs = new Map<string, ChannelScreenInput[]>();
    for (const peer of this.peerRuntimes()) for (const flow of peer.plan.incoming) {
      const publication = this.publications.find(publication => publication.id === flow.publicationId);
      if (publication?.kind !== "screen") continue;
      const input = peer.inputs.get(flow.id);
      if (!input || input.failed) continue;
      if (!flow.selected && !this.subscriptions.includes(flow.publicationId)) { input.stopQuality?.(); continue; }
      const values = screenInputs.get(flow.publicationId) ?? [];
      values.push({ flowId: flow.id, stream: input.stream, selected: flow.selected, switchReady: !!input.switchReady });
      screenInputs.set(flow.publicationId, values);
      if (flow.selected || publication.paused) { input.stopQuality?.(); input.incumbent = undefined; }
      else this.compareCandidate(peer, flow.id, flow.publicationId, input);
    }
    let inputsChanged = screenInputs.size !== this.screenInputs.size;
    for (const [id, inputs] of screenInputs) {
      const previous = this.screenInputs.get(id);
      if (previous?.length === inputs.length && inputs.every((input, index) => {
        const last = previous[index];
        return input.flowId === last.flowId && input.stream === last.stream
          && input.selected === last.selected && input.switchReady === last.switchReady;
      })) screenInputs.set(id, previous);
      else inputsChanged = true;
    }
    if (!streamsChanged && !inputsChanged) return;
    if (streamsChanged) this.streams = streams;
    if (inputsChanged) this.screenInputs = screenInputs;
    this.changed(this.streams, this.screenInputs);
  }

  private syncRelayMedia(needed: ReadonlyMap<string, MediaStreamTrack[]>): void {
    for (const [id, binding] of this.relayMedia) {
      const tracks = needed.get(id);
      if (tracks?.length === binding.tracks.length && tracks.every((track, index) => track === binding.tracks[index])) continue;
      binding.player.pause();
      binding.player.srcObject = null;
      binding.player.remove();
      this.relayMedia.delete(id);
    }
    for (const [id, tracks] of needed) if (!this.relayMedia.has(id)) {
      // Received media needs a playback consumer independent of local watching.
      const video = tracks.some(track => track.kind === "video");
      const player = video ? document.createElement("video") : new Audio();
      if (video) (player as HTMLVideoElement).playsInline = true;
      player.autoplay = true; player.hidden = true; player.muted = true;
      player.srcObject = new MediaStream(tracks);
      this.relayMedia.set(id, { tracks, player });
      document.body.append(player);
      void player.play().catch(error => {
        if (this.relayMedia.get(id)?.player === player && error?.name !== "AbortError") {
          console.warn("Channel relay media could not start", error);
        }
      });
    }
  }

  async voiceActivity(roomId: string): Promise<ReadonlyMap<string, number>> {
    const levels = new Map<string, number>();
    const incoming = (peer: Peer) => peer.plan.incoming.flatMap(flow => {
      const publication = this.publications.find(value => value.id === flow.publicationId && value.roomId === roomId
        && value.kind === "voice" && !value.paused && this.subscriptions.includes(value.id));
      const input = peer.inputs.get(flow.id), track = input?.audio;
      return flow.selected && publication && input?.ready && track && this.ownsInput(peer, flow.id, input)
        ? [{ flowId: flow.id, publication, input, track }] : [];
    });
    const samples = await Promise.all([...this.peerRuntimes()].map(async peer => {
      const bindings = peer.transport.pc.connectionState === "connected" ? incoming(peer) : [];
      if (!bindings.length) return null;
      const stats = await peer.transport.pc.getStats().catch(() => null);
      return stats ? { peer, bindings, stats } : null;
    }));
    for (const sample of samples) {
      if (!sample) continue;
      const { peer, bindings, stats } = sample;
      if (this.peers.get(peer.plan.id) !== peer || peer.transport.pc.connectionState !== "connected") continue;
      for (const current of incoming(peer)) {
        if (!bindings.some(binding => binding.flowId === current.flowId && binding.input === current.input && binding.track === current.track)) continue;
        for (const row of stats.values()) if (row.type === "inbound-rtp" && row.kind === "audio" && row.trackIdentifier === current.track.id
          && Number.isFinite(row.audioLevel)) {
          levels.set(current.publication.sessionId, Math.max(levels.get(current.publication.sessionId) ?? 0, Math.min(1, Math.max(0, row.audioLevel))));
        }
      }
    }
    return levels;
  }

  async stats(): Promise<Array<{ pairId: string; peerId: string; reports: Record<string, unknown>[] }>> {
    return Promise.all([...this.peerRuntimes()].map(async peer => {
      const values: Record<string, unknown>[] = [];
      (await peer.transport.pc.getStats()).forEach(report => values.push(report));
      return { pairId: peer.plan.id, peerId: peer.plan.peerId, reports: values };
    }));
  }

  async connectionMetrics(roomId: string, publicationId?: string): Promise<ChannelMediaMetrics> {
    const inScope = (publication: ChannelSnapshot["publications"][number]) => publication.roomId === roomId
      && (publication.kind === "voice" || publicationId === undefined || publication.id === publicationId);
    const requested = new Set(this.publications.filter(inScope).map(publication => publication.id));
    const samples = await Promise.allSettled([...this.peerRuntimes()].map(async (peer): Promise<ChannelMediaMetric[]> => {
      const current = () => this.peers.get(peer.plan.id) === peer
        && [...peer.plan.incoming, ...peer.plan.outgoing].some(flow => flow.selected && requested.has(flow.publicationId));
      if (!current()) return [];
      const report = await peer.transport.pc.getStats().catch(error => { if (current()) throw error; return null; });
      if (!report || !current()) return [];
      const plan = peer.plan;
      const publications = new Map(this.publications.filter(inScope).map(publication => [publication.id, publication]));
      const incoming = plan.incoming.filter(flow => flow.selected && publications.has(flow.publicationId));
      const outgoing = plan.outgoing.filter(flow => flow.selected && publications.has(flow.publicationId));
      const sample = (flowId: string, direction: "send" | "receive", metrics: ChannelMediaMetric["metrics"]): ChannelMediaMetric => {
        const flow = (direction === "send" ? outgoing : incoming).find(flow => flow.id === flowId)!;
        return { pairId: plan.id, peerId: plan.peerId, flowId, publicationId: flow.publicationId, direction,
          media: publications.get(flow.publicationId)!.kind === "screen" ? "video" : "audio", metrics };
      };
      return [
        ...incoming.flatMap(flow => {
          const input = peer.inputs.get(flow.id);
          const kind = publications.get(flow.publicationId)!.kind === "screen" ? "video" : "audio";
          const track = kind === "video" ? input?.video : input?.stream.getAudioTracks()[0];
          if (!input || !track) return [];
          return collectTrackConnectionMetrics(report, "receive", input.metrics ??= new Map(), {
            kind, trackIdentifier: track.id, audioTrackIdentifier: input.stream.getAudioTracks()[0]?.id ?? null,
          }, peer.transport.pc).map(metrics => sample(flow.id, "receive", metrics));
        }),
        ...peer.transport.outgoingMetrics(report, new Set(outgoing.map(flow => flow.id)))
          .map(({ flowId, metrics }) => sample(flowId, "send", metrics)),
      ];
    }));
    return { samples: samples.flatMap(result => result.status === "fulfilled" ? result.value : []),
      unavailable: samples.some(result => result.status === "rejected") };
  }

  private recordAssignments(previous: ChannelPair | undefined, next?: ChannelPair): void {
    if (!browserDebugEnabled) return;
    for (const direction of ["incoming", "outgoing"] as const) {
      for (const flow of previous?.[direction] ?? []) {
        if (!next?.[direction].some(current => current.id === flow.id)) {
          debugEvent("channel", "flow-assignment-removed", { pairId: previous!.id, flowId: flow.id, direction });
        }
      }
      for (const flow of next?.[direction] ?? []) {
        const before = previous?.[direction].find(current => current.id === flow.id);
        const details = { pairId: next!.id, peerId: next!.peerId, flowId: flow.id, publicationId: flow.publicationId,
          inputFlowId: flow.inputFlowId, direction };
        if (!before) debugEvent("channel", "flow-assignment-added", details);
        if (flow.selected && !before?.selected) debugEvent("channel", "flow-assignment-selected", details);
      }
    }
  }

  private closePeer(peer: Peer): boolean {
    for (const input of peer.inputs.values()) input.release?.();
    peer.inputs.clear();
    return peer.transport.close();
  }

  reset(): void {
    for (const peer of this.peerRuntimes()) this.closePeer(peer);
    this.peers.clear();
    this.videoPool.dispose();
    this.videoPool = new BrowserEncodingPool();
    for (const id of [...this.local.keys()]) this.removeLocal(id);
    this.refresh();
  }
}
